import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    ClientMessageSchema,
    type AgentToolName,
    type SafeProfile,
    type ServerMessage,
    type WorldEventDispatch,
} from "@workadventure/hermes-connector-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { HermesConnector, stableHermesSessionKey } from "../src/connector";
import type {
    ConnectorTransport,
    HermesMediaAdapter,
    HermesMediaSession,
    HermesMediaSessionHandlers,
    HermesProfileDiscovery,
    HermesProfileGateway,
    HermesProfileGatewayFactory,
    HermesRunResult,
    LocalHermesProfile,
} from "../src/contracts";
import { FileSystemHermesProfileDiscovery } from "../src/profile-discovery";

class MemoryTransport implements ConnectorTransport {
    readonly sent: unknown[] = [];
    private openHandler: (() => Promise<void>) | undefined;
    private messageHandler: ((message: unknown) => Promise<void>) | undefined;

    onOpen(handler: () => Promise<void>): void {
        this.openHandler = handler;
    }

    onMessage(handler: (message: unknown) => Promise<void>): void {
        this.messageHandler = handler;
    }

    async connect(): Promise<void> {
        await this.openHandler?.();
    }

    send(message: unknown): Promise<void> {
        this.sent.push(structuredClone(message));
        return Promise.resolve();
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    async deliver(message: ServerMessage): Promise<void> {
        await this.messageHandler?.(message);
    }
}

class StaticDiscovery implements HermesProfileDiscovery {
    constructor(private readonly profiles: LocalHermesProfile[]) {}

    discover(): Promise<LocalHermesProfile[]> {
        return Promise.resolve(structuredClone(this.profiles));
    }
}

class FakeGateway implements HermesProfileGateway {
    readonly runs: Array<{ dispatch: WorldEventDispatch; sessionKey: string }> = [];
    readonly results: Array<Extract<ServerMessage, { type: "tool.result" }>> = [];

    constructor(
        private readonly profile: LocalHermesProfile,
        private readonly toolName: AgentToolName = "wa_say"
    ) {}

    probe(): Promise<SafeProfile> {
        return Promise.resolve({
            profileId: this.profile.profileId,
            displayName: this.profile.displayName,
            advertisedModel: "hermes-test-model",
            capabilities: ["run_submission", "session_key_header"],
            health: "healthy",
            readiness: true,
            activeRuns: 0,
            lastSeenAt: new Date().toISOString(),
        });
    }

    async run(
        dispatch: WorldEventDispatch,
        sessionKey: string,
        _signal: AbortSignal,
        onStarted: (runId: string) => Promise<void>
    ): Promise<HermesRunResult> {
        this.runs.push({ dispatch: structuredClone(dispatch), sessionKey });
        await onStarted(`run-${this.profile.profileId}`);
        return {
            runId: `run-${this.profile.profileId}`,
            output: "Hermes chose an in-world action",
            toolCalls: [{ toolCallId: "tool-1", name: this.toolName, arguments: { text: "Hello" } }],
        };
    }

    submitToolResult(message: Extract<ServerMessage, { type: "tool.result" }>): Promise<void> {
        this.results.push(structuredClone(message));
        return Promise.resolve();
    }
}

class FakeGatewayFactory implements HermesProfileGatewayFactory {
    readonly gateways = new Map<string, FakeGateway>();

    constructor(private readonly toolName: AgentToolName = "wa_say") {}

    create(profile: LocalHermesProfile): HermesProfileGateway {
        const gateway = new FakeGateway(profile, this.toolName);
        this.gateways.set(profile.profileId, gateway);
        return gateway;
    }
}

class FakeMediaAdapter implements HermesMediaAdapter {
    handlers: HermesMediaSessionHandlers | undefined;
    session: HermesMediaSession | undefined;
    readonly spoken: Array<{ speechId: string; text: string; voiceId: string | null }> = [];
    readonly videos: string[] = [];

