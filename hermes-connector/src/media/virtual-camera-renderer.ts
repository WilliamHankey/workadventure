import type { ServerMessage } from "@workadventure/hermes-connector-protocol";

type VideoPublication = Extract<ServerMessage, { type: "video.publish" }>;

export interface VirtualCameraRasterizer {
    render(
        representation: VideoPublication["representation"],
        width: number,
        height: number,
        animationFrame: number
    ): Promise<Uint8Array>;
}

export interface VirtualCameraFrame {
    rgba: Uint8Array;
    width: number;
    height: number;
    capturedAtMs: number;
    animationFrame: number;
    maxEncodedBytes: number;
}

export class VirtualCameraRenderer {
    private lastFrameAtMs = Number.NEGATIVE_INFINITY;
    private animationFrame = 0;
    private publishedWindowStartedAtMs = 0;
    private publishedBytesInWindow = 0;

    constructor(
        private readonly publication: VideoPublication,
        private readonly rasterizer: VirtualCameraRasterizer
    ) {}

    async renderNext(nowMs: number, speaking: boolean): Promise<VirtualCameraFrame | null> {
        const frameIntervalMs = 1_000 / this.publication.limits.fps;
        if (nowMs - this.lastFrameAtMs < frameIntervalMs) return null;
        this.lastFrameAtMs = nowMs;
        this.animationFrame = speaking ? (this.animationFrame % 3) + 1 : 0;
        const rgba = await this.rasterizer.render(
            this.publication.representation,
            this.publication.limits.width,
            this.publication.limits.height,
            this.animationFrame
        );
        const expectedBytes = this.publication.limits.width * this.publication.limits.height * 4;
        if (rgba.byteLength !== expectedBytes) {
            throw new Error(
                `Virtual camera rasterizer returned ${String(rgba.byteLength)} bytes; expected ${String(expectedBytes)}`
            );
        }
        return {
            rgba,
            width: this.publication.limits.width,
            height: this.publication.limits.height,
            capturedAtMs: nowMs,
            animationFrame: this.animationFrame,
            maxEncodedBytes: Math.floor(
                (this.publication.limits.bitrateKbps * 1_000) / 8 / this.publication.limits.fps
            ),
        };
    }

    recordPublishedBytes(encodedBytes: number, nowMs: number): void {
        if (nowMs - this.publishedWindowStartedAtMs >= 1_000) {
            this.publishedWindowStartedAtMs = nowMs;
            this.publishedBytesInWindow = 0;
        }
        this.publishedBytesInWindow += encodedBytes;
        const oneSecondBudget = (this.publication.limits.bitrateKbps * 1_000) / 8;
        if (this.publishedBytesInWindow > oneSecondBudget) {
            throw new Error("Virtual camera bitrate budget exceeded");
        }
    }
}
