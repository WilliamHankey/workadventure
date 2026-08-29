import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { toolsForAgent } from "../src/connector/connector-hub";
import { CreateAgentSchema, type AgentRecord } from "../src/domain/schemas";

const fullyPermittedAgent = (): AgentRecord => ({
    ...CreateAgentSchema.parse({
        displayName: "Capability Agent",
        hermesProfileId: "profile-1",
        modelId: "model-1",
        mapId: "map-1",
        spawnPoint: "start",
        ownerWorkAdventureUuid: "owner-1",
        wokaTextureIds: ["body-1"],
        voiceId: "voice-1",
        videoMode: "animated_woka",
        permissions: {
            movement: true,
            listening: true,
            speaking: true,
            video: true,
            tools: true,
            browser: true,
            moderation: true,
        },
    }),
    id: "agent-capabilities",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runtimeStatus: "online",
    runtimeErrorCode: null,
});

describe("Hermes advertised capability contract", () => {
    it("advertises only tools with concrete runtime switch cases", async () => {
        const advertised = toolsForAgent(fullyPermittedAgent());
        const supervisor = await readFile(
            new URL("../src/runtime/agent-runtime-supervisor.ts", import.meta.url),
            "utf8",
        );

        for (const tool of advertised) {
            expect(supervisor, `${tool} is advertised without a runtime implementation`).toContain(`case "${tool}"`);
        }
        expect(advertised).not.toContain("wa_direct_message");
        expect(advertised).toContain("wa_start_video");
    });
});
