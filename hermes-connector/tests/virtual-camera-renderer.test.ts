import type { ServerMessage } from "@workadventure/hermes-connector-protocol";
import { describe, expect, it, vi } from "vitest";

import { VirtualCameraRenderer } from "../src/media/virtual-camera-renderer";

const publication = (): Extract<ServerMessage, { type: "video.publish" }> => ({
    type: "video.publish",
    messageId: "video-message-1",
    sentAt: new Date().toISOString(),
    lane: { agentId: "agent-1", profileId: "profile-1", sessionId: "session-1", sessionEpoch: 1 },
    mediaSessionId: "media-1",
    publicationId: "video-1",
    representation: {
        mode: "animated_woka",
        displayName: "Agent One",
        wokaTextureIds: ["body-1"],
        assetRef: null,
    },
    limits: { width: 64, height: 64, fps: 10, bitrateKbps: 80 },
});

describe("virtual camera renderer", () => {
    it("paces rasterization, animates speaking state, and enforces bitrate", async () => {
        const render = vi.fn((_representation, width: number, height: number) =>
            Promise.resolve(new Uint8Array(width * height * 4))
        );
        const renderer = new VirtualCameraRenderer(publication(), { render });

        const idle = await renderer.renderNext(0, false);
        expect(idle).toMatchObject({ width: 64, height: 64, animationFrame: 0, maxEncodedBytes: 1_000 });
        await expect(renderer.renderNext(50, true)).resolves.toBeNull();
        const speaking = await renderer.renderNext(100, true);
        expect(speaking).toMatchObject({ animationFrame: 1 });
        expect(render).toHaveBeenCalledTimes(2);

        renderer.recordPublishedBytes(5_000, 0);
        renderer.recordPublishedBytes(5_000, 500);
        expect(() => renderer.recordPublishedBytes(1, 900)).toThrow(/bitrate budget exceeded/);
        expect(() => renderer.recordPublishedBytes(10_000, 1_000)).not.toThrow();
    });
});
