import { createHash, randomUUID } from "node:crypto";

import {
    ClientMessageSchema,
    ConnectorProtocolVersion,
    ServerMessageSchema,
    type AgentBinding,
    type AgentLane,
    type ClientMessage,
    type SafeProfile,
    type WorldEventDispatch,
} from "@workadventure/hermes-connector-protocol";
import { asError } from "catch-unknown";

import type {
    ConnectorTransport,
    HermesProfileDiscovery,
    HermesProfileGateway,
    HermesProfileGatewayFactory,
} from "./contracts";

interface ConnectorOptions {
    connectorId: string;
    instanceId?: string;
    maxQueuedEventsPerProfile?: number;
}

interface ActiveRun {
    abortController: AbortController;
    lane: AgentLane;
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

export class HermesConnector {
    private readonly instanceId: string;
    private readonly maxQueuedEventsPerProfile: number;
    private readonly bindings = new Map<string, AgentBinding>();
    private readonly gateways = new Map<string, HermesProfileGateway>();
    private readonly safeProfiles = new Map<string, SafeProfile>();
    private readonly activeRuns = new Map<string, ActiveRun>();
    private readonly queuedCounts = new Map<string, number>();
    private readonly profileQueues = new Map<string, Promise<void>>();
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
        await this.transport.connect();
    }

    async stop(): Promise<void> {
        if (this.heartbeat !== undefined) {
            clearInterval(this.heartbeat);
        }
        for (const active of this.activeRuns.values()) {
            active.abortController.abort(new Error("Connector stopped"));
        }
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
                await this.handleToolResult(message);
                break;
        }
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
            const result = await gateway.run(
                dispatch,
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
            await Promise.all(
                result.toolCalls.map(async (toolCall) =>
                    this.send({
                        ...messageBase(),
                        type: "tool.call",
                        lane: dispatch.lane,
                        eventId: dispatch.eventId,
                        hermesRunId: result.runId,
                        toolCallId: toolCall.toolCallId,
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                    })
                )
            );
            await this.send({
                ...messageBase(),
                type: "run.completed",
                lane: dispatch.lane,
                eventId: dispatch.eventId,
                hermesRunId: result.runId,
                output: result.output,
            });
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

    private async handleToolResult(
        message: Extract<ReturnType<typeof ServerMessageSchema.parse>, { type: "tool.result" }>
    ): Promise<void> {
        this.requireBinding(message.lane);
        const gateway = this.gateways.get(message.lane.profileId);
        if (gateway === undefined) {
            throw new Error(`Hermes profile '${message.lane.profileId}' is unavailable`);
        }
        await gateway.submitToolResult(message);
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
