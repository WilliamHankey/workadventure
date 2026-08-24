import type {
    AgentToolName,
    AgentLane,
    SafeProfile,
    ServerMessage,
    WorldEventDispatch,
} from "@workadventure/hermes-connector-protocol";

export interface LocalHermesProfile {
    profileId: string;
    displayName: string;
    baseUrl: string;
    apiKey: string;
}

export interface HermesProfileDiscovery {
    discover(): Promise<LocalHermesProfile[]>;
}

export interface HermesToolCall {
    toolCallId: string;
    name: AgentToolName;
    arguments: Record<string, unknown>;
}

export interface HermesRunResult {
    runId: string;
    output: string | null;
    toolCalls: HermesToolCall[];
}

export interface HermesProfileGateway {
    probe(): Promise<SafeProfile>;
    run(
        dispatch: WorldEventDispatch,
        sessionKey: string,
        signal: AbortSignal,
        onStarted: (runId: string) => Promise<void>
    ): Promise<HermesRunResult>;
    submitToolResult(message: Extract<ServerMessage, { type: "tool.result" }>): Promise<void>;
}

export interface HermesProfileGatewayFactory {
    create(profile: LocalHermesProfile): HermesProfileGateway;
}

export interface ConnectorTransport {
    onOpen(handler: () => Promise<void>): void;
    onMessage(handler: (message: unknown) => Promise<void>): void;
    connect(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
}

export interface HermesMediaTranscript {
    utteranceId: string;
    sourceParticipantIdentity: string;
    sourceParticipantUuid: string;
    text: string;
    language: string | null;
    startedAt: string;
    endedAt: string;
}

export interface HermesMediaSessionHandlers {
    ready(): Promise<void>;
    transcript(transcript: HermesMediaTranscript): Promise<void>;
    stopped(reason: string): Promise<void>;
}

export interface HermesMediaSession {
    readonly lane: AgentLane;
    readonly mediaSessionId: string;
    speak(speechId: string, text: string, voiceId: string | null): Promise<"published" | "interrupted">;
    startVideo?(publication: Extract<ServerMessage, { type: "video.publish" }>): Promise<"publishing" | "failed">;
    stopVideo?(publicationId: string, reason: string): Promise<void>;
    stop(reason: string): Promise<void>;
}

export interface HermesMediaAdapter {
    start(
        invitation: Extract<ServerMessage, { type: "media.invitation" }>,
        handlers: HermesMediaSessionHandlers
    ): Promise<HermesMediaSession>;
}
