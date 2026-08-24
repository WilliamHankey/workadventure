import { createHash, randomUUID } from "node:crypto";

import {
    ClientMessageSchema,
    ConnectorProtocolVersion,
    ServerMessageSchema,
    type AgentBinding,
    type AgentLane,
    type AgentToolName,
    type ClientMessage,
    type SafeProfile,
    type ServerMessage,
    type WorldEventDispatch,
} from "@workadventure/hermes-connector-protocol";
import { asError } from "catch-unknown";

import type {
    ConnectorTransport,
    HermesMediaAdapter,
    HermesMediaSession,
    HermesProfileDiscovery,
    HermesProfileGateway,
    HermesProfileGatewayFactory,
    HermesRunResult,
} from "./contracts";

interface ConnectorOptions {
    connectorId: string;
    instanceId?: string;
    maxQueuedEventsPerProfile?: number;
    mediaAdapter?: HermesMediaAdapter;
}

interface ActiveRun {
    abortController: AbortController;
    lane: AgentLane;
}

type ToolResultMessage = Extract<ServerMessage, { type: "tool.result" }>;

interface PendingToolResult {
    lane: AgentLane;
    eventId: string;
    hermesRunId: string;
    resolve: (message: ToolResultMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    signal: AbortSignal;
    abortHandler: () => void;
}

const messageBase = (): { messageId: string; sentAt: string } => ({
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
});

export const stableHermesSessionKey = (lane: AgentLane, conversationId: string): string => {
    const scopeHash = createHash("sha256")
        .update(`${lane.profileId}:${lane.agentId}:${conversationId}`)
        .digest("hex")
        .slice(0, 24);
    return `wa:${lane.agentId.slice(0, 64)}:${conversationId.slice(0, 64)}:${scopeHash}`;
};

const bindingMatchesLane = (binding: AgentBinding, lane: AgentLane): boolean =>
    binding.agentId === lane.agentId &&
    binding.profileId === lane.profileId &&
    binding.sessionEpoch === lane.sessionEpoch;

const observationTools = new Set<AgentToolName>([
    "wa_get_self_state",
    "wa_get_nearby_users",
    "wa_get_world_context",
    "wa_get_map_areas",
]);

const toolContracts: Record<AgentToolName, string> = {
    wa_get_self_state: "{}",
    wa_get_nearby_users: "{}",
    wa_get_world_context: "{}",
    wa_get_map_areas: "{}",
    wa_move_to: '{"x":number,"y":number}',
    wa_move_to_area: '{"areaName":string}',
    wa_approach_user: '{"userUuid"?:string,"distance"?:16..512}',
    wa_follow_user: '{"userUuid"?:string,"distance"?:16..512}',
    wa_stop_moving: "{}",
    wa_say: '{"text":string}',
    wa_direct_message: '{"text":string,"userUuid":string}',
    wa_set_status: '{"status":"online"|"silent"|"away"|"busy"|"do_not_disturb"|"back_in_a_moment"}',
    wa_emote: '{"emote":string}',
    wa_join_meeting: '{"requestSenderUserUuid":string,"accept"?:boolean}',
    wa_leave_meeting: "{}",
    wa_speak: '{"text":string}',
    wa_start_video: "{}",
    wa_stop_video: "{}",
};

const decisionInstructions = (behavior: string, allowedTools: AgentToolName[], observationRound: number): string =>
    [
        behavior,
        "You control this WorkAdventure avatar. Do not use Hermes browser, terminal, messaging, or other local tools for world actions.",
        'Return exactly one JSON object with no Markdown: {"version":1,"message":string|null,"actions":[{"name":string,"arguments":object}]}.',
        "Use only the allowed WorkAdventure actions below. If no action is needed, return an empty actions array.",
        "Observation actions may not be mixed with mutation actions. Request at most four observations in one round; their results will be supplied in a follow-up run.",
        `Observation round: ${String(observationRound)} of 2.`,
        ...allowedTools.map((tool) => `${tool} ${toolContracts[tool]}`),
    ].join("\n");

export class HermesConnector {
    private readonly instanceId: string;
    private readonly maxQueuedEventsPerProfile: number;
    private readonly bindings = new Map<string, AgentBinding>();
    private readonly gateways = new Map<string, HermesProfileGateway>();
    private readonly safeProfiles = new Map<string, SafeProfile>();
    private readonly activeRuns = new Map<string, ActiveRun>();
    private readonly queuedCounts = new Map<string, number>();
    private readonly profileQueues = new Map<string, Promise<void>>();
    private readonly mediaSessions = new Map<string, HermesMediaSession>();
    private readonly pendingToolResults = new Map<string, PendingToolResult>();
    private heartbeat: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly discovery: HermesProfileDiscovery,
        private readonly gatewayFactory: HermesProfileGatewayFactory,
        private readonly transport: ConnectorTransport,
        private readonly options: ConnectorOptions
    ) {
        this.instanceId = options.instanceId ?? randomUUID();
        this.maxQueuedEventsPerProfile = options.maxQueuedEventsPerProfile ?? 32;
    }

