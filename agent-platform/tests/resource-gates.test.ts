import { describe, expect, it } from "vitest";

import { ConnectorHub } from "../src/connector/connector-hub";
import { CreateAgentSchema, CreateMapSchema } from "../src/domain/schemas";
import {
    MemoryAuditSink,
    MemoryDesiredStatePublisher,
    MemoryHermesProfileCatalog,
    MemoryRegistryRepository,
} from "../src/infrastructure/memory-adapters";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor";
import type { NavigationOutcome, WorkAdventureRoomClientOptions } from "../src/runtime/workadventure-room-client";
import { AdminService } from "../src/services/admin-service";

const navigation = (actionId: string): NavigationOutcome => ({
    actionId,
    status: "completed",
    target: { x: 0, y: 0 },
});

describe("runtime resource gates", () => {
    it("admits only the configured number of enabled lightweight agents", async () => {
        const catalog = new MemoryHermesProfileCatalog();
        const service = new AdminService(
            new MemoryRegistryRepository(),
            new MemoryAuditSink(),
            new MemoryDesiredStatePublisher(),
            catalog,
        );
        const map = await service.createMap(
            CreateMapSchema.parse({
                name: "Capacity World",
                slug: "capacity-world",
                roomUrl: "https://play.example/_/global/maps.example/capacity.tmj",
                entryPoints: [{ name: "start", x: 0, y: 0 }],
            }),
        );
        await Promise.all(
            ["one", "two"].map(async (suffix) =>
                service.createAgent(
                    CreateAgentSchema.parse({
                        displayName: `Agent ${suffix}`,
                        hermesProfileId: `profile-${suffix}`,
                        modelId: `model-${suffix}`,
                        mapId: map.id,
                        spawnPoint: "start",
                        ownerWorkAdventureUuid: "owner-1",
                        wokaTextureIds: ["body-1"],
                        voiceId: "voice-1",
                        permissions: {},
                        enabled: true,
                    }),
                ),
            ),
        );
        const started: string[] = [];
        const errors: Array<{ agentId: string; error: Error }> = [];
        const supervisor = new AgentRuntimeSupervisor(service, new ConnectorHub(service, catalog), {
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            identityProvider: { issueToken: (agentId) => Promise.resolve(`token-${agentId}`) },
            maxActiveAgents: 1,
            reconcileIntervalMs: 120_000,
            onError: (agentId, error) => errors.push({ agentId, error }),
            roomClientFactory: (options: WorkAdventureRoomClientOptions) => ({
                start: () => started.push(options.agentId),
                stop: () => undefined,
                say: () => undefined,
                setStatus: () => undefined,
                emote: () => undefined,
                respondToMeetingInvitation: () => undefined,
                leaveMeeting: () => Promise.resolve(),
                setVoiceIndicator: () => undefined,
                setCameraState: () => undefined,
                moveTo: (_x, _y, actionId) => Promise.resolve(navigation(actionId)),
                moveToArea: (_area, actionId) => Promise.resolve(navigation(actionId)),
                approachUser: (_user, _distance, actionId) => Promise.resolve(navigation(actionId)),
                followUser: (_user, _distance, actionId) => Promise.resolve(navigation(actionId)),
                stopMoving: (actionId) => navigation(actionId),
                getSelfState: () => ({}),
                getNearbyUsers: () => [],
                getMapAreas: () => [],
            }),
        });

        await supervisor.start();
        expect(started).toHaveLength(1);
        expect((await service.listAgents()).map((agent) => agent.runtimeStatus).sort()).toEqual(["degraded", "online"]);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.agentId.length).toBeGreaterThan(0);
        expect(errors[0]?.error).toBeInstanceOf(Error);
        await supervisor.stop();
    });
});
