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
import { CreateAgentSchema, CreateMapSchema, type AgentRecord } from "../src/domain/schemas";
import {
    MemoryAuditSink,
    MemoryDesiredStatePublisher,
    MemoryHermesProfileCatalog,
    MemoryRegistryRepository,
} from "../src/infrastructure/memory-adapters";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor";
import type { AgentWorldEvent } from "../src/runtime/contracts";
import type {
    AgentAvailabilityName,
    NavigationOutcome,
    WorkAdventureRoomClientOptions,
} from "../src/runtime/workadventure-room-client";
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
        const onError = (error: Error): void => reject(error);
        socket.once("message", (data) => {
            socket.off("error", onError);
            try {
                resolve(ServerMessageSchema.parse(decode(data)));
            } catch (error: unknown) {
                reject(error instanceof Error ? error : new Error("Invalid server message"));
            }
        });
        socket.once("error", onError);
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
    readonly moves: Array<{ x: number; y: number; actionId: string }> = [];
    readonly voiceIndicators: boolean[] = [];
    readonly cameraStates: boolean[] = [];
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

    respondToMeetingInvitation(_senderUserUuid: string, _accept: boolean): void {}

    leaveMeeting(_reason?: string): Promise<void> {
        return Promise.resolve();
    }

    setVoiceIndicator(enabled: boolean): void {
        this.voiceIndicators.push(enabled);
    }

    setCameraState(enabled: boolean): void {
        this.cameraStates.push(enabled);
    }

    moveTo(x: number, y: number, actionId: string): Promise<NavigationOutcome> {
        this.moves.push({ x, y, actionId });
        return Promise.resolve({ actionId, status: "completed", target: { x, y } });
    }

    moveToArea(_areaName: string, actionId: string): Promise<NavigationOutcome> {
        return Promise.resolve({ actionId, status: "completed", target: { x: 32, y: 64 } });
    }

    approachUser(_userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome> {
        return Promise.resolve({ actionId, status: "completed", target: { x: distance, y: distance } });
    }

    followUser(_userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome> {
        return Promise.resolve({ actionId, status: "completed", target: { x: distance, y: distance } });
    }

    stopMoving(actionId: string): NavigationOutcome {
        return { actionId, status: "completed", target: { x: 0, y: 0 } };
    }

    getSelfState(): Record<string, unknown> {
        return { connected: this.started, agentId: this.options.agentId };
    }

    getNearbyUsers(): unknown[] {
        return [];
    }

    getMapAreas(): unknown[] {
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
    let firstAgent: AgentRecord;
    let secondAgent: AgentRecord;
    let rooms: Map<string, FakeAgentRoomClient>;
    let service: AdminService;

    beforeEach(async () => {
        const catalog = new MemoryHermesProfileCatalog();
        service = new AdminService(
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
        firstAgent = await service.createAgent(
            CreateAgentSchema.parse({
                displayName: "Agent One",
                hermesProfileId: "profile-one",
                modelId: "model-one",
                mapId: map.id,
                spawnPoint: "start",
                ownerWorkAdventureUuid: "owner-1",
                wokaTextureIds: ["body-1"],
                voiceId: "voice-1",
                videoMode: "animated_woka",
                permissions: { video: true },
                enabled: true,
            }),
        );
        secondAgent = await service.createAgent(
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
        rooms = new Map<string, FakeAgentRoomClient>();
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

        const movementResultPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "movement-message-runtime",
                    sentAt: new Date().toISOString(),
                    eventId: worldEvent.eventId,
                    lane: worldEvent.lane,
                    hermesRunId: "run-runtime",
                    toolCallId: "move-runtime",
                    name: "wa_move_to",
                    arguments: { x: 320, y: 224 },
                }),
            ),
        );
        await expect(movementResultPromise).resolves.toMatchObject({
            type: "tool.result",
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            outcome: "succeeded",
            result: { navigation: { actionId: "move-runtime", status: "completed" } },
        });
        expect(firstRoom.moves).toEqual([{ x: 320, y: 224, actionId: "move-runtime" }]);
        expect(secondRoom.moves).toEqual([]);
    });

    afterEach(async () => {
        await supervisor.stop();
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

    it("persists online and degraded runtime status for Lowcoder diagnostics", async () => {
        expect(await service.getAgent(firstAgent.id)).toMatchObject({
            runtimeStatus: "online",
            runtimeErrorCode: null,
        });
        const room = rooms.get(firstAgent.id);
        if (room === undefined) throw new Error("Expected first agent room");
        await room.emit({ type: "connection.degraded", reason: "test disconnect" });
        expect(await service.getAgent(firstAgent.id)).toMatchObject({
            runtimeStatus: "degraded",
            runtimeErrorCode: "workadventure_connection_degraded",
        });
    });

    it("routes invitation-bound transcripts through Hermes and publishes speech only on that agent lane", async () => {
        const firstRoom = rooms.get(firstAgent.id);
        const secondRoom = rooms.get(secondAgent.id);
        if (firstRoom === undefined || secondRoom === undefined || firstRoom.options.onMediaInvitation === undefined) {
            throw new Error("Expected both media-capable agent rooms");
        }
        const invitationPromise = receive(socket);
        await firstRoom.options.onMediaInvitation({
            mediaSessionId: "media-e2e-1",
            spaceName: "meeting-space",
            serverUrl: "wss://livekit.example",
            token: "livekit-token",
            allowedParticipantIdentity: "human-space-77",
            allowedParticipantUuid: "human-77",
        });
        const invitation = await invitationPromise;
        if (invitation.type !== "media.invitation") throw new Error("Expected media.invitation");
        expect(invitation.lane).toMatchObject({ agentId: firstAgent.id, profileId: "profile-one" });

        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "media.ready",
                    messageId: "media-ready-e2e",
                    sentAt: new Date().toISOString(),
                    lane: invitation.lane,
                    mediaSessionId: invitation.mediaSessionId,
                    spaceName: invitation.spaceName,
                }),
            ),
        );
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(firstRoom.voiceIndicators).toEqual([true]);
        expect(secondRoom.voiceIndicators).toEqual([]);

        const transcriptEventPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "media.transcript",
                    messageId: "media-transcript-e2e",
                    sentAt: new Date().toISOString(),
                    lane: invitation.lane,
                    mediaSessionId: invitation.mediaSessionId,
                    utteranceId: "utterance-e2e-1",
                    sourceParticipantIdentity: "human-space-77",
                    sourceParticipantUuid: "human-77",
                    text: "Please answer aloud",
                    language: "en-ZA",
                    startedAt: new Date().toISOString(),
                    endedAt: new Date().toISOString(),
                }),
            ),
        );
        const transcriptEvent = await transcriptEventPromise;
        if (transcriptEvent.type !== "world.event") throw new Error("Expected voice world.event");
        expect(transcriptEvent.event).toMatchObject({
            kind: "voice_transcript",
            payload: { text: "Please answer aloud", sourceParticipantUuid: "human-77" },
        });

        const speechPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "voice-tool-e2e",
                    sentAt: new Date().toISOString(),
                    lane: transcriptEvent.lane,
                    eventId: transcriptEvent.eventId,
                    hermesRunId: "voice-run-e2e",
                    toolCallId: "voice-tool-call-e2e",
                    name: "wa_speak",
                    arguments: { text: "Hermes chose this spoken response" },
                }),
            ),
        );
        const speech = await speechPromise;
        if (speech.type !== "speech.publish") throw new Error("Expected speech.publish");
        expect(speech).toMatchObject({
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            mediaSessionId: invitation.mediaSessionId,
            text: "Hermes chose this spoken response",
            voiceId: "voice-1",
        });

        const toolResultPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "speech.result",
                    messageId: "speech-result-e2e",
                    sentAt: new Date().toISOString(),
                    lane: speech.lane,
                    mediaSessionId: speech.mediaSessionId,
                    speechId: speech.speechId,
                    outcome: "published",
                    reason: null,
                }),
            ),
        );
        await expect(toolResultPromise).resolves.toMatchObject({
            type: "tool.result",
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            outcome: "succeeded",
            result: { publication: "published" },
        });

        const videoPublishPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "video-tool-e2e",
                    sentAt: new Date().toISOString(),
                    lane: transcriptEvent.lane,
                    eventId: transcriptEvent.eventId,
                    hermesRunId: "video-run-e2e",
                    toolCallId: "video-tool-call-e2e",
                    name: "wa_start_video",
                    arguments: {},
                }),
            ),
        );
        const videoPublish = await videoPublishPromise;
        if (videoPublish.type !== "video.publish") throw new Error("Expected video.publish");
        expect(videoPublish).toMatchObject({
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            representation: { mode: "animated_woka", wokaTextureIds: ["body-1"] },
            limits: { width: 640, height: 360, fps: 15, bitrateKbps: 600 },
        });
        const videoToolResultPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "video.state",
                    messageId: "video-state-e2e",
                    sentAt: new Date().toISOString(),
                    lane: videoPublish.lane,
                    mediaSessionId: videoPublish.mediaSessionId,
                    publicationId: videoPublish.publicationId,
                    state: "publishing",
                    reason: null,
                }),
            ),
        );
        await expect(videoToolResultPromise).resolves.toMatchObject({
            type: "tool.result",
            lane: { agentId: firstAgent.id, profileId: "profile-one" },
            outcome: "succeeded",
            result: { state: "publishing" },
        });
        expect(firstRoom.cameraStates).toEqual([true]);
        expect(secondRoom.cameraStates).toEqual([]);

        const videoStopPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "tool.call",
                    messageId: "video-stop-tool-e2e",
                    sentAt: new Date().toISOString(),
                    lane: transcriptEvent.lane,
                    eventId: transcriptEvent.eventId,
                    hermesRunId: "video-stop-run-e2e",
                    toolCallId: "video-stop-call-e2e",
                    name: "wa_stop_video",
                    arguments: {},
                }),
            ),
        );
        const videoStop = await videoStopPromise;
        if (videoStop.type !== "video.stop") throw new Error("Expected video.stop");
        const videoStopResultPromise = receive(socket);
        socket.send(
            JSON.stringify(
                ClientMessageSchema.parse({
                    type: "video.state",
                    messageId: "video-stopped-state-e2e",
                    sentAt: new Date().toISOString(),
                    lane: videoStop.lane,
                    mediaSessionId: videoStop.mediaSessionId,
                    publicationId: videoStop.publicationId,
                    state: "stopped",
                    reason: null,
                }),
            ),
        );
        await expect(videoStopResultPromise).resolves.toMatchObject({
            type: "tool.result",
            outcome: "succeeded",
            result: { stopped: true },
        });
        expect(firstRoom.cameraStates).toEqual([true, false]);
    });
});