    async start(): Promise<void> {
        await this.refreshProfiles();
        this.transport.onOpen(async () => this.sendHello());
        this.transport.onMessage(async (value) => this.handleMessage(value));
        // Do not let a transient connection failure (e.g. a 429 from the
        // platform rate limiter during cold start) crash the connector. The
        // transport's own reconnect logic handles retries; a rejected initial
        // connect promise would otherwise terminate the process.
        this.transport.connect().catch(() => undefined);
    }

    async stop(): Promise<void> {
        if (this.heartbeat !== undefined) {
            clearInterval(this.heartbeat);
        }
        for (const active of this.activeRuns.values()) {
            active.abortController.abort(new Error("Connector stopped"));
        }
        for (const pending of this.pendingToolResults.values()) {
            clearTimeout(pending.timeout);
            pending.signal.removeEventListener("abort", pending.abortHandler);
            pending.reject(new Error("Connector stopped"));
        }
        this.pendingToolResults.clear();
        await Promise.all([...this.mediaSessions.values()].map(async (session) => session.stop("connector_stopped")));
        this.mediaSessions.clear();
        await this.transport.close();
    }

    async refreshProfiles(): Promise<void> {
        const profiles = await this.discovery.discover();
        const discoveredIds = new Set(profiles.map((profile) => profile.profileId));
        for (const profileId of this.gateways.keys()) {
            if (!discoveredIds.has(profileId)) {
                this.gateways.delete(profileId);
                this.safeProfiles.delete(profileId);
            }
        }

        const probes = await Promise.all(
            profiles.map(async (profile) => {
                const gateway = this.gatewayFactory.create(profile);
                this.gateways.set(profile.profileId, gateway);
                try {
                    return await gateway.probe();
                } catch {
                    return {
                        profileId: profile.profileId,
                        displayName: profile.displayName,
                        advertisedModel: profile.profileId,
                        capabilities: [],
                        health: "offline" as const,
                        readiness: false,
                        activeRuns: 0,
                        lastSeenAt: new Date().toISOString(),
                    };
                }
            })
        );
        this.safeProfiles.clear();
        for (const profile of probes) {
            this.safeProfiles.set(profile.profileId, profile);
        }
    }

    private async sendHello(): Promise<void> {
        await this.transport.send(
            ClientMessageSchema.parse({
                ...messageBase(),
                type: "connector.hello",
                protocolVersion: ConnectorProtocolVersion,
                connectorId: this.options.connectorId,
                instanceId: this.instanceId,
                profiles: [...this.safeProfiles.values()],
            })
        );
    }

    private async handleMessage(value: unknown): Promise<void> {
        const message = ServerMessageSchema.parse(value);
        switch (message.type) {
            case "connector.accepted":
                this.bindings.clear();
                for (const binding of message.bindings) {
                    this.bindings.set(binding.agentId, binding);
                }
                this.startHeartbeat(message.heartbeatIntervalMs);
                break;
            case "world.event":
                await this.enqueue(message);
                break;
            case "run.cancel": {
                const active = this.activeRuns.get(message.eventId);
                if (active !== undefined && bindingMatchesLane(this.requireBinding(message.lane), active.lane)) {
                    active.abortController.abort(new Error(message.reason));
                }
                break;
            }
            case "tool.result":
                this.handleToolResult(message);
                break;
            case "media.invitation":
                await this.handleMediaInvitation(message);
                break;
            case "media.stop":
                await this.stopMediaSession(message.lane, message.mediaSessionId, message.reason);
                break;
            case "speech.publish":
                await this.publishSpeech(message);
                break;
            case "video.publish":
                await this.publishVideo(message);
                break;
            case "video.stop":
                await this.stopVideo(message);
                break;
        }
    }

