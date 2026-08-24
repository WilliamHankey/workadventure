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

const messageBase = (): { messageId: string; sentAt: string } => ({
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
});

const toolsForAgent = (agent: AgentRecord): AgentToolName[] => {
    const tools: AgentToolName[] = [];
    if (agent.permissions.tools) {
        tools.push("wa_get_self_state", "wa_get_nearby_users", "wa_get_world_context", "wa_get_map_areas");
    }
    if (agent.permissions.movement) {
        tools.push("wa_move_to", "wa_move_to_area", "wa_approach_user", "wa_follow_user", "wa_stop_moving");
    }
    if (agent.permissions.speaking) {
        tools.push("wa_say", "wa_direct_message", "wa_set_status", "wa_emote", "wa_speak");
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
