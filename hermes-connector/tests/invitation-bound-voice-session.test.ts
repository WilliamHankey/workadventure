import type { ServerMessage } from "@workadventure/hermes-connector-protocol";
import { describe, expect, it, vi } from "vitest";

import {
    InvitationBoundVoiceSession,
    type LocalAudioPublisher,
    type LocalSpeechToText,
    type LocalTextToSpeech,
} from "../src/media/invitation-bound-voice-session";

const invitation = (): Extract<ServerMessage, { type: "media.invitation" }> => ({
    type: "media.invitation",
    messageId: "invitation-1",
    sentAt: new Date().toISOString(),
    lane: { agentId: "agent-1", profileId: "profile-1", sessionId: "session-1", sessionEpoch: 1 },
    mediaSessionId: "media-1",
    spaceName: "meeting-space",
    serverUrl: "wss://livekit.example",
    token: "token",
    allowedParticipantIdentity: "human-space-1",
    allowedParticipantUuid: "human-1",
    voiceId: "voice-1",
    policy: {
        vadThreshold: 0.5,
        silenceMs: 100,
        maxUtteranceMs: 1_000,
        transcriptRetention: "audit_metadata",
        bargeIn: true,
    },
});

const frame = (sample: number, sourceParticipantIdentity = "human-space-1", sourceParticipantUuid = "human-1") => ({
    sourceParticipantIdentity,
    sourceParticipantUuid,
    samples: new Int16Array(800).fill(sample),
    sampleRate: 8_000,
    capturedAt: new Date(),
});

describe("invitation-bound voice session", () => {
    it("turns synthetic authorized PCM into one transcript and publishes local TTS", async () => {
        const transcripts: unknown[] = [];
        const published: Array<{ speechId: string; samples: number; sampleRate: number }> = [];
        const transcribe = vi.fn(() => Promise.resolve({ text: "  Hello agent  ", language: "en-ZA" }));
        const stt: LocalSpeechToText = { transcribe };
        const tts: LocalTextToSpeech = {
            synthesize: vi.fn(() => Promise.resolve({ samples: new Int16Array(160).fill(1_000), sampleRate: 16_000 })),
        };
        const publisher: LocalAudioPublisher = {
            publish: (speechId, samples, sampleRate) => {
                published.push({ speechId, samples: samples.length, sampleRate });
                return Promise.resolve();
            },
            stop: () => Promise.resolve(),
        };
        const session = new InvitationBoundVoiceSession(
            invitation(),
            {
                ready: () => Promise.resolve(),
                transcript: (value) => {
                    transcripts.push(value);
                    return Promise.resolve();
                },
                stopped: () => Promise.resolve(),
            },
            stt,
            tts,
            publisher
        );

        await expect(session.pushFrame(frame(25_000, "attacker-space", "attacker"))).resolves.toBe(false);
        await session.pushFrame(frame(25_000));
        await session.pushFrame(frame(0));
        await expect(session.speak("speech-1", "Hello human", "voice-1")).resolves.toBe("published");

        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(transcripts).toContainEqual(
            expect.objectContaining({
                sourceParticipantIdentity: "human-space-1",
                sourceParticipantUuid: "human-1",
                text: "Hello agent",
                language: "en-ZA",
            })
        );
        expect(published).toEqual([{ speechId: "speech-1", samples: 160, sampleRate: 16_000 }]);
    });

    it("interrupts speech on authorized barge-in and stops idempotently", async () => {
        let stopCount = 0;
        const publisher: LocalAudioPublisher = {
            publish: (_speechId, _samples, _sampleRate, signal) =>
                new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(resolve, 60_000);
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timeout);
                            reject(signal.reason instanceof Error ? signal.reason : new Error("speech_aborted"));
                        },
                        { once: true }
                    );
                }),
            stop: () => {
                stopCount += 1;
                return Promise.resolve();
            },
        };
        const session = new InvitationBoundVoiceSession(
            invitation(),
            { ready: () => Promise.resolve(), transcript: () => Promise.resolve(), stopped: () => Promise.resolve() },
            { transcribe: () => Promise.resolve({ text: "interrupt", language: null }) },
            { synthesize: () => Promise.resolve({ samples: new Int16Array(160), sampleRate: 16_000 }) },
            publisher
        );

        const speech = session.speak("speech-2", "Long response", "voice-1");
        await Promise.resolve();
        await session.pushFrame(frame(25_000));
        await expect(speech).resolves.toBe("interrupted");
        await session.stop("left_by_hermes");
        await session.stop("duplicate_stop");
        expect(stopCount).toBe(1);
    });
});
