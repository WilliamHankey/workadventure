import type { ServerMessage } from "@workadventure/hermes-connector-protocol";
import WebSocket, { type RawData } from "ws";
import { z } from "zod/v4";

import type { HermesMediaAdapter, HermesMediaSession, HermesMediaSessionHandlers } from "../contracts";

const BridgeMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({
        type: z.literal("transcript"),
        utteranceId: z.string().min(1).max(128),
        sourceParticipantIdentity: z.string().min(1).max(128),
        sourceParticipantUuid: z.string().min(1).max(128),
        text: z.string().min(1).max(8_000),
        language: z.string().min(2).max(32).nullable(),
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime(),
    }),
    z.object({ type: z.literal("stopped"), reason: z.string().min(1).max(255) }),
    z.object({
        type: z.literal("speech.result"),
        speechId: z.string().min(1).max(128),
        outcome: z.enum(["published", "interrupted", "failed"]),
        reason: z.string().min(1).max(255).nullable(),
    }),
    z.object({
        type: z.literal("video.state"),
        publicationId: z.string().min(1).max(128),
        state: z.enum(["starting", "publishing", "stopped", "failed"]),
        reason: z.string().min(1).max(255).nullable(),
    }),
]);

interface LocalMediaBridgeOptions {
    url: string;
    token?: string;
    connectTimeoutMs?: number;
    speechTimeoutMs?: number;
}

interface PendingSpeech {
    resolve: (outcome: "published" | "interrupted") => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface PendingVideo {
    resolve: (state: "publishing" | "stopped") => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

const toText = (data: RawData): string =>
    Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data)).toString("utf8")
          : data.toString("utf8");

const assertLoopback = (value: string): URL => {
    const url = new URL(value);
    if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname) || !["ws:", "wss:"].includes(url.protocol)) {
        throw new Error("HERMES_MEDIA_BRIDGE_URL must be a loopback ws:// or wss:// URL");
    }
    return url;
};

export class LocalMediaBridgeAdapter implements HermesMediaAdapter {
    private readonly url: URL;

    constructor(private readonly options: LocalMediaBridgeOptions) {
        this.url = assertLoopback(options.url);
    }

