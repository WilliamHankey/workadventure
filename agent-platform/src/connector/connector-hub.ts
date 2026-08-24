import { randomUUID } from "node:crypto";

import {
    AgentToolNameSchema,
    ClientMessageSchema,
    ServerMessageSchema,
    type AgentBinding,
    type AgentLane,
    type AgentToolName,
    type ClientMessage,
    type SafeProfile,
    type ServerMessage,
    type WorldEvent,
} from "@workadventure/hermes-connector-protocol";
import type WebSocket from "ws";

import type { AgentRecord } from "../domain/schemas";
import type { MemoryHermesProfileCatalog } from "../infrastructure/memory-adapters";
import type { AdminService } from "../services/admin-service";

interface ConnectionState {
    connectorId: string;
    connectionId: string;
    instanceId: string;
    socket: WebSocket;
    profileIds: Set<string>;
    bindings: Map<string, AgentBinding>;
}

type AgentToolCall = Extract<ClientMessage, { type: "tool.call" }>;
type ToolCallHandler = (message: AgentToolCall) => Promise<void>;
type MediaClientMessage = Extract<ClientMessage, { type: "media.ready" | "media.transcript" | "media.stopped" }>;
type MediaEventHandler = (message: MediaClientMessage) => Promise<void>;

interface ActiveMediaSession {
    lane: AgentLane;
    mediaSessionId: string;
    spaceName: string;
    allowedParticipantIdentity: string;
    allowedParticipantUuid: string;
    videoPublicationId?: string;
}

