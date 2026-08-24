import type {
    AgentToolName,
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
