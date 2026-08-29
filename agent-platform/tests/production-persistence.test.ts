import { createServer } from "node:http";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { AgentRecordSchema, MapRecordSchema } from "../src/domain/schemas";
import { createProductionDependencies } from "../src/infrastructure/production-dependencies";
import { runPostgresMigrations } from "../src/infrastructure/postgres-adapters";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl === undefined || redisUrl === undefined ? describe.skip : describe;

integration("production Postgres and Redis restart recovery", () => {
    const adminToken = "phase-nine-persistence-admin-token";
    let cleanupPool: Pool;
    const mapStorageRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const mapStorageServer = createServer((request, response) => {
        mapStorageRequests.push({ url: request.url ?? "", authorization: request.headers.authorization });
        request.resume();
        response.statusCode = 200;
        response.end();
    });
    let mapStorageUrl: string;

    beforeAll(async () => {
        cleanupPool = new Pool({ connectionString: databaseUrl });
        await runPostgresMigrations(cleanupPool);
        await cleanupPool.query(
            "TRUNCATE agent_platform_idempotency, agent_platform_audit_events, agent_platform_map_assets, agent_platform_map_contents, agent_platform_agents, agent_platform_maps RESTART IDENTITY CASCADE",
        );
        await new Promise<void>((resolve) => {
            mapStorageServer.listen(0, "127.0.0.1", resolve);
        });
        const address = mapStorageServer.address();
        if (address === null || typeof address === "string") throw new Error("Expected Map Storage test address");
        mapStorageUrl = `http://127.0.0.1:${String(address.port)}/`;
    });

    afterAll(async () => {
        await cleanupPool.end();
        await new Promise<void>((resolve, reject) => {
            mapStorageServer.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    });

    it("recovers durable definitions, runtime status, audit, and idempotent responses", async () => {
        if (databaseUrl === undefined || redisUrl === undefined) throw new Error("Integration URLs are required");
        const dependencyOptions = {
            databaseUrl,
            redisUrl,
            mapStorageUrl,
            mapStorageAuthorization: "Basic cGhhc2UtbmluZTp0ZXN0",
            mapStoragePollIntervalMs: 50,
        };
        const firstDependencies = await createProductionDependencies(dependencyOptions);
        const firstApp = await buildApp({ adminToken, dependencies: firstDependencies });
        const headers = { authorization: `Bearer ${adminToken}`, "idempotency-key": "persistent-map-create" };
        const mapResponse = await firstApp.inject({
            method: "POST",
            url: "/api/v1/maps",
            headers,
            payload: {
                name: "Persistent Agent World",
                slug: "persistent-agent-world",
                roomUrl: "https://play.example/_/global/maps.example/office.tmj",
                entryPoints: [{ name: "start", x: 32, y: 64 }],
                initialContent: {
                    format: "tmj",
                    document: { width: 2, height: 2, layers: [], tilesets: [] },
                },
            },
        });
        expect(mapResponse.statusCode).toBe(201);
        const map = MapRecordSchema.parse(mapResponse.json());

        const agentResponse = await firstApp.inject({
            method: "POST",
            url: "/api/v1/agents",
            headers: {
                authorization: `Bearer ${adminToken}`,
                "idempotency-key": "persistent-agent-create",
            },
            payload: {
                displayName: "Persistent Hermes Agent",
                hermesProfileId: "persistent-profile",
                modelId: "persistent-model",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                permissions: {},
                enabled: true,
            },
        });
        expect(agentResponse.statusCode).toBe(201);
        const agent = AgentRecordSchema.parse(agentResponse.json());
        await firstDependencies.service.setAgentRuntimeStatus(agent.id, "degraded", "pilot_restart");
        await expect.poll(() => mapStorageRequests.length, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
        expect(mapStorageRequests[0]).toMatchObject({
            url: "/persistent-agent-world/map.tmj",
            authorization: "Basic cGhhc2UtbmluZTp0ZXN0",
        });
        await firstApp.close();

        const recoveredDependencies = await createProductionDependencies(dependencyOptions);
        const recoveredApp = await buildApp({ adminToken, dependencies: recoveredDependencies });
        expect(await recoveredDependencies.service.listMaps()).toMatchObject([{ id: map.id, version: 1 }]);
        expect(await recoveredDependencies.service.listAgents()).toMatchObject([
            { id: agent.id, enabled: true, runtimeStatus: "degraded", runtimeErrorCode: "pilot_restart" },
        ]);

        const replay = await recoveredApp.inject({
            method: "POST",
            url: "/api/v1/maps",
            headers,
            payload: {
                name: "Persistent Agent World",
                slug: "persistent-agent-world",
                roomUrl: "https://play.example/_/global/maps.example/office.tmj",
                entryPoints: [{ name: "start", x: 32, y: 64 }],
                initialContent: {
                    format: "tmj",
                    document: { width: 2, height: 2, layers: [], tilesets: [] },
                },
            },
        });
        expect(replay.statusCode).toBe(201);
        expect(MapRecordSchema.parse(replay.json()).id).toBe(map.id);

        const audit = await cleanupPool.query<{ count: string }>("SELECT count(*) FROM agent_platform_audit_events");
        expect(Number(audit.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(2);
        await recoveredApp.close();
    });
});
