import {
    ClientMessageSchema,
    ServerMessageSchema,
    type ClientMessage,
    type ServerMessage,
} from "@workadventure/hermes-connector-protocol";
import { AvailabilityStatus, PositionMessage_Direction } from "@workadventure/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { buildApp, type AppDependencies } from "../src/app";
import { ConnectorHub } from "../src/connector/connector-hub";
import { CreateAgentSchema, CreateMapSchema } from "../src/domain/schemas";
import {
    MemoryAuditSink,
    MemoryDesiredStatePublisher,
    MemoryHermesProfileCatalog,
    MemoryRegistryRepository,
} from "../src/infrastructure/memory-adapters";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor";
import type { AgentWorldEvent } from "../src/runtime/contracts";
import type { AgentAvailabilityName, WorkAdventureRoomClientOptions } from "../src/runtime/workadventure-room-client";
import { AdminService } from "../src/services/admin-service";
import { MemoryIdempotencyStore } from "../src/services/idempotency-store";

const adminToken = "runtime-supervisor-admin-token";
const connectorToken = "runtime-supervisor-connector-token";

const decode = (data: RawData): unknown => {
    const serialized = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data)).toString("utf8")
          : data.toString("utf8");
    return JSON.parse(serialized);
};

const receive = async (socket: WebSocket): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
        socket.once("message", (data) => {
            try {
                resolve(ServerMessageSchema.parse(decode(data)));
            } catch (error: unknown) {
                reject(error instanceof Error ? error : new Error("Invalid server message"));
            }
        });
        socket.once("error", reject);
    });

const open = async (socket: WebSocket): Promise<void> =>
    new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });

class FakeAgentRoomClient {
    readonly said: string[] = [];
    readonly statuses: AgentAvailabilityName[] = [];
    readonly emotes: string[] = [];
    started = false;

    public constructor(readonly options: WorkAdventureRoomClientOptions) {}

    start(): void {
        this.started = true;
    }

    stop(): void {
        this.started = false;
    }

    say(text: string): void {
        this.said.push(text);
    }

    setStatus(status: AgentAvailabilityName): void {
        this.statuses.push(status);
    }

    emote(emote: string): void {
        this.emotes.push(emote);
    }

    getSelfState(): Record<string, unknown> {
        return { connected: this.started, agentId: this.options.agentId };
    }

    getNearbyUsers(): unknown[] {
        return [];
    }

    emit(event: AgentWorldEvent): Promise<void> {
        return this.options.onEvent(event);
    }
}