    private async handleMediaInvitation(
        message: Extract<ReturnType<typeof ServerMessageSchema.parse>, { type: "media.invitation" }>
    ): Promise<void> {
        this.requireBinding(message.lane);
        const adapter = this.options.mediaAdapter;
        if (adapter === undefined) {
            await this.send({
                ...messageBase(),
                type: "media.stopped",
                lane: message.lane,
                mediaSessionId: message.mediaSessionId,
                reason: "media_adapter_unavailable",
            });
            return;
        }
        const existing = this.mediaSessions.get(message.mediaSessionId);
        if (existing !== undefined) {
            await existing.stop("session_replaced");
            this.mediaSessions.delete(message.mediaSessionId);
        }
        const session = await adapter.start(message, {
            ready: async () =>
                this.send({
                    ...messageBase(),
                    type: "media.ready",
                    lane: message.lane,
                    mediaSessionId: message.mediaSessionId,
                    spaceName: message.spaceName,
                }),
            transcript: async (transcript) => {
                const current = this.mediaSessions.get(message.mediaSessionId);
                if (current === undefined || !bindingMatchesLane(this.requireBinding(message.lane), current.lane)) {
                    throw new Error("Media transcript does not match the active immutable lane");
                }
                if (
                    transcript.sourceParticipantIdentity !== message.allowedParticipantIdentity ||
                    transcript.sourceParticipantUuid !== message.allowedParticipantUuid
                ) {
                    throw new Error("Media transcript source is outside the invitation participant binding");
                }
                await this.send({
                    ...messageBase(),
                    type: "media.transcript",
                    lane: message.lane,
                    mediaSessionId: message.mediaSessionId,
                    ...transcript,
                });
            },
            stopped: async (reason) => {
                this.mediaSessions.delete(message.mediaSessionId);
                await this.send({
                    ...messageBase(),
                    type: "media.stopped",
                    lane: message.lane,
                    mediaSessionId: message.mediaSessionId,
                    reason,
                });
            },
        });
        if (!bindingMatchesLane(this.requireBinding(message.lane), session.lane)) {
            await session.stop("adapter_lane_mismatch");
            throw new Error("Media adapter returned a session for another immutable lane");
        }
        this.mediaSessions.set(message.mediaSessionId, session);
    }

    private async stopMediaSession(lane: AgentLane, mediaSessionId: string, reason: string): Promise<void> {
        this.requireBinding(lane);
        const session = this.mediaSessions.get(mediaSessionId);
        if (session === undefined) {
            return;
        }
        if (!bindingMatchesLane(this.requireBinding(lane), session.lane)) {
            throw new Error("Cannot stop a media session from another immutable lane");
        }
        this.mediaSessions.delete(mediaSessionId);
        await session.stop(reason);
    }

    private async publishSpeech(
        message: Extract<ReturnType<typeof ServerMessageSchema.parse>, { type: "speech.publish" }>
    ): Promise<void> {
        this.requireBinding(message.lane);
        const session = this.mediaSessions.get(message.mediaSessionId);
        let outcome: "published" | "interrupted" | "failed" = "failed";
        let reason: string | null = "media_session_unavailable";
        try {
            if (session !== undefined && bindingMatchesLane(this.requireBinding(message.lane), session.lane)) {
                outcome = await session.speak(message.speechId, message.text, message.voiceId);
                reason = null;
            }
        } catch (error: unknown) {
            reason = asError(error).message.slice(0, 255);
        }
        await this.send({
            ...messageBase(),
            type: "speech.result",
            lane: message.lane,
            mediaSessionId: message.mediaSessionId,
            speechId: message.speechId,
            outcome,
            reason,
        });
    }

    private async publishVideo(
        message: Extract<ReturnType<typeof ServerMessageSchema.parse>, { type: "video.publish" }>
    ): Promise<void> {
        this.requireBinding(message.lane);
        const session = this.mediaSessions.get(message.mediaSessionId);
        let state: "publishing" | "failed" = "failed";
        let reason: string | null = "media_session_or_video_adapter_unavailable";
        try {
            if (
                session !== undefined &&
                bindingMatchesLane(this.requireBinding(message.lane), session.lane) &&
                session.startVideo !== undefined
            ) {
                state = await session.startVideo(message);
                reason = state === "publishing" ? null : "video_publication_failed";
            }
        } catch (error: unknown) {
            reason = asError(error).message.slice(0, 255);
        }
        await this.send({
            ...messageBase(),
            type: "video.state",
            lane: message.lane,
            mediaSessionId: message.mediaSessionId,
            publicationId: message.publicationId,
            state,
            reason,
        });
    }