interface PendingSpeech {
    resolve: (message: Extract<ClientMessage, { type: "speech.result" }>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface PendingVideo {
    resolve: (message: Extract<ClientMessage, { type: "video.state" }>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

const messageBase = (): { messageId: string; sentAt: string } => ({
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
});

export const toolsForAgent = (agent: AgentRecord): AgentToolName[] => {
    const tools: AgentToolName[] = [];
    if (agent.permissions.tools) {
        tools.push("wa_get_self_state", "wa_get_nearby_users", "wa_get_world_context", "wa_get_map_areas");
    }
    if (agent.permissions.movement) {
        tools.push("wa_move_to", "wa_move_to_area", "wa_approach_user", "wa_follow_user", "wa_stop_moving");
    }
    if (agent.permissions.speaking) {
        tools.push("wa_say", "wa_set_status", "wa_emote", "wa_speak");
    }
    if (agent.permissions.listening || agent.permissions.speaking) {
        tools.push("wa_join_meeting", "wa_leave_meeting");
    }
    if (agent.permissions.video) {
        tools.push("wa_start_video", "wa_stop_video");
    }
    return AgentToolNameSchema.array().parse(tools);
};

const toCatalogEntry = (profile: SafeProfile) => ({
    id: profile.profileId,
    name: profile.displayName,
    description: null,
    advertisedModel: profile.advertisedModel,
    health: profile.health,
    readiness: profile.readiness,
    activeRuns: profile.activeRuns,
    lastSeenAt: profile.lastSeenAt,
});

const rawDataToText = (data: WebSocket.RawData): string =>
    Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data)).toString("utf8")
          : data.toString("utf8");

export class ConnectorHub {
    readonly receivedMessages: ClientMessage[] = [];
    private readonly connections = new Map<string, ConnectionState>();
    private readonly toolCallHandlers = new Map<string, ToolCallHandler>();
    private readonly mediaEventHandlers = new Map<string, MediaEventHandler>();
    private readonly mediaSessions = new Map<string, ActiveMediaSession>();
    private readonly pendingSpeech = new Map<string, PendingSpeech>();
    private readonly pendingVideo = new Map<string, PendingVideo>();

    constructor(
        private readonly service: AdminService,
        private readonly catalog: MemoryHermesProfileCatalog,
        private readonly heartbeatIntervalMs = 30_000,
    ) {}

    attach(socket: WebSocket): void {
        let connectorId: string | undefined;
        socket.on("message", (data) => {
            this.handleMessage(socket, rawDataToText(data))
                .then((registeredConnectorId) => {
                    connectorId = registeredConnectorId ?? connectorId;
                })
                .catch(() => socket.close(1008, "Invalid connector message"));
        });
        socket.on("close", () => {
            if (connectorId !== undefined) {
                const connection = this.connections.get(connectorId);
                if (connection?.socket === socket) {
                    this.connections.delete(connectorId);
                    this.catalog.remove(connectorId);
                }
            }
        });
    }

    registerToolCallHandler(agentId: string, handler: ToolCallHandler): () => void {
        if (this.toolCallHandlers.has(agentId)) {
            throw new Error(`A WorkAdventure runtime is already registered for agent '${agentId}'`);
        }
        this.toolCallHandlers.set(agentId, handler);
        return () => {
            if (this.toolCallHandlers.get(agentId) === handler) {
                this.toolCallHandlers.delete(agentId);
            }
        };
    }

    registerMediaEventHandler(agentId: string, handler: MediaEventHandler): () => void {
        if (this.mediaEventHandlers.has(agentId)) {
            throw new Error(`A media event handler is already registered for agent '${agentId}'`);
        }
        this.mediaEventHandlers.set(agentId, handler);
        return () => {
            if (this.mediaEventHandlers.get(agentId) === handler) {
                this.mediaEventHandlers.delete(agentId);
            }
            this.mediaSessions.delete(agentId);
        };
    }

    async sendMediaInvitation(
        agentId: string,
        sessionId: string,
        invitation: Omit<
            Extract<ServerMessage, { type: "media.invitation" }>,
            keyof AgentLane | "type" | "messageId" | "sentAt" | "lane"
        >,
    ): Promise<void> {
        const previous = this.mediaSessions.get(agentId);
        if (previous !== undefined) {
            const previousConnection = this.requireConnectionForLane(previous.lane);
            await this.send(previousConnection.socket, {
                ...messageBase(),
                type: "media.stop",
                lane: previous.lane,
                mediaSessionId: previous.mediaSessionId,
                reason: "media_invitation_replaced",
            });
            this.mediaSessions.delete(agentId);
        }
        const { connection, binding } = this.requireLocatedBinding(agentId);
        const lane: AgentLane = {
            agentId,
            profileId: binding.profileId,
            sessionId,
            sessionEpoch: binding.sessionEpoch,
        };
        this.mediaSessions.set(agentId, {
            lane,
            mediaSessionId: invitation.mediaSessionId,
            spaceName: invitation.spaceName,
            allowedParticipantIdentity: invitation.allowedParticipantIdentity,
            allowedParticipantUuid: invitation.allowedParticipantUuid,
        });
        await this.send(connection.socket, {
            ...messageBase(),
            type: "media.invitation",
            lane,
            ...invitation,
        });
    }

    async stopMedia(agentId: string, reason: string): Promise<void> {
        const active = this.mediaSessions.get(agentId);
        if (active === undefined) {
            return;
        }
        const connection = this.requireConnectionForLane(active.lane);
        this.mediaSessions.delete(agentId);
        await this.send(connection.socket, {
            ...messageBase(),
            type: "media.stop",
            lane: active.lane,
            mediaSessionId: active.mediaSessionId,
            reason,
        });
    }

    async publishSpeech(
        agentId: string,
        text: string,
        voiceId: string | null,
        timeoutMs = 30_000,
    ): Promise<Extract<ClientMessage, { type: "speech.result" }>> {
        const active = this.mediaSessions.get(agentId);
        if (active === undefined) {
            throw new Error("Agent does not have an active invitation-bound media session");
        }
        const connection = this.requireConnectionForLane(active.lane);
        const speechId = randomUUID();
        const result = new Promise<Extract<ClientMessage, { type: "speech.result" }>>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingSpeech.delete(speechId);
                reject(new Error("Timed out waiting for Hermes Desktop to publish speech"));
            }, timeoutMs);
            this.pendingSpeech.set(speechId, { resolve, reject, timeout });
        });
        try {
            await this.send(connection.socket, {
                ...messageBase(),
                type: "speech.publish",
                lane: active.lane,
                mediaSessionId: active.mediaSessionId,
                speechId,
                text,
                voiceId,
            });
            return await result;
        } catch (error: unknown) {
            const pending = this.pendingSpeech.get(speechId);
            if (pending !== undefined) {
                clearTimeout(pending.timeout);
                this.pendingSpeech.delete(speechId);
            }
            throw error;
        }
    }

    async publishVideo(
        agentId: string,
        representation: Extract<ServerMessage, { type: "video.publish" }>["representation"],
        timeoutMs = 30_000,
    ): Promise<Extract<ClientMessage, { type: "video.state" }>> {
        const active = this.mediaSessions.get(agentId);
        if (active === undefined) {
            throw new Error("Agent does not have an active invitation-bound media session");
        }
        const connection = this.requireConnectionForLane(active.lane);
        const publicationId = randomUUID();
        active.videoPublicationId = publicationId;
        const result = this.waitForVideo(publicationId, timeoutMs);
        try {
            await this.send(connection.socket, {
                ...messageBase(),
                type: "video.publish",
                lane: active.lane,
                mediaSessionId: active.mediaSessionId,
                publicationId,
                representation,
                limits: { width: 640, height: 360, fps: 15, bitrateKbps: 600 },
            });
            return await result;
        } catch (error: unknown) {
            this.rejectPendingVideo(publicationId, error);
            throw error;
        }
    }

    async stopVideo(agentId: string, reason: string, timeoutMs = 15_000): Promise<void> {
        const active = this.mediaSessions.get(agentId);
        if (active?.videoPublicationId === undefined) return;
        const connection = this.requireConnectionForLane(active.lane);
        const publicationId = active.videoPublicationId;
        const result = this.waitForVideo(publicationId, timeoutMs);
        try {
            await this.send(connection.socket, {
                ...messageBase(),
                type: "video.stop",
                lane: active.lane,
                mediaSessionId: active.mediaSessionId,
                publicationId,
                reason,
            });
            const state = await result;
            if (state.state !== "stopped") {
                throw new Error(state.reason ?? "Hermes Desktop did not stop the video publication");
            }
            active.videoPublicationId = undefined;
        } catch (error: unknown) {
            this.rejectPendingVideo(publicationId, error);
            throw error;
        }
    }

    async dispatchWorldEvent(
        agentId: string,
        sessionId: string,
        event: WorldEvent,
        instructions: string,
    ): Promise<string> {
        const located = [...this.connections.values()]
            .map((connection) => ({ connection, binding: connection.bindings.get(agentId) }))
            .find((entry) => entry.binding !== undefined);
        if (located?.binding === undefined) {
            throw new Error(`No Hermes Connector lane is available for agent '${agentId}'`);
        }
        const eventId = randomUUID();
        await this.send(located.connection.socket, {
            ...messageBase(),
            type: "world.event",
            eventId,
            lane: {
                agentId,
                profileId: located.binding.profileId,
                sessionId,
                sessionEpoch: located.binding.sessionEpoch,
            },
            event,
            instructions,
        });
        return eventId;
    }

    async sendToolResult(message: Extract<ServerMessage, { type: "tool.result" }>): Promise<void> {
        const connection = this.requireConnectionForLane(message.lane);
        await this.send(connection.socket, message);
    }

    async cancelRun(lane: AgentLane, eventId: string, reason: string): Promise<void> {
        const connection = this.requireConnectionForLane(lane);
        await this.send(connection.socket, {
            ...messageBase(),
            type: "run.cancel",
            lane,
            eventId,
            reason,
        });
    }

    private async handleMessage(socket: WebSocket, serialized: string): Promise<string | undefined> {
        const value: unknown = JSON.parse(serialized);
        const message = ClientMessageSchema.parse(value);
        this.receivedMessages.push(structuredClone(message));
        if (message.type === "connector.hello") {
            return this.acceptConnection(socket, message);
        }

        const connection = [...this.connections.values()].find((candidate) => candidate.socket === socket);
        if (connection === undefined) {
            throw new Error("connector.hello must be the first message");
        }
        if (message.type === "connector.heartbeat" || message.type === "profile.snapshot") {
            this.catalog.replace(connection.connectorId, message.profiles.map(toCatalogEntry));
            connection.profileIds = new Set(message.profiles.map((profile) => profile.profileId));
            await this.refreshBindings(connection);
            return connection.connectorId;
        }
        this.requireMessageLane(connection, message);
        if (message.type === "tool.call") {
            const handler = this.toolCallHandlers.get(message.lane.agentId);
            if (handler === undefined) {
                throw new Error(`No WorkAdventure runtime is registered for agent '${message.lane.agentId}'`);
            }
            await handler(message);
        }
        if (message.type === "media.ready" || message.type === "media.transcript" || message.type === "media.stopped") {
            const active = this.requireActiveMedia(message.lane.agentId, message.mediaSessionId, message.lane);
            if (
                message.type === "media.transcript" &&
                (message.sourceParticipantIdentity !== active.allowedParticipantIdentity ||
                    message.sourceParticipantUuid !== active.allowedParticipantUuid)
            ) {
                throw new Error("Media transcript source is outside the server-side invitation binding");
            }
            const handler = this.mediaEventHandlers.get(message.lane.agentId);
            if (handler === undefined) {
                throw new Error(`No media event handler is registered for agent '${message.lane.agentId}'`);
            }
            await handler(message);
            if (message.type === "media.stopped" && this.mediaSessions.get(message.lane.agentId) === active) {
                this.mediaSessions.delete(message.lane.agentId);
            }
        }
        if (message.type === "speech.result") {
            this.requireActiveMedia(message.lane.agentId, message.mediaSessionId, message.lane);
            const pending = this.pendingSpeech.get(message.speechId);
            if (pending === undefined) {
                throw new Error(`No pending speech matches '${message.speechId}'`);
            }
            clearTimeout(pending.timeout);
            this.pendingSpeech.delete(message.speechId);
            pending.resolve(message);
        }
        if (message.type === "video.state") {
            this.requireActiveMedia(message.lane.agentId, message.mediaSessionId, message.lane);
            const pending = this.pendingVideo.get(message.publicationId);
            if (pending === undefined || message.state === "starting") {
                return connection.connectorId;
            }
            clearTimeout(pending.timeout);
            this.pendingVideo.delete(message.publicationId);
            pending.resolve(message);
        }
        return connection.connectorId;
    }

    private async acceptConnection(
        socket: WebSocket,
        hello: Extract<ClientMessage, { type: "connector.hello" }>,
    ): Promise<string> {
        const existing = this.connections.get(hello.connectorId);
        if (existing !== undefined && existing.socket !== socket) {
            existing.socket.close(4001, "Superseded by a newer connector instance");
        }
        const profileIds = new Set(hello.profiles.map((profile) => profile.profileId));
        const bindings = await this.buildBindings(profileIds);
        const connection: ConnectionState = {
            connectorId: hello.connectorId,
            connectionId: randomUUID(),
            instanceId: hello.instanceId,
            socket,
            profileIds,
            bindings: new Map(bindings.map((binding) => [binding.agentId, binding])),
        };
        this.connections.set(hello.connectorId, connection);
        this.catalog.replace(hello.connectorId, hello.profiles.map(toCatalogEntry));
        await this.send(socket, {
            ...messageBase(),
            type: "connector.accepted",
            connectionId: connection.connectionId,
            heartbeatIntervalMs: this.heartbeatIntervalMs,
            bindings,
        });
        return hello.connectorId;
    }

    private async buildBindings(profileIds: Set<string>): Promise<AgentBinding[]> {
        const agents = await this.service.listAgents();
        return agents
            .filter((agent) => agent.enabled && profileIds.has(agent.hermesProfileId))
            .map((agent) => ({
                agentId: agent.id,
                profileId: agent.hermesProfileId,
                definitionVersion: agent.version,
                sessionEpoch: agent.version,
                allowedTools: toolsForAgent(agent),
            }));
    }

    private async refreshBindings(connection: ConnectionState): Promise<void> {
        const bindings = await this.buildBindings(connection.profileIds);
        connection.bindings.clear();
        for (const binding of bindings) {
            connection.bindings.set(binding.agentId, binding);
        }
        await this.send(connection.socket, {
            ...messageBase(),
            type: "connector.accepted",
            connectionId: connection.connectionId,
            heartbeatIntervalMs: this.heartbeatIntervalMs,
            bindings,
        });
    }

    private requireMessageLane(connection: ConnectionState, message: ClientMessage): void {
        if (!("lane" in message)) {
            throw new Error("Unexpected connector message");
        }
        const binding = connection.bindings.get(message.lane.agentId);
        if (
            binding === undefined ||
            binding.profileId !== message.lane.profileId ||
            binding.sessionEpoch !== message.lane.sessionEpoch
        ) {
            throw new Error("Connector message does not match the registered agent lane");
        }
        if (message.type === "tool.call" && !binding.allowedTools.includes(message.name)) {
            throw new Error("Connector requested an agent tool outside its immutable capability binding");
        }
    }

    private requireConnectionForLane(lane: AgentLane): ConnectionState {
        const connection = [...this.connections.values()].find((candidate) => {
            const binding = candidate.bindings.get(lane.agentId);
            return (
                binding !== undefined &&
                binding.profileId === lane.profileId &&
                binding.sessionEpoch === lane.sessionEpoch
            );
        });
        if (connection === undefined) {
            throw new Error("No active connector matches the requested agent lane");
        }
        return connection;
    }

    private requireLocatedBinding(agentId: string): { connection: ConnectionState; binding: AgentBinding } {
        for (const connection of this.connections.values()) {
            const binding = connection.bindings.get(agentId);
            if (binding !== undefined) {
                return { connection, binding };
            }
        }
        throw new Error(`No Hermes Connector lane is available for agent '${agentId}'`);
    }

    private requireActiveMedia(agentId: string, mediaSessionId: string, lane: AgentLane): ActiveMediaSession {
        const active = this.mediaSessions.get(agentId);
        if (
            active === undefined ||
            active.mediaSessionId !== mediaSessionId ||
            active.lane.profileId !== lane.profileId ||
            active.lane.sessionId !== lane.sessionId ||
            active.lane.sessionEpoch !== lane.sessionEpoch
        ) {
            throw new Error("Media message does not match the active invitation-bound agent lane");
        }
        return active;
    }

    private waitForVideo(
        publicationId: string,
        timeoutMs: number,
    ): Promise<Extract<ClientMessage, { type: "video.state" }>> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingVideo.delete(publicationId);
                reject(new Error("Timed out waiting for Hermes Desktop video state"));
            }, timeoutMs);
            this.pendingVideo.set(publicationId, { resolve, reject, timeout });
        });
    }

    private rejectPendingVideo(publicationId: string, error: unknown): void {
        const pending = this.pendingVideo.get(publicationId);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pendingVideo.delete(publicationId);
        pending.reject(error instanceof Error ? error : new Error("Video publication failed"));
    }

    private async send(socket: WebSocket, message: ServerMessage): Promise<void> {
        const serialized = JSON.stringify(ServerMessageSchema.parse(message));
        await new Promise<void>((resolve, reject) => {
            socket.send(serialized, (error) => {
                if (error === undefined || error === null) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }
}
