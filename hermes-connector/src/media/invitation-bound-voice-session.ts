import { randomUUID } from "node:crypto";

import type { ServerMessage } from "@workadventure/hermes-connector-protocol";

import type { HermesMediaSession, HermesMediaSessionHandlers } from "../contracts";

export interface PcmFrame {
    sourceParticipantIdentity: string;
    sourceParticipantUuid: string;
    samples: Int16Array;
    sampleRate: number;
    capturedAt: Date;
}

export interface SpeechRecognitionResult {
    text: string;
    language: string | null;
}

export interface LocalSpeechToText {
    transcribe(samples: Int16Array, sampleRate: number, signal: AbortSignal): Promise<SpeechRecognitionResult>;
}

export interface LocalTextToSpeech {
    synthesize(
        text: string,
        voiceId: string | null,
        signal: AbortSignal
    ): Promise<{ samples: Int16Array; sampleRate: number }>;
}

export interface LocalAudioPublisher {
    publish(speechId: string, samples: Int16Array, sampleRate: number, signal: AbortSignal): Promise<void>;
    stop(): Promise<void>;
}

interface ActiveUtterance {
    id: string;
    frames: Int16Array[];
    sampleRate: number;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    silenceMs: number;
}

const normalizedRms = (samples: Int16Array): number => {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length) / 32_768;
};

const concatenate = (frames: Int16Array[]): Int16Array => {
    const output = new Int16Array(frames.reduce((length, frame) => length + frame.length, 0));
    let offset = 0;
    for (const frame of frames) {
        output.set(frame, offset);
        offset += frame.length;
    }
    return output;
};

export class InvitationBoundVoiceSession implements HermesMediaSession {
    readonly lane;
    readonly mediaSessionId;
    private utterance: ActiveUtterance | undefined;
    private transcriptionAbortController: AbortController | undefined;
    private speechAbortController: AbortController | undefined;
    private stopped = false;

    constructor(
        private readonly invitation: Extract<ServerMessage, { type: "media.invitation" }>,
        private readonly handlers: HermesMediaSessionHandlers,
        private readonly stt: LocalSpeechToText,
        private readonly tts: LocalTextToSpeech,
        private readonly publisher: LocalAudioPublisher
    ) {
        this.lane = invitation.lane;
        this.mediaSessionId = invitation.mediaSessionId;
    }

    async pushFrame(frame: PcmFrame): Promise<boolean> {
        if (this.stopped) return false;
        if (
            frame.sourceParticipantIdentity !== this.invitation.allowedParticipantIdentity ||
            frame.sourceParticipantUuid !== this.invitation.allowedParticipantUuid
        ) {
            return false;
        }
        if (!Number.isInteger(frame.sampleRate) || frame.sampleRate < 8_000 || frame.sampleRate > 96_000) {
            throw new Error("Unsupported PCM sample rate");
        }
        const frameMs = (frame.samples.length / frame.sampleRate) * 1_000;
        const speaking = normalizedRms(frame.samples) >= this.invitation.policy.vadThreshold;
        if (speaking && this.invitation.policy.bargeIn) {
            this.speechAbortController?.abort(new Error("barge_in"));
        }
        if (this.utterance === undefined && !speaking) return true;
        if (this.utterance === undefined) {
            this.utterance = {
                id: `utterance-${randomUUID()}`,
                frames: [],
                sampleRate: frame.sampleRate,
                startedAt: frame.capturedAt,
                endedAt: frame.capturedAt,
                durationMs: 0,
                silenceMs: 0,
            };
        }
        if (this.utterance.sampleRate !== frame.sampleRate) {
            throw new Error("PCM sample rate changed during an utterance");
        }
        this.utterance.frames.push(frame.samples.slice());
        this.utterance.endedAt = frame.capturedAt;
        this.utterance.durationMs += frameMs;
        this.utterance.silenceMs = speaking ? 0 : this.utterance.silenceMs + frameMs;
        if (
            this.utterance.silenceMs >= this.invitation.policy.silenceMs ||
            this.utterance.durationMs >= this.invitation.policy.maxUtteranceMs
        ) {
            await this.finalizeUtterance();
        }
        return true;
    }

    async speak(speechId: string, text: string, voiceId: string | null): Promise<"published" | "interrupted"> {
        if (this.stopped) throw new Error("Voice session is stopped");
        this.speechAbortController?.abort(new Error("speech_replaced"));
        const abortController = new AbortController();
        this.speechAbortController = abortController;
        try {
            const audio = await this.tts.synthesize(text, voiceId, abortController.signal);
            await this.publisher.publish(speechId, audio.samples, audio.sampleRate, abortController.signal);
            return "published";
        } catch (error: unknown) {
            if (abortController.signal.aborted) return "interrupted";
            throw error;
        } finally {
            if (this.speechAbortController === abortController) this.speechAbortController = undefined;
        }
    }

    async stop(reason: string): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.utterance = undefined;
        this.transcriptionAbortController?.abort(new Error(reason));
        this.speechAbortController?.abort(new Error(reason));
        await this.publisher.stop();
        await this.handlers.stopped(reason);
    }

    private async finalizeUtterance(): Promise<void> {
        const utterance = this.utterance;
        this.utterance = undefined;
        if (utterance === undefined || this.stopped) return;
        this.transcriptionAbortController?.abort(new Error("transcription_replaced"));
        const abortController = new AbortController();
        this.transcriptionAbortController = abortController;
        try {
            const result = await this.stt.transcribe(
                concatenate(utterance.frames),
                utterance.sampleRate,
                abortController.signal
            );
            if (result.text.trim() === "" || this.stopped) return;
            await this.handlers.transcript({
                utteranceId: utterance.id,
                sourceParticipantIdentity: this.invitation.allowedParticipantIdentity,
                sourceParticipantUuid: this.invitation.allowedParticipantUuid,
                text: result.text.trim(),
                language: result.language,
                startedAt: utterance.startedAt.toISOString(),
                endedAt: utterance.endedAt.toISOString(),
            });
        } finally {
            if (this.transcriptionAbortController === abortController) this.transcriptionAbortController = undefined;
        }
    }
}
