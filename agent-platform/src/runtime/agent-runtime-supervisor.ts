import { createHash, randomUUID } from "node:crypto";

import type { ClientMessage } from "@workadventure/hermes-connector-protocol";
import { z } from "zod/v4";

import type { ConnectorHub } from "../connector/connector-hub";
import type { AgentRecord, MapRecord } from "../domain/schemas";
import type { AdminService } from "../services/admin-service";
import type { AgentIdentityProvider, AgentWorldEvent, RoomSocketFactory } from "./contracts";
import { NavigationGraphCache } from "./navigation-graph";
import {
    type AgentAvailabilityName,
    type NavigationOutcome,
    WorkAdventureRoomClient,
    type WorkAdventureRoomClientOptions,
} from "./workadventure-room-client";

type AgentToolCall = Extract<ClientMessage, { type: "tool.call" }>;

interface AgentRoomClient {
    start(): void;
    stop(): void;
    say(text: string): void;
    setStatus(status: AgentAvailabilityName): void;
    emote(emote: string): void;
    moveTo(x: number, y: number, actionId: string): Promise<NavigationOutcome>;
    moveToArea(areaName: string, actionId: string): Promise<NavigationOutcome>;
    approachUser(userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome>;
    followUser(userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome>;
    stopMoving(actionId: string): NavigationOutcome;
    getSelfState(): Record<string, unknown>;
    getNearbyUsers(): unknown[];
    getMapAreas(): unknown[];
}

type AgentRoomClientFactory = (options: WorkAdventureRoomClientOptions) => AgentRoomClient;

interface ActiveAgent {
    revision: string;
    agent: AgentRecord;
    map: MapRecord;
    client: AgentRoomClient;
    unregisterToolHandler: () => void;
}

export interface AgentRuntimeSupervisorOptions {
    pusherWebSocketUrl: URL;
    identityProvider: AgentIdentityProvider;
    reconcileIntervalMs?: number;
    socketFactory?: RoomSocketFactory;
    roomClientFactory?: AgentRoomClientFactory;
    navigationGraphCache?: NavigationGraphCache;
    onError?: (agentId: string, error: Error) => void;
}

const SayArgumentsSchema = z.object({ text: z.string().min(1).max(500) });
const EmoteArgumentsSchema = z.object({ emote: z.string().min(1).max(128) });
const StatusArgumentsSchema = z.object({
    status: z.enum(["online", "silent", "away", "busy", "do_not_disturb", "back_in_a_moment"]),
});
const MoveArgumentsSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const MoveToAreaArgumentsSchema = z.object({ areaName: z.string().min(1).max(255) });
const UserMovementArgumentsSchema = z.object({
    userUuid: z.string().min(1).max(255).optional(),
    distance: z.number().finite().min(16).max(512).default(64),
});
const StopArgumentsSchema = z.object({}).passthrough();

const stableId = (prefix: string, ...parts: string[]): string =>
    `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;

const normalizeError = (error: unknown): Error => (error instanceof Error ? error : new Error("Unknown runtime error"));

export class AgentRuntimeSupervisor {
    private readonly activeAgents = new Map<string, ActiveAgent>();
    private readonly roomClientFactory: AgentRoomClientFactory;
    private readonly navigationGraphCache: NavigationGraphCache;
    private reconcileTimer: ReturnType<typeof setInterval> | undefined;

    public constructor(
        private readonly service: AdminService,
        private readonly connectorHub: ConnectorHub,
        private readonly options: AgentRuntimeSupervisorOptions,
    ) {
        this.roomClientFactory =
            options.roomClientFactory ?? ((roomOptions) => new WorkAdventureRoomClient(roomOptions));
        this.navigationGraphCache = options.navigationGraphCache ?? new NavigationGraphCache();
    }

    async start(): Promise<void> {
        await this.reconcile();
        this.reconcileTimer = setInterval(() => {
            this.reconcile().catch((error: unknown) => this.reportError("runtime", normalizeError(error)));
        }, this.options.reconcileIntervalMs ?? 5_000);
    }

    stop(): void {
        if (this.reconcileTimer !== undefined) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = undefined;
        }
        for (const active of this.activeAgents.values()) {
            active.unregisterToolHandler();
            active.client.stop();
        }
        this.activeAgents.clear();
    }

    async reconcile(): Promise<void> {
        const [agents, maps] = await Promise.all([this.service.listAgents(), this.service.listMaps()]);
        const mapsById = new Map(maps.map((map) => [map.id, map]));
        const desiredIds = new Set(agents.filter((agent) => agent.enabled).map((agent) => agent.id));

        for (const [agentId, active] of this.activeAgents.entries()) {
            if (!desiredIds.has(agentId)) {
                active.unregisterToolHandler();
                active.client.stop();
                this.activeAgents.delete(agentId);
            }
        }

        await Promise.all(
            agents
                .filter((candidate) => candidate.enabled)
                .map(async (agent) => {
                    const map = mapsById.get(agent.mapId);
                    if (map === undefined) {
                        this.reportError(agent.id, new Error(`Map '${agent.mapId}' is unavailable`));
                        return;
                    }
                    const revision = `${String(agent.version)}:${String(map.version)}`;
                    if (this.activeAgents.get(agent.id)?.revision === revision) {
                        return;
                    }
                    await this.replaceAgent(agent, map, revision);
                }),
        );
    }

    private async replaceAgent(agent: AgentRecord, map: MapRecord, revision: string): Promise<void> {
        const existing = this.activeAgents.get(agent.id);
        if (existing !== undefined) {
            existing.unregisterToolHandler();
            existing.client.stop();
            this.activeAgents.delete(agent.id);
        }
        if (map.roomUrl === null) {
            this.reportError(agent.id, new Error(`Map '${map.id}' does not have a WorkAdventure roomUrl`));
            return;
        }
        const spawn = map.entryPoints.find((entryPoint) => entryPoint.name === agent.spawnPoint);
        if (spawn === undefined) {
            this.reportError(
                agent.id,
                new Error(`Spawn point '${agent.spawnPoint}' is not defined on map '${map.id}'`),
            );
            return;
        }

        try {
            const navigationGraph = await this.service
                .getMapContent(map.id)
                .then((content) => this.navigationGraphCache.get(map, content))
                .catch(() => undefined);
            const token = await this.options.identityProvider.issueToken(agent.id, agent.displayName);
            const client = this.roomClientFactory({
                agentId: agent.id,
                token,
                pusherWebSocketUrl: this.options.pusherWebSocketUrl,
                roomUrl: map.roomUrl,
                roomName: map.name,
                displayName: agent.displayName,
                textureIds: agent.wokaTextureIds,
                companionTextureId: agent.companionTextureId,
                spawn: { x: spawn.x, y: spawn.y },
                ownerWorkAdventureUuid: agent.ownerWorkAdventureUuid,
                navigationGraph,
                onEvent: (event) => this.handleWorldEvent(agent, event),
                socketFactory: this.options.socketFactory,
            });
            const unregisterToolHandler = this.connectorHub.registerToolCallHandler(agent.id, (message) =>
                this.handleToolCall(agent, map, client, message),
            );
            this.activeAgents.set(agent.id, { revision, agent, map, client, unregisterToolHandler });
            client.start();
        } catch (error: unknown) {
            this.reportError(agent.id, normalizeError(error));
        }
    }

    private async handleWorldEvent(agent: AgentRecord, event: AgentWorldEvent): Promise<void> {
        if (
            event.type === "navigation.completed" ||
            event.type === "navigation.failed" ||
            event.type === "navigation.cancelled"
        ) {
            await this.connectorHub.dispatchWorldEvent(
                agent.id,
                stableId("wa-session", agent.id, "navigation"),
                {
                    kind: event.type.replace(".", "_") as
                        | "navigation_completed"
                        | "navigation_failed"
                        | "navigation_cancelled",
                    occurredAt: new Date().toISOString(),
                    conversationId: stableId("wa-conversation", agent.id, "navigation"),
                    payload: {
                        actionId: event.actionId,
                        target: event.target,
                        ...(event.reason === undefined ? {} : { reason: event.reason }),
                    },
                },
                agent.behaviorInstructions,
            );
            return;
        }
        if (event.type !== "user.said" && event.type !== "user.joined" && event.type !== "user.left") {
            return;
        }
        const sessionId = stableId("wa-session", agent.id, event.user.userUuid);
        const conversationId = stableId("wa-conversation", agent.id, event.user.userUuid);
        const occurredAt = new Date().toISOString();
        if (event.type === "user.said") {
            await this.connectorHub.dispatchWorldEvent(
                agent.id,
                sessionId,
                {
                    kind: "nearby_message",
                    occurredAt,
                    conversationId,
                    payload: {
                        senderUserId: event.user.userId,
                        senderUuid: event.user.userUuid,
                        senderName: event.user.name,
                        owner: event.user.userUuid === agent.ownerWorkAdventureUuid,
                        text: event.text,
                    },
                },
                agent.behaviorInstructions,
            );
            return;
        }
        await this.connectorHub.dispatchWorldEvent(
            agent.id,
            sessionId,
            {
                kind: event.type === "user.joined" ? "proximity_joined" : "proximity_left",
                occurredAt,
                conversationId,
                payload: {
                    userId: event.user.userId,
                    userUuid: event.user.userUuid,
                    name: event.user.name,
                    owner: event.user.userUuid === agent.ownerWorkAdventureUuid,
                },
            },
            agent.behaviorInstructions,
        );
    }

    private async handleToolCall(
        agent: AgentRecord,
        map: MapRecord,
        client: AgentRoomClient,
        message: AgentToolCall,
    ): Promise<void> {
        let outcome: "succeeded" | "failed" | "rejected" | "cancelled" = "succeeded";
        let result: Record<string, unknown>;
        try {
            switch (message.name) {
                case "wa_say": {
                    const arguments_ = SayArgumentsSchema.parse(message.arguments);
                    client.say(arguments_.text);
                    result = { delivered: true };
                    break;
                }
                case "wa_set_status": {
                    const arguments_ = StatusArgumentsSchema.parse(message.arguments);
                    client.setStatus(arguments_.status);
                    result = { status: arguments_.status };
                    break;
                }
                case "wa_emote": {
                    const arguments_ = EmoteArgumentsSchema.parse(message.arguments);
                    client.emote(arguments_.emote);
                    result = { emote: arguments_.emote };
                    break;
                }
                case "wa_get_self_state": {
                    result = client.getSelfState();
                    break;
                }
                case "wa_get_nearby_users": {
                    result = { users: client.getNearbyUsers() };
                    break;
                }
                case "wa_get_world_context": {
                    result = {
                        mapId: map.id,
                        roomUrl: map.roomUrl,
                        roomName: map.name,
                        ownerWorkAdventureUuid: agent.ownerWorkAdventureUuid,
                    };
                    break;
                }
                case "wa_get_map_areas": {
                    result = { areas: client.getMapAreas(), entryPoints: map.entryPoints };
                    break;
                }
                case "wa_move_to": {
                    const arguments_ = MoveArgumentsSchema.parse(message.arguments);
                    const navigation = await client.moveTo(arguments_.x, arguments_.y, message.toolCallId);
                    ({ outcome, result } = this.navigationResult(navigation));
                    break;
                }
                case "wa_move_to_area": {
                    const arguments_ = MoveToAreaArgumentsSchema.parse(message.arguments);
                    const navigation = await client.moveToArea(arguments_.areaName, message.toolCallId);
                    ({ outcome, result } = this.navigationResult(navigation));
                    break;
                }
                case "wa_approach_user": {
                    const arguments_ = UserMovementArgumentsSchema.parse(message.arguments);
                    const navigation = await client.approachUser(
                        arguments_.userUuid ?? agent.ownerWorkAdventureUuid,
                        arguments_.distance,
                        message.toolCallId,
                    );
                    ({ outcome, result } = this.navigationResult(navigation));
                    break;
                }
                case "wa_follow_user": {
                    const arguments_ = UserMovementArgumentsSchema.parse(message.arguments);
                    const navigation = await client.followUser(
                        arguments_.userUuid ?? agent.ownerWorkAdventureUuid,
                        arguments_.distance,
                        message.toolCallId,
                    );
                    ({ outcome, result } = this.navigationResult(navigation));
                    break;
                }
                case "wa_stop_moving": {
                    StopArgumentsSchema.parse(message.arguments);
                    ({ outcome, result } = this.navigationResult(client.stopMoving(message.toolCallId)));
                    break;
                }
                default: {
                    outcome = "rejected";
                    result = { code: "tool_not_available", tool: message.name };
                }
            }
        } catch (error: unknown) {
            outcome = "failed";
            result = { code: "tool_execution_failed", message: normalizeError(error).message };
        }

        await this.connectorHub.sendToolResult({
            type: "tool.result",
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            lane: message.lane,
            eventId: message.eventId,
            hermesRunId: message.hermesRunId,
            toolCallId: message.toolCallId,
            outcome,
            result,
        });
    }

    private navigationResult(navigation: NavigationOutcome): {
        outcome: "succeeded" | "failed" | "cancelled";
        result: Record<string, unknown>;
    } {
        return {
            outcome:
                navigation.status === "completed"
                    ? "succeeded"
                    : navigation.status === "cancelled"
                      ? "cancelled"
                      : "failed",
            result: { navigation },
        };
    }

    private reportError(agentId: string, error: Error): void {
        this.options.onError?.(agentId, error);
    }
}
