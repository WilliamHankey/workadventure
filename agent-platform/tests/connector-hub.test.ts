import {
    ClientMessageSchema,
    ServerMessageSchema,
    type ClientMessage,
    type ServerMessage,
} from "@workadventure/hermes-connector-protocol";
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
import { AdminService } from "../src/services/admin-service";
import { MemoryIdempotencyStore } from "../src/services/idempotency-store";

const adminToken = "connector-hub-admin-token";
const connectorToken = "connector-registration-token";

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

describe("Hermes Connector control-plane hub", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    let socket: WebSocket;
    let hub: ConnectorHub;
    let service: AdminService;
    let agentId: string;

    beforeEach(async () => {
        const catalog = new MemoryHermesProfileCatalog();
        service = new AdminService(
            new MemoryRegistryRepository(),
            new MemoryAuditSink(),
            new MemoryDesiredStatePublisher(),
            catalog,
        );
        hub = new ConnectorHub(service, catalog, 120_000);
        const dependencies: AppDependencies = {
            service,
            idempotency: new MemoryIdempotencyStore(),
            connectorHub: hub,
        };
        const map = await service.createMap(
            CreateMapSchema.parse({ name: "Connector World", slug: "connector-world" }),
        );
        const agent = await service.createAgent(
            CreateAgentSchema.parse({
                displayName: "Research Agent",
                hermesProfileId: "researcher",
                modelId: "hermes-model",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
                enabled: true,
            }),
        );
        agentId = agent.id;
        hub.registerToolCallHandler(agentId, () => Promise.resolve());

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
    });

    afterEach(async () => {
        if (socket.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
                socket.once("close", () => resolve());
                socket.close();
            });
        }
        await app.close();
    });

    it("syncs safe profile metadata and preserves the agent lane in both directions", async () => {
        const acceptedPromise = receive(socket);
        const hello: ClientMessage = {
            type: "connector.hello",
            messageId: "hello-1",
            sentAt: new Date().toISOString(),
            protocolVersion: 1,
            connectorId: "desktop-1",
            instanceId: "desktop-instance-1",
            profiles: [
                {
                    profileId: "researcher",
                    displayName: "Researcher",
                    advertisedModel: "hermes-model",
                    capabilities: ["run_submission", "session_key_header"],
                    health: "healthy",
                    readiness: true,
                    activeRuns: 0,
                    lastSeenAt: new Date().toISOString(),
                },
            ],
        };
        socket.send(JSON.stringify(ClientMessageSchema.parse(hello)));
        const accepted = await acceptedPromise;
        expect(accepted).toMatchObject({
            type: "connector.accepted",
            bindings: [{ agentId, profileId: "researcher", sessionEpoch: 1 }],
        });
        if (accepted.type !== "connector.accepted") {
            throw new Error("Expected connector.accepted");
        }

        const catalogResponse = await app.inject({
            method: "GET",
            url: "/api/v1/catalog/hermes-profiles",
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(catalogResponse.statusCode).toBe(200);
        expect(catalogResponse.json()).toMatchObject([
            { id: "researcher", advertisedModel: "hermes-model", readiness: true, activeRuns: 0 },
        ]);
        expect(catalogResponse.body).not.toContain("connector-registration-token");
        expect(socket.readyState).toBe(WebSocket.OPEN);

        const worldEventPromise = receive(socket);
        const eventId = await hub.dispatchWorldEvent(
            agentId,
            "session-1",
            {
                kind: "direct_message",
                occurredAt: new Date().toISOString(),
                conversationId: "dm-owner-1",
                payload: { text: "Hello" },
            },
            "Respond through permitted WorkAdventure tools when useful.",
        );
        const worldEvent = await worldEventPromise;
        expect(worldEvent).toMatchObject({
            type: "world.event",
            eventId,
            lane: { agentId, profileId: "researcher", sessionId: "session-1", sessionEpoch: 1 },
        });
        if (worldEvent.type !== "world.event") {
            throw new Error("Expected world.event");
        }

        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "tool-message-1",
                    sentAt: new Date().toISOString(),
                    eventId,
                    lane: worldEvent.lane,
                    hermesRunId: "run-1",
                    toolCallId: "tool-1",
                    name: "wa_say",
                    arguments: { text: "Hello from Hermes" },
                }),
            ),
        );
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });

        expect(hub.receivedMessages.at(-1)).toMatchObject({
            type: "tool.call",
            eventId,
            lane: worldEvent.lane,
            name: "wa_say",
        });
    });
});
