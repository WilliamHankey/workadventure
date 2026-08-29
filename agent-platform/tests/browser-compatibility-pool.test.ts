import { describe, expect, it, vi } from "vitest";

import { CreateAgentSchema, type AgentRecord } from "../src/domain/schemas";
import {
    BrowserCompatibilityPool,
    type BrowserAgentDriver,
    type BrowserAgentSession,
} from "../src/runtime/browser-compatibility-pool";

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
    ...CreateAgentSchema.parse({
        displayName: "Browser Agent",
        hermesProfileId: "profile-1",
        modelId: "model-1",
        mapId: "map-1",
        spawnPoint: "start",
        ownerWorkAdventureUuid: "owner-1",
        wokaTextureIds: ["body-1"],
        voiceId: "voice-1",
        runtimeMode: "auto",
        permissions: { browser: true },
    }),
    id: "agent-browser",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runtimeStatus: "online",
    runtimeErrorCode: null,
    ...overrides,
});

describe("browser compatibility pool", () => {
    it("allowlists origins, recovers once, serializes actions, and shuts down when idle", async () => {
        vi.useFakeTimers();
        const starts: string[] = [];
        const closes: string[] = [];
        let firstAttempt = true;
        const executed: string[] = [];
        const driver: BrowserAgentDriver = {
            start: (definition) => {
                starts.push(definition.agentId);
                const session: BrowserAgentSession = {
                    execute: (action) => {
                        executed.push(action.name);
                        if (firstAttempt) {
                            firstAttempt = false;
                            return Promise.reject(new Error("browser crashed"));
                        }
                        return Promise.resolve({ action: action.name });
                    },
                    close: (reason) => {
                        closes.push(reason);
                        return Promise.resolve();
                    },
                };
                return Promise.resolve(session);
            },
        };
        const pool = new BrowserCompatibilityPool(driver, {
            maxSessions: 1,
            idleTimeoutMs: 1_000,
            allowedCoWebsiteOrigins: ["https://docs.example"],
        });

        await expect(
            pool.execute(agent(), "identity-token", "https://play.example/room", {
                name: "open_co_website",
                url: "https://evil.example/phish",
            }),
        ).rejects.toThrow(/not allowlisted/);
        await expect(
            pool.execute(agent(), "identity-token", "https://play.example/room", {
                name: "open_co_website",
                url: "https://docs.example/guide",
            }),
        ).resolves.toEqual({ action: "open_co_website" });
        expect(starts).toEqual(["agent-browser", "agent-browser"]);
        expect(closes).toEqual(["browser_action_failed"]);
        expect(executed).toEqual(["open_co_website", "open_co_website"]);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(pool.activeSessionCount()).toBe(0);
        expect(closes).toEqual(["browser_action_failed", "idle_timeout"]);
        await pool.stop();
        vi.useRealTimers();
    });

    it("requires explicit browser permission and enforces the global pool limit", async () => {
        let release: (() => void) | undefined;
        const driver: BrowserAgentDriver = {
            start: () =>
                Promise.resolve({
                    execute: () =>
                        new Promise((resolve) => {
                            release = () => resolve({ closed: true });
                        }),
                    close: () => Promise.resolve(),
                }),
        };
        const pool = new BrowserCompatibilityPool(driver, {
            maxSessions: 1,
            allowedCoWebsiteOrigins: [],
        });
        await expect(
            pool.execute(agent({ permissions: { ...agent().permissions, browser: false } }), "token", "https://play", {
                name: "close_co_website",
            }),
        ).rejects.toThrow(/does not permit/);

        const first = pool.execute(agent(), "token", "https://play", { name: "close_co_website" });
        await Promise.resolve();
        await expect(
            pool.execute(agent({ id: "agent-two" }), "token-two", "https://play", { name: "close_co_website" }),
        ).rejects.toThrow(/pool limit/);
        release?.();
        await first;
        await pool.stop();
    });

    it("serializes actions for the same agent", async () => {
        const started: string[] = [];
        const releases: Array<() => void> = [];
        const driver: BrowserAgentDriver = {
            start: () =>
                Promise.resolve({
                    execute: (action) => {
                        started.push(action.name);
                        return new Promise((resolve) => {
                            releases.push(() => resolve({ action: action.name }));
                        });
                    },
                    close: () => Promise.resolve(),
                }),
        };
        const pool = new BrowserCompatibilityPool(driver, {
            maxSessions: 1,
            allowedCoWebsiteOrigins: [],
        });

        const first = pool.execute(agent(), "token", "https://play", { name: "close_co_website" });
        await vi.waitFor(() => expect(started).toEqual(["close_co_website"]));
        const second = pool.execute(agent(), "token", "https://play", { name: "close_co_website" });
        await Promise.resolve();
        expect(started).toEqual(["close_co_website"]);

        releases.shift()?.();
        await first;
        await vi.waitFor(() => expect(started).toHaveLength(2));
        releases.shift()?.();
        await second;
        await pool.stop();
    });
});