    private async stopVideo(
        message: Extract<ReturnType<typeof ServerMessageSchema.parse>, { type: "video.stop" }>
    ): Promise<void> {
        this.requireBinding(message.lane);
        const session = this.mediaSessions.get(message.mediaSessionId);
        let state: "stopped" | "failed" = "stopped";
        let reason: string | null = null;
        try {
            if (session !== undefined && bindingMatchesLane(this.requireBinding(message.lane), session.lane)) {
                await session.stopVideo?.(message.publicationId, message.reason);
            }
        } catch (error: unknown) {
            state = "failed";
            reason = asError(error).message.slice(0, 255);
        }
        await this.send({
            ...messageBase(),
            type: "video.state",
            lane: message.lane,
            mediaSessionId: message.mediaSessionId,
            publicationId: message.publicationId,
            state,
            reason,
        });
    }

    private async enqueue(dispatch: WorldEventDispatch): Promise<void> {
        const queued = this.queuedCounts.get(dispatch.lane.profileId) ?? 0;
        if (queued >= this.maxQueuedEventsPerProfile) {
            await this.sendFailure(dispatch, null, "profile_queue_full");
            return;
        }
        this.queuedCounts.set(dispatch.lane.profileId, queued + 1);
        const previous = this.profileQueues.get(dispatch.lane.profileId) ?? Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => this.processWorldEvent(dispatch))
            .finally(() => {
                const count = this.queuedCounts.get(dispatch.lane.profileId) ?? 1;
                this.queuedCounts.set(dispatch.lane.profileId, Math.max(0, count - 1));
            });
        this.profileQueues.set(dispatch.lane.profileId, current);
        await current;
    }

    private async processWorldEvent(dispatch: WorldEventDispatch): Promise<void> {
        let hermesRunId: string | null = null;
        const binding = this.bindings.get(dispatch.lane.agentId);
        if (binding === undefined || !bindingMatchesLane(binding, dispatch.lane)) {
            await this.sendFailure(dispatch, null, "lane_binding_rejected");
            return;
        }
        try {
            const gateway = this.gateways.get(dispatch.lane.profileId);
            if (gateway === undefined) {
                await this.sendFailure(dispatch, null, "profile_gateway_unavailable");
                return;
            }
            const abortController = new AbortController();
            this.activeRuns.set(dispatch.eventId, { abortController, lane: dispatch.lane });
            let currentDispatch = dispatch;
            /* eslint-disable no-await-in-loop -- observation rounds are deliberately serialized */
            for (let observationRound = 0; observationRound <= 2; observationRound += 1) {
                const result = await gateway.run(
                    {
                        ...currentDispatch,
                        instructions: decisionInstructions(
                            currentDispatch.instructions,
                            binding.allowedTools,
                            observationRound
                        ),
                    },
                    stableHermesSessionKey(dispatch.lane, dispatch.event.conversationId),
                    abortController.signal,
                    async (runId) => {
                        hermesRunId = runId;
                        await this.send({
                            ...messageBase(),
                            type: "run.started",
                            lane: dispatch.lane,
                            eventId: dispatch.eventId,
                            hermesRunId: runId,
                        });
                    }
                );
                hermesRunId = result.runId;
                if (result.toolCalls.some((toolCall) => !binding.allowedTools.includes(toolCall.name))) {
                    await this.sendFailure(dispatch, result.runId, "tool_not_permitted");
                    return;
                }
                const observations = result.toolCalls.filter((toolCall) => observationTools.has(toolCall.name));
                if (observations.length > 0 && observations.length !== result.toolCalls.length) {
                    await this.sendFailure(dispatch, result.runId, "mixed_observation_and_action_batch");
                    return;
                }
                const toolResults = await this.executeToolCalls(
                    dispatch,
                    result.runId,
                    result.toolCalls,
                    abortController.signal
                );
                if (observations.length === 0) {
                    await this.send({
                        ...messageBase(),
                        type: "run.completed",
                        lane: dispatch.lane,
                        eventId: dispatch.eventId,
                        hermesRunId: result.runId,
                        output: result.output,
                    });
                    return;
                }
                if (observationRound === 2) {
                    await this.sendFailure(dispatch, result.runId, "observation_round_limit");
                    return;
                }
                currentDispatch = {
                    ...dispatch,
                    event: {
                        ...dispatch.event,
                        payload: {
                            ...dispatch.event.payload,
                            workAdventureObservations: toolResults.map((message) => ({
                                name: result.toolCalls.find((call) => call.toolCallId === message.toolCallId)?.name,
                                outcome: message.outcome,
                                result: message.result,
                            })),
                        },
                    },
                };
            }
            /* eslint-enable no-await-in-loop */
        } catch (error: unknown) {
            const normalized = asError(error);
            const cancelled = this.activeRuns.get(dispatch.eventId)?.abortController.signal.aborted === true;
            await this.sendFailure(
                dispatch,
                hermesRunId,
                cancelled || normalized.name === "AbortError" ? "run_cancelled" : "run_failed"
            );
        } finally {
            this.activeRuns.delete(dispatch.eventId);
        }
    }

    private handleToolResult(message: ToolResultMessage): void {
        this.requireBinding(message.lane);
        const pending = this.pendingToolResults.get(message.toolCallId);
        if (
            pending === undefined ||
            pending.eventId !== message.eventId ||
            pending.hermesRunId !== message.hermesRunId ||
            !bindingMatchesLane(this.requireBinding(message.lane), pending.lane)
        ) {
            return;
        }
        clearTimeout(pending.timeout);
        pending.signal.removeEventListener("abort", pending.abortHandler);
        this.pendingToolResults.delete(message.toolCallId);
        pending.resolve(message);
    }

    private async executeToolCalls(
        dispatch: WorldEventDispatch,
        hermesRunId: string,
        toolCalls: HermesRunResult["toolCalls"],
        signal: AbortSignal
    ): Promise<ToolResultMessage[]> {
        const results: ToolResultMessage[] = [];
        /* eslint-disable no-await-in-loop -- avatar actions must preserve model order */
        for (const toolCall of toolCalls) {
            if (signal.aborted)
                throw signal.reason instanceof Error ? signal.reason : new Error("Hermes run cancelled");
            const result = new Promise<ToolResultMessage>((resolve, reject) => {
                const abortHandler = (): void => {
                    const pending = this.pendingToolResults.get(toolCall.toolCallId);
                    if (pending === undefined) return;
                    clearTimeout(pending.timeout);
                    this.pendingToolResults.delete(toolCall.toolCallId);
                    reject(signal.reason instanceof Error ? signal.reason : new Error("Hermes run cancelled"));
                };
                const timeout = setTimeout(() => {
                    signal.removeEventListener("abort", abortHandler);
                    this.pendingToolResults.delete(toolCall.toolCallId);
                    reject(new Error(`WorkAdventure action '${toolCall.name}' timed out`));
                }, 45_000);
                signal.addEventListener("abort", abortHandler, { once: true });
                this.pendingToolResults.set(toolCall.toolCallId, {
                    lane: dispatch.lane,
                    eventId: dispatch.eventId,
                    hermesRunId,
                    resolve,
                    reject,
                    timeout,
                    signal,
                    abortHandler,
                });
            });
            try {
                await this.send({
                    ...messageBase(),
                    type: "tool.call",
                    lane: dispatch.lane,
                    eventId: dispatch.eventId,
                    hermesRunId,
                    toolCallId: toolCall.toolCallId,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                });
            } catch (error: unknown) {
                const pending = this.pendingToolResults.get(toolCall.toolCallId);
                if (pending !== undefined) {
                    clearTimeout(pending.timeout);
                    pending.signal.removeEventListener("abort", pending.abortHandler);
                    this.pendingToolResults.delete(toolCall.toolCallId);
                    pending.reject(asError(error));
                }
            }
            results.push(await result);
        }
        /* eslint-enable no-await-in-loop */
        return results;
    }

    private requireBinding(lane: AgentLane): AgentBinding {
        const binding = this.bindings.get(lane.agentId);
        if (binding === undefined || !bindingMatchesLane(binding, lane)) {
            throw new Error("The message lane does not match an active agent/profile/session binding");
        }
        return binding;
    }

    private async sendFailure(
        dispatch: WorldEventDispatch,
        hermesRunId: string | null,
        errorCode: string
    ): Promise<void> {
        await this.send({
            ...messageBase(),
            type: "run.failed",
            lane: dispatch.lane,
            eventId: dispatch.eventId,
            hermesRunId,
            errorCode,
        });
    }

    private async send(message: ClientMessage): Promise<void> {
        await this.transport.send(ClientMessageSchema.parse(message));
    }

    private startHeartbeat(intervalMs: number): void {
        if (this.heartbeat !== undefined) {
            clearInterval(this.heartbeat);
        }
        this.heartbeat = setInterval(() => {
            this.refreshProfiles()
                .then(async () =>
                    this.transport.send(
                        ClientMessageSchema.parse({
                            ...messageBase(),
                            type: "connector.heartbeat",
                            instanceId: this.instanceId,
                            profiles: [...this.safeProfiles.values()],
                        })
                    )
                )
                .catch(() => undefined);
        }, intervalMs);
    }
}