describe("Hermes agent runtime supervisor", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    let socket: WebSocket;
    let supervisor: AgentRuntimeSupervisor;

    beforeEach(async () => {
        const catalog = new MemoryHermesProfileCatalog();
        const service = new AdminService(
            new MemoryRegistryRepository(),
            new MemoryAuditSink(),
            new MemoryDesiredStatePublisher(),
            catalog,
        );
        const hub = new ConnectorHub(service, catalog, 120_000);
        const map = await service.createMap(
            CreateMapSchema.parse({
                name: "Agent World",
                slug: "agent-world",
                roomUrl: "https://play.example/_/global/maps.example/office.tmj",
                entryPoints: [{ name: "start", x: 32, y: 64 }],
            }),
        );
        const firstAgent = await service.createAgent(
            CreateAgentSchema.parse({
                displayName: "Agent One",
                hermesProfileId: "profile-one",
                modelId: "model-one",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
                enabled: true,
            }),
        );
        const secondAgent = await service.createAgent(
            CreateAgentSchema.parse({
                displayName: "Agent Two",
                hermesProfileId: "profile-two",
                modelId: "model-two",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-2"],
                voiceId: "voice-2",
                permissions: {},
                enabled: true,
            }),
        );
        const rooms = new Map<string, FakeAgentRoomClient>();
        supervisor = new AgentRuntimeSupervisor(service, hub, {
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            identityProvider: { issueToken: (agentId) => Promise.resolve(`token-${agentId}`) },
            reconcileIntervalMs: 120_000,
            roomClientFactory: (options) => {
                const room = new FakeAgentRoomClient(options);
                rooms.set(options.agentId, room);
                return room;
            },
        });
        await supervisor.start();

        const dependencies: AppDependencies = {
            service,
            idempotency: new MemoryIdempotencyStore(),
            connectorHub: hub,
        };
        app = await buildApp({ adminToken, connectorToken, dependencies });
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected a TCP test address");
        }
        socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/connector/v1/ws`, {
            headers: { authorization: `Bearer ${connectorToken}` },
        });
        await open(socket);

        const acceptedPromise = receive(socket);
        const hello: ClientMessage = {
            type: "connector.hello",
            protocolVersion: 1,
            messageId: "hello-runtime",
            sentAt: new Date().toISOString(),
            connectorId: "desktop-runtime",
            instanceId: "desktop-runtime-instance",
            profiles: [
                {
                    profileId: "profile-one",
                    displayName: "Profile One",
                    advertisedModel: "model-one",
                    capabilities: [],
                    health: "healthy",
                    readiness: true,
                    activeRuns: 0,
                    lastSeenAt: new Date().toISOString(),
                },
                {
                    profileId: "profile-two",
                    displayName: "Profile Two",
                    advertisedModel: "model-two",
                    capabilities: [],
                    health: "healthy",
                    readiness: true,
                    activeRuns: 0,
                    lastSeenAt: new Date().toISOString(),
                },
            ],
        };
        socket.send(JSON.stringify(ClientMessageSchema.parse(hello)));
        const accepted = await acceptedPromise;
        if (accepted.type !== "connector.accepted") {
            throw new Error("Expected connector.accepted");
        }
        expect(
            accepted.bindings.some(
                (binding) => binding.agentId === firstAgent.id && binding.profileId === "profile-one",
            ),
        ).toBe(true);
        expect(
            accepted.bindings.some(
                (binding) => binding.agentId === secondAgent.id && binding.profileId === "profile-two",
            ),
        ).toBe(true);

        const firstRoom = rooms.get(firstAgent.id);
        const secondRoom = rooms.get(secondAgent.id);
        if (firstRoom === undefined || secondRoom === undefined) {
            throw new Error("Expected both agent rooms");
        }

        const worldEventPromise = receive(socket);
        await firstRoom.emit({
            type: "user.said",
            user: {
                userId: 77,
                userUuid: "human-77",
                name: "Human",
                x: 10,
                y: 20,
                direction: PositionMessage_Direction.DOWN,
                moving: false,
                availabilityStatus: AvailabilityStatus.ONLINE,
            },
            text: "Hello Agent One",
        });
        const worldEvent = await worldEventPromise;
        if (worldEvent.type !== "world.event") {
            throw new Error("Expected world.event");
        }
        expect(worldEvent.lane).toMatchObject({ agentId: firstAgent.id, profileId: "profile-one" });
        expect(worldEvent.event.payload).toMatchObject({ text: "Hello Agent One", senderUuid: "human-77" });

        const resultPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "tool-message-runtime",
                    sentAt: new Date().toISOString(),
                    eventId: worldEvent.eventId,
                    lane: worldEvent.lane,
                    hermesRunId: "run-runtime",
                    toolCallId: "tool-runtime",
                    name: "wa_say",
                    arguments: { text: "Reply from Hermes" },
                }),
            ),
        );
        const result = await resultPromise;
        expect(result).toMatchObject({
            type: "tool.result",
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            outcome: "succeeded",
        });
        expect(firstRoom.said).toEqual(["Reply from Hermes"]);
        expect(secondRoom.said).toEqual([]);
    });

    afterEach(async () => {
        supervisor.stop();
        if (socket.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
                socket.once("close", () => resolve());
                socket.close();
            });
        }
        await app.close();
    });

    it("keeps inbound world events and outbound Hermes actions on one immutable agent lane", () => {
        expect(socket.readyState).toBe(WebSocket.OPEN);
    });
});