    async start(
        invitation: Extract<ServerMessage, { type: "media.invitation" }>,
        handlers: HermesMediaSessionHandlers
    ): Promise<HermesMediaSession> {
        this.handlers = handlers;
        const session: HermesMediaSession = {
            lane: invitation.lane,
            mediaSessionId: invitation.mediaSessionId,
            speak: (speechId, text, voiceId) => {
                this.spoken.push({ speechId, text, voiceId });
                return Promise.resolve("published");
            },
            startVideo: (publication) => {
                this.videos.push(`start:${publication.publicationId}`);
                return Promise.resolve("publishing");
            },
            stopVideo: (publicationId) => {
                this.videos.push(`stop:${publicationId}`);
                return Promise.resolve();
            },
            stop: async (reason) => handlers.stopped(reason),
        };
        this.session = session;
        await handlers.ready();
        return session;
    }
}

const base = { messageId: "server-message-1", sentAt: new Date().toISOString() };
const lane = { agentId: "agent-1", profileId: "researcher", sessionId: "session-1", sessionEpoch: 3 };

const acceptedMessage = (allowedTools: AgentToolName[]): ServerMessage => ({
    ...base,
    type: "connector.accepted",
    connectionId: "connection-1",
    heartbeatIntervalMs: 120_000,
    bindings: [
        { agentId: lane.agentId, profileId: lane.profileId, definitionVersion: 1, sessionEpoch: 3, allowedTools },
    ],
});

const worldEventMessage = (): ServerMessage => ({
    ...base,
    messageId: "server-message-2",
    type: "world.event",
    eventId: "event-1",
    lane,
    instructions: "Use only the bound WorkAdventure tools when an action is needed.",
    event: {
        kind: "direct_message",
        occurredAt: new Date().toISOString(),
        conversationId: "dm-owner-1",
        payload: { senderId: "owner-1", text: "Say hello" },
    },
});

describe("Hermes connector", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })));
    });

    it("routes a world event through the bound profile and returns its permitted tool call", async () => {
        const transport = new MemoryTransport();
        const factory = new FakeGatewayFactory();
        const connector = new HermesConnector(
            new StaticDiscovery([
                {
                    profileId: "researcher",
                    displayName: "Researcher",
                    baseUrl: "http://127.0.0.1:8643",
                    apiKey: "profile-secret-never-transmitted",
                },
            ]),
            factory,
            transport,
            { connectorId: "desktop-1", instanceId: "instance-1" }
        );

        await connector.start();
        await transport.deliver(acceptedMessage(["wa_say"]));
        await transport.deliver(worldEventMessage());
        await transport.deliver({
            ...base,
            messageId: "server-message-3",
            type: "tool.result",
            eventId: "event-1",
            lane,
            hermesRunId: "run-researcher",
            toolCallId: "tool-1",
            outcome: "succeeded",
            result: { delivered: true },
        });
        await connector.stop();

        const messages = transport.sent.map((message) => ClientMessageSchema.parse(message));
        expect(messages.map((message) => message.type)).toEqual([
            "connector.hello",
            "run.started",
            "tool.call",
            "run.completed",
        ]);
        expect(messages.find((message) => message.type === "tool.call")).toMatchObject({
            lane,
            name: "wa_say",
        });
        expect(factory.gateways.get("researcher")?.runs).toHaveLength(1);
        expect(factory.gateways.get("researcher")?.results).toHaveLength(1);
        expect(JSON.stringify(messages)).not.toContain("profile-secret-never-transmitted");
    });

    it("rejects a tool that is outside the agent binding", async () => {
        const transport = new MemoryTransport();
        const connector = new HermesConnector(
            new StaticDiscovery([
                {
                    profileId: "researcher",
                    displayName: "Researcher",
                    baseUrl: "http://127.0.0.1:8643",
                    apiKey: "local-only",
                },
            ]),
            new FakeGatewayFactory("wa_start_video"),
            transport,
            { connectorId: "desktop-1", instanceId: "instance-2" }
        );

        await connector.start();
        await transport.deliver(acceptedMessage(["wa_say"]));
        await transport.deliver(worldEventMessage());
        await connector.stop();

        const messages = transport.sent.map((message) => ClientMessageSchema.parse(message));
        expect(messages.some((message) => message.type === "tool.call")).toBe(false);
        expect(messages.at(-1)).toMatchObject({ type: "run.failed", errorCode: "tool_not_permitted", lane });
    });

    it("rejects stale lanes before they reach any Hermes profile", async () => {
        const transport = new MemoryTransport();
        const factory = new FakeGatewayFactory();
        const connector = new HermesConnector(
            new StaticDiscovery([
                {
                    profileId: "researcher",
                    displayName: "Researcher",
                    baseUrl: "http://127.0.0.1:8643",
                    apiKey: "local-only",
                },
            ]),
            factory,
            transport,
            { connectorId: "desktop-1", instanceId: "instance-3" }
        );

        await connector.start();
        await transport.deliver(acceptedMessage(["wa_say"]));
        const stale = worldEventMessage();
        if (stale.type !== "world.event") {
            throw new Error("Expected world.event");
        }
        await transport.deliver({ ...stale, lane: { ...stale.lane, sessionEpoch: 2 } });
        await connector.stop();

        const messages = transport.sent.map((message) => ClientMessageSchema.parse(message));
        expect(messages.at(-1)).toMatchObject({ type: "run.failed", errorCode: "lane_binding_rejected" });
        expect(factory.gateways.get("researcher")?.runs).toHaveLength(0);
    });

    it("derives a stable, bounded Hermes memory key per agent conversation", () => {
        const first = stableHermesSessionKey(lane, "dm-owner-1");
        const second = stableHermesSessionKey(lane, "dm-owner-1");
        const different = stableHermesSessionKey(lane, "dm-someone-else");

        expect(first).toBe(second);
        expect(first).not.toBe(different);
        expect(first.length).toBeLessThanOrEqual(256);
    });

    it("keeps LiveKit transcription and speech inside the invitation-bound agent lane", async () => {
        const transport = new MemoryTransport();
        const mediaAdapter = new FakeMediaAdapter();
        const connector = new HermesConnector(
            new StaticDiscovery([
                {
                    profileId: "researcher",
                    displayName: "Researcher",
                    baseUrl: "http://127.0.0.1:8643",
                    apiKey: "local-only",
                },
            ]),
            new FakeGatewayFactory(),
            transport,
            { connectorId: "desktop-voice", instanceId: "instance-voice", mediaAdapter }
        );

        await connector.start();
        await transport.deliver(acceptedMessage(["wa_join_meeting", "wa_leave_meeting", "wa_speak"]));
        await transport.deliver({
            ...base,
            type: "media.invitation",
            lane,
            mediaSessionId: "media-session-1",
            spaceName: "meeting-space",
            serverUrl: "wss://livekit.example",
            token: "livekit-token-never-sent-to-hermes-model",
            allowedParticipantIdentity: "human-space-1",
            allowedParticipantUuid: "owner-1",
            voiceId: "voice-1",
            policy: {
                vadThreshold: 0.55,
                silenceMs: 650,
                maxUtteranceMs: 30_000,
                transcriptRetention: "audit_metadata",
                bargeIn: true,
            },
        });
        await mediaAdapter.handlers?.transcript({
            utteranceId: "utterance-1",
            sourceParticipantIdentity: "human-space-1",
            sourceParticipantUuid: "owner-1",
            text: "Can you hear me?",
            language: "en-ZA",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
        });
        await expect(
            mediaAdapter.handlers?.transcript({
                utteranceId: "utterance-attacker",
                sourceParticipantIdentity: "other-space-user",
                sourceParticipantUuid: "other-user",
                text: "Cross-session injection",
                language: null,
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
            })
        ).rejects.toThrow(/outside the invitation participant binding/);
        await transport.deliver({
            ...base,
            type: "speech.publish",
            lane,
            mediaSessionId: "media-session-1",
            speechId: "speech-1",
            text: "Yes, I can hear you.",
            voiceId: "voice-1",
        });
        await transport.deliver({
            ...base,
            type: "video.publish",
            lane,
            mediaSessionId: "media-session-1",
            publicationId: "video-1",
            representation: {
                mode: "animated_woka",
                displayName: "Agent One",
                wokaTextureIds: ["body-1"],
                assetRef: null,
            },
            limits: { width: 640, height: 360, fps: 15, bitrateKbps: 600 },
        });
        await transport.deliver({
            ...base,
            type: "video.stop",
            lane,
            mediaSessionId: "media-session-1",
            publicationId: "video-1",
            reason: "stopped_by_hermes",
        });
        await transport.deliver({
            ...base,
            type: "media.stop",
            lane,
            mediaSessionId: "media-session-1",
            reason: "left_by_hermes",
        });
        await connector.stop();

        const messages = transport.sent.map((message) => ClientMessageSchema.parse(message));
        expect(messages.map((message) => message.type)).toContain("media.ready");
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "media.transcript",
                lane,
                mediaSessionId: "media-session-1",
                sourceParticipantUuid: "owner-1",
                text: "Can you hear me?",
            })
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "speech.result",
                lane,
                mediaSessionId: "media-session-1",
                speechId: "speech-1",
                outcome: "published",
            })
        );
        expect(mediaAdapter.spoken).toEqual([
            { speechId: "speech-1", text: "Yes, I can hear you.", voiceId: "voice-1" },
        ]);
        expect(mediaAdapter.videos).toEqual(["start:video-1", "stop:video-1"]);
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "video.state",
                lane,
                mediaSessionId: "media-session-1",
                publicationId: "video-1",
                state: "publishing",
            })
        );
        expect(messages).toContainEqual(
            expect.objectContaining({
                type: "video.state",
                lane,
                mediaSessionId: "media-session-1",
                publicationId: "video-1",
                state: "stopped",
            })
        );
        expect(JSON.stringify(messages)).not.toContain("livekit-token-never-sent-to-hermes-model");
    });

    it("discovers local profiles without placing their keys in safe metadata", async () => {
        const hermesHome = await mkdtemp(path.join(tmpdir(), "hermes-connector-test-"));
        temporaryDirectories.push(hermesHome);
        const researcherHome = path.join(hermesHome, "profiles", "researcher");
        await mkdir(researcherHome, { recursive: true });
        await writeFile(
            path.join(researcherHome, ".env"),
            "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=local-researcher-key\nAPI_SERVER_PORT=8643\n",
            "utf8"
        );

        const discovery = new FileSystemHermesProfileDiscovery({ hermesHome });
        const profiles = await discovery.discover();

        expect(profiles).toEqual([
            {
                profileId: "researcher",
                displayName: "researcher",
                baseUrl: "http://127.0.0.1:8643",
                apiKey: "local-researcher-key",
            },
        ]);
    });
});
