import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { buildApp, type AppDependencies } from "../src/app";
import { ErrorResponseSchema, MapRecordSchema } from "../src/domain/schemas";
import {
    MemoryAuditSink,
    MemoryDesiredStatePublisher,
    MemoryRegistryRepository,
    StaticHermesProfileCatalog,
} from "../src/infrastructure/memory-adapters";
import { RedisDesiredStatePublisher } from "../src/infrastructure/redis-desired-state-publisher";
import { AdminService } from "../src/services/admin-service";
import { MemoryIdempotencyStore } from "../src/services/idempotency-store";

const token = "phase-one-test-token";
const authHeaders = { authorization: `Bearer ${token}` };

describe("Lowcoder administration API", () => {
    const audit = new MemoryAuditSink();
    const desiredState = new MemoryDesiredStatePublisher();
    const dependencies: AppDependencies = {
        service: new AdminService(
            new MemoryRegistryRepository(),
            audit,
            desiredState,
            new StaticHermesProfileCatalog([
                {
                    id: "researcher",
                    name: "Researcher",
                    description: "Local Hermes research profile",
                    advertisedModel: "hermes-model",
                    health: "healthy",
                    readiness: true,
                    activeRuns: 0,
                    lastSeenAt: new Date().toISOString(),
                },
            ]),
        ),
        idempotency: new MemoryIdempotencyStore(),
    };
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        app = await buildApp({ adminToken: token, dependencies });
    });

    afterEach(async () => {
        await app.close();
    });

    it("requires the Lowcoder bearer token", async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1/maps" });

        expect(response.statusCode).toBe(401);
        expect(ErrorResponseSchema.parse(response.json()).error.code).toBe("unauthorized");
    });

    it("creates and updates a versioned map idempotently", async () => {
        const createRequest = {
            method: "POST" as const,
            url: "/api/v1/maps",
            headers: { ...authHeaders, "idempotency-key": "create-map-0001" },
            payload: { name: "Agent World", slug: "agent-world" },
        };
        const first = await app.inject(createRequest);
        const replay = await app.inject(createRequest);
        const created = MapRecordSchema.parse(first.json());

        expect(first.statusCode).toBe(201);
        expect(MapRecordSchema.parse(replay.json()).id).toBe(created.id);

        const updatedResponse = await app.inject({
            method: "PATCH",
            url: `/api/v1/maps/${created.id}`,
            headers: { ...authHeaders, "idempotency-key": "update-map-0001", "if-match": "1" },
            payload: { state: "published" },
        });
        const updated = MapRecordSchema.parse(updatedResponse.json());
        expect(updated.state).toBe("published");
        expect(updated.version).toBe(2);

        const reusedKey = await app.inject({
            ...createRequest,
            payload: { name: "Different", slug: "different" },
        });
        expect(reusedKey.statusCode).toBe(409);
        expect(ErrorResponseSchema.parse(reusedKey.json()).error.code).toBe("idempotency_key_reused");
    });

    it("binds an agent to Hermes and guards a referenced map", async () => {
        const mapResponse = await app.inject({
            method: "POST",
            url: "/api/v1/maps",
            headers: { ...authHeaders, "idempotency-key": "create-map-0002" },
            payload: { name: "Hermes World", slug: "hermes-world", entryPoints: [{ name: "start", x: 1, y: 1 }] },
        });
        const map = MapRecordSchema.parse(mapResponse.json());

        const agentResponse = await app.inject({
            method: "POST",
            url: "/api/v1/agents",
            headers: { ...authHeaders, "idempotency-key": "create-agent-0001" },
            payload: {
                displayName: "Research Agent",
                hermesProfileId: "researcher",
                modelId: "hermes-model",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
            },
        });
        expect(agentResponse.statusCode).toBe(201);
        expect(agentResponse.json()).toMatchObject({ controlMode: "hermes", runtimeStatus: "offline" });
        expect(desiredState.events.at(-1)).toMatchObject({ type: "agent.definition.changed" });

        const deleteMap = await app.inject({
            method: "DELETE",
            url: `/api/v1/maps/${map.id}`,
            headers: { ...authHeaders, "idempotency-key": "delete-map-0002", "if-match": "1" },
        });
        expect(deleteMap.statusCode).toBe(409);
        expect(ErrorResponseSchema.parse(deleteMap.json()).error.code).toBe("map_in_use");
        expect(audit.events.some((event) => event.action === "agent.create")).toBe(true);
    });

    it("completes the agent and map CRUD lifecycle", async () => {
        const mapResponse = await app.inject({
            method: "POST",
            url: "/api/v1/maps",
            headers: { ...authHeaders, "idempotency-key": "create-map-0004" },
            payload: { name: "Lifecycle World", slug: "lifecycle-world" },
        });
        const map = MapRecordSchema.parse(mapResponse.json());
        const readMap = await app.inject({ method: "GET", url: `/api/v1/maps/${map.id}`, headers: authHeaders });
        expect(readMap.statusCode).toBe(200);

        const agentResponse = await app.inject({
            method: "POST",
            url: "/api/v1/agents",
            headers: { ...authHeaders, "idempotency-key": "create-agent-0002" },
            payload: {
                displayName: "Lifecycle Agent",
                hermesProfileId: "lifecycle-profile",
                modelId: "hermes-model",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
            },
        });
        const agentId = z.object({ id: z.string(), version: z.number() }).parse(agentResponse.json()).id;
        const readAgent = await app.inject({
            method: "GET",
            url: `/api/v1/agents/${agentId}`,
            headers: authHeaders,
        });
        expect(readAgent.statusCode).toBe(200);

        const updateAgent = await app.inject({
            method: "PATCH",
            url: `/api/v1/agents/${agentId}`,
            headers: { ...authHeaders, "idempotency-key": "update-agent-0002", "if-match": "1" },
            payload: { enabled: true },
        });
        expect(updateAgent.statusCode).toBe(200);
        expect(updateAgent.json()).toMatchObject({ enabled: true, version: 2, controlMode: "hermes" });

        const deleteAgent = await app.inject({
            method: "DELETE",
            url: `/api/v1/agents/${agentId}`,
            headers: { ...authHeaders, "idempotency-key": "delete-agent-0002", "if-match": "2" },
        });
        expect(deleteAgent.statusCode).toBe(204);

        const deleteMap = await app.inject({
            method: "DELETE",
            url: `/api/v1/maps/${map.id}`,
            headers: { ...authHeaders, "idempotency-key": "delete-map-0004", "if-match": "1" },
        });
        expect(deleteMap.statusCode).toBe(204);
        expect(desiredState.events.slice(-2).map((event) => event.type)).toEqual([
            "agent.definition.changed",
            "agent.definition.deleted",
        ]);
    });

    it("rejects Lowcoder control mode and exposes no operational command routes", async () => {
        const mapResponse = await app.inject({
            method: "POST",
            url: "/api/v1/maps",
            headers: { ...authHeaders, "idempotency-key": "create-map-0003" },
            payload: { name: "Boundary World", slug: "boundary-world" },
        });
        const map = MapRecordSchema.parse(mapResponse.json());
        const invalidAgent = await app.inject({
            method: "POST",
            url: "/api/v1/agents",
            headers: { ...authHeaders, "idempotency-key": "invalid-agent-0001" },
            payload: {
                displayName: "Invalid Agent",
                hermesProfileId: "invalid",
                modelId: "model",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
                controlMode: "lowcoder",
            },
        });
        expect(invalidAgent.statusCode).toBe(400);

        const prohibitedPaths = [
            "/api/v1/agents/example/move",
            "/api/v1/agents/example/chat",
            "/api/v1/agents/example/speak",
            "/api/v1/agents/example/video",
            "/api/v1/agents/example/model-runs",
            "/api/v1/commands",
        ];
        const prohibitedResponses = await Promise.all(
            prohibitedPaths.map(async (path) => ({
                path,
                response: await app.inject({ method: "POST", url: path, headers: authHeaders }),
            })),
        );
        for (const { path, response } of prohibitedResponses) {
            expect(response.statusCode, path).toBe(404);
        }

        const openApiPaths = Object.keys(app.swagger().paths ?? {});
        expect(openApiPaths.some((path) => /move|chat|speak|video|model-runs|commands/.test(path))).toBe(false);
    });

    it("serves a read-only Hermes profile catalog", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/catalog/hermes-profiles",
            headers: authHeaders,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject([{ id: "researcher", readiness: true }]);
    });

    it("publishes only typed desired-state definitions through the Redis adapter", async () => {
        const messages: Array<{ channel: string; message: string }> = [];
        const publisher = new RedisDesiredStatePublisher({
            publish(channel, message) {
                messages.push({ channel, message });
                return Promise.resolve(1);
            },
        });

        await publisher.publish({
            type: "agent.definition.changed",
            agentId: "agent-1",
            definitionVersion: 4,
            occurredAt: new Date().toISOString(),
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ channel: "agent-platform:desired-state" });
        expect(messages[0]?.message).toContain('"type":"agent.definition.changed"');
    });
});
