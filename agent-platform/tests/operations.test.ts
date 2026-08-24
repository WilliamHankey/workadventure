import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, createDefaultDependencies } from "../src/app";
import { FixedWindowRateLimiter, PlatformMetrics } from "../src/infrastructure/operational-guardrails";
import { ResilientDesiredStatePublisher } from "../src/infrastructure/redis-desired-state-publisher";

const token = "phase-nine-administration-token";
const authorization = { authorization: `Bearer ${token}` };

describe("production operational guardrails", () => {
    const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

    afterEach(async () => {
        await Promise.all(apps.splice(0).map(async (app) => app.close()));
    });

    it("rate limits administration requests and exports safe Prometheus metrics", async () => {
        const app = await buildApp({
            adminToken: token,
            dependencies: createDefaultDependencies(),
            rateLimit: { adminRequests: 2, connectorRequests: 1, windowMs: 60_000 },
        });
        apps.push(app);

        expect((await app.inject({ method: "GET", url: "/api/v1/maps", headers: authorization })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/api/v1/maps", headers: authorization })).statusCode).toBe(200);
        const limited = await app.inject({ method: "GET", url: "/api/v1/maps", headers: authorization });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBeDefined();
        expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });

        const metrics = await app.inject({ method: "GET", url: "/metrics" });
        expect(metrics.statusCode).toBe(200);
        expect(metrics.body).toContain("workadventure_agent_platform_http_requests_total");
        expect(metrics.body).toContain('workadventure_agent_platform_rate_limited_total{scope="admin"} 1');
        expect(metrics.body).not.toContain(token);
    });

    it("reports dependency failure through readiness without failing liveness", async () => {
        const dependencies = createDefaultDependencies();
        dependencies.healthCheck = () => Promise.reject(new Error("postgres offline"));
        const app = await buildApp({ adminToken: token, dependencies });
        apps.push(app);

        expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
    });

    it("uses bounded fixed windows deterministically", () => {
        const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, adminRequests: 1, connectorRequests: 2 });
        expect(limiter.check("admin", "client", 1_000).allowed).toBe(true);
        expect(limiter.check("admin", "client", 1_100).allowed).toBe(false);
        expect(limiter.check("admin", "client", 2_000).allowed).toBe(true);
        expect(new PlatformMetrics().render(0)).toContain("process_resident_memory_bytes");
    });

    it("degrades safely when the Redis desired-state signal fails", async () => {
        const onError = vi.fn();
        const publisher = new ResilientDesiredStatePublisher(
            { publish: () => Promise.reject(new Error("redis unavailable")) },
            onError,
        );
        await expect(
            publisher.publish({
                type: "agent.definition.changed",
                agentId: "agent-1",
                definitionVersion: 1,
                occurredAt: new Date().toISOString(),
            }),
        ).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledOnce();
    });

    it("checks in durable schema and production-safe storage defaults", async () => {
        const [migration, server] = await Promise.all([
            readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"),
            readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
        ]);
        expect(migration).toContain("agent_platform_maps");
        expect(migration).toContain("agent_platform_agents");
        expect(migration).toContain("agent_platform_idempotency");
        expect(migration).toContain("agent_platform_map_storage_outbox");
        expect(migration).toContain("hermes_profile_id text NOT NULL UNIQUE");
        expect(server).toContain('AGENT_PLATFORM_STORAGE ?? "postgres"');
        expect(server).toContain("In-memory storage is not permitted in production");
    });
});