    async start(
        invitation: Extract<ServerMessage, { type: "media.invitation" }>,
        handlers: HermesMediaSessionHandlers
    ): Promise<HermesMediaSession> {
        const socket = new WebSocket(this.url, {
            headers: this.options.token === undefined ? undefined : { authorization: `Bearer ${this.options.token}` },
        });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error("Local Hermes media bridge connection timed out"));
            }, this.options.connectTimeoutMs ?? 5_000);
            socket.once("open", () => {
                clearTimeout(timeout);
                resolve();
            });
            socket.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });

        const pendingSpeech = new Map<string, PendingSpeech>();
        const pendingVideo = new Map<string, PendingVideo>();
        let stopped = false;
        const rejectPending = (error: Error): void => {
            for (const pending of pendingSpeech.values()) {
                clearTimeout(pending.timeout);
                pending.reject(error);
            }
            pendingSpeech.clear();
            for (const pending of pendingVideo.values()) {
                clearTimeout(pending.timeout);
                pending.reject(error);
            }
            pendingVideo.clear();
        };
        socket.on("message", (data) => {
            let message: z.infer<typeof BridgeMessageSchema>;
            try {
                message = BridgeMessageSchema.parse(JSON.parse(toText(data)) as unknown);
            } catch {
                socket.close(1008, "Invalid local media bridge message");
                return;
            }
            if (message.type === "ready") {
                handlers.ready().catch(() => socket.close(1011, "Ready handler failed"));
            } else if (message.type === "transcript") {
                handlers.transcript(message).catch(() => socket.close(1008, "Transcript lane rejected"));
            } else if (message.type === "stopped") {
                stopped = true;
                rejectPending(new Error(message.reason));
                handlers.stopped(message.reason).catch(() => undefined);
            } else if (message.type === "speech.result") {
                const pending = pendingSpeech.get(message.speechId);
                if (pending === undefined) return;
                clearTimeout(pending.timeout);
                pendingSpeech.delete(message.speechId);
                if (message.outcome === "failed") {
                    pending.reject(new Error(message.reason ?? "Local media bridge speech failed"));
                } else {
                    pending.resolve(message.outcome);
                }
            } else {
                if (message.state === "starting") return;
                const pending = pendingVideo.get(message.publicationId);
                if (pending === undefined) return;
                clearTimeout(pending.timeout);
                pendingVideo.delete(message.publicationId);
                if (message.state === "failed") {
                    pending.reject(new Error(message.reason ?? "Local media bridge video failed"));
                } else {
                    pending.resolve(message.state);
                }
            }
        });
        socket.on("close", () => {
            if (!stopped) {
                stopped = true;
                rejectPending(new Error("Local media bridge disconnected"));
                handlers.stopped("local_media_bridge_disconnected").catch(() => undefined);
            }
        });
        socket.send(
            JSON.stringify({
                type: "start",
                mediaSessionId: invitation.mediaSessionId,
                lane: invitation.lane,
                spaceName: invitation.spaceName,
                serverUrl: invitation.serverUrl,
                token: invitation.token,
                allowedParticipantIdentity: invitation.allowedParticipantIdentity,
                allowedParticipantUuid: invitation.allowedParticipantUuid,
                voiceId: invitation.voiceId,
                policy: invitation.policy,
            })
        );

        return {
            lane: invitation.lane,
            mediaSessionId: invitation.mediaSessionId,
            speak: (speechId, text, voiceId) => {
                if (stopped || socket.readyState !== WebSocket.OPEN) {
                    return Promise.reject(new Error("Local media bridge session is not open"));
                }
                const result = new Promise<"published" | "interrupted">((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        pendingSpeech.delete(speechId);
                        reject(new Error("Local media bridge speech timed out"));
                    }, this.options.speechTimeoutMs ?? 30_000);
                    pendingSpeech.set(speechId, { resolve, reject, timeout });
                });
                socket.send(JSON.stringify({ type: "speech", speechId, text, voiceId }));
                return result;
            },
            startVideo: (publication) => {
                if (stopped || socket.readyState !== WebSocket.OPEN) {
                    return Promise.reject(new Error("Local media bridge session is not open"));
                }
                const result = new Promise<"publishing" | "stopped">((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        pendingVideo.delete(publication.publicationId);
                        reject(new Error("Local media bridge video start timed out"));
                    }, this.options.speechTimeoutMs ?? 30_000);
                    pendingVideo.set(publication.publicationId, { resolve, reject, timeout });
                });
                socket.send(
                    JSON.stringify({
                        type: "video.start",
                        publicationId: publication.publicationId,
                        representation: publication.representation,
                        limits: publication.limits,
                    })
                );
                return result.then((state) => (state === "publishing" ? "publishing" : "failed"));
            },
            stopVideo: (publicationId, reason) => {
                if (stopped || socket.readyState !== WebSocket.OPEN) return Promise.resolve();
                const result = new Promise<"publishing" | "stopped">((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        pendingVideo.delete(publicationId);
                        reject(new Error("Local media bridge video stop timed out"));
                    }, this.options.speechTimeoutMs ?? 30_000);
                    pendingVideo.set(publicationId, { resolve, reject, timeout });
                });
                socket.send(JSON.stringify({ type: "video.stop", publicationId, reason }));
                return result.then(() => undefined);
            },
            stop: async (reason) => {
                if (stopped) return;
                stopped = true;
                rejectPending(new Error(reason));
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "stop", reason }));
                    await new Promise<void>((resolve) => {
                        socket.once("close", () => resolve());
                        socket.close(1000, reason.slice(0, 123));
                    });
                }
                await handlers.stopped(reason);
            },
        };
    }
}
