import {
    AvailabilityStatus,
    FrontToPusherWebSocketMessage,
    PositionMessage_Direction,
    PusherToFrontWebSocketMessage,
    type ServerToClientMessage,
} from "@workadventure/messages";
import { describe, expect, it, vi } from "vitest";

import type { AgentWorldEvent, RoomSocket, RoomSocketFactory, RoomSocketHandlers } from "../src/runtime/contracts";
import { WorkAdventureRoomClient } from "../src/runtime/workadventure-room-client";

class FakeRoomSocket implements RoomSocket {
    readonly sent: Uint8Array[] = [];

    public constructor(readonly handlers: RoomSocketHandlers) {}

    send(payload: Uint8Array): void {
        this.sent.push(payload);
    }

    close(code: number, reason: string): void {
        this.handlers.close(code, reason);
    }

    open(): void {
        this.handlers.open();
    }

    receive(nonce: number, message: ServerToClientMessage): void {
        this.handlers.message(PusherToFrontWebSocketMessage.encode({ nonce, message }).finish());
    }

    disconnect(code = 1006, reason = "network interruption"): void {
        this.handlers.close(code, reason);
    }
}

const requireItem = <Value>(value: Value | undefined, description: string): Value => {
    if (value === undefined) {
        throw new Error(`Missing ${description}`);
    }
    return value;
};

const decodeClientFrame = (payload: Uint8Array) => FrontToPusherWebSocketMessage.decode(payload);

const userJoinedBatch = (sayMessage?: string): ServerToClientMessage => ({
    message: {
        $case: "batchMessage",
        batchMessage: {
            event: "",
            payload: [
                {
                    message: {
                        $case: "userJoinedMessage",
                        userJoinedMessage: {
                            userId: 42,
                            name: "William",
                            characterTextures: [],
                            position: {
                                x: 120,
                                y: 220,
                                direction: PositionMessage_Direction.LEFT,
                                moving: false,
                            },
                            companionTexture: undefined,
                            visitCardUrl: "",
                            userUuid: "owner-1",
                            outlineColor: 0,
                            hasOutline: false,
                            availabilityStatus: AvailabilityStatus.ONLINE,
                            variables: {},
                            chatID: "human-chat",
                            sayMessage: sayMessage === undefined ? undefined : { message: sayMessage, type: 0 },
                        },
                    },
                },
            ],
        },
    },
});

describe("headless WorkAdventure room client", () => {
    it("joins with the configured identity, Woka textures, and spawn point", () => {
        const sockets: FakeRoomSocket[] = [];
        const urls: string[] = [];
        const protocols: string[][] = [];
        const socketFactory: RoomSocketFactory = (url, socketProtocols, handlers) => {
            urls.push(url);
            protocols.push(socketProtocols);
            const socket = new FakeRoomSocket(handlers);
            sockets.push(socket);
            return socket;
        };
        const client = new WorkAdventureRoomClient({
            agentId: "agent-1",
            token: "signed-workadventure-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Research Agent",
            textureIds: ["body-1", "eyes-2"],
            companionTextureId: "companion-1",
            spawn: { x: 64, y: 96 },
            onEvent: () => Promise.resolve(),
            socketFactory,
        });

        client.start();
        const socket = requireItem(sockets.at(0), "first socket");
        socket.open();

        const url = new URL(requireItem(urls.at(0), "room URL"));
        expect(url.searchParams.get("roomId")).toBe("https://play.example/_/global/maps.example/office.tmj");
        expect(url.searchParams.getAll("characterTextureIds")).toEqual(["body-1", "eyes-2"]);
        expect(url.searchParams.get("companionTextureId")).toBe("companion-1");
        expect(protocols.at(0)).toEqual(["signed-workadventure-token"]);

        const frame = decodeClientFrame(requireItem(socket.sent.at(0), "join frame"));
        expect(frame.nonce).toBe(1);
        expect(frame.message?.message).toMatchObject({
            $case: "joinRoomFrontMessage",
            joinRoomFrontMessage: {
                name: "Research Agent",
                positionMessage: { x: 64, y: 96, moving: false },
                availabilityStatus: AvailabilityStatus.ONLINE,
            },
        });

        client.say("Hello from Hermes");
        client.setStatus("busy");
        client.emote("wave");
        expect(decodeClientFrame(requireItem(socket.sent.at(1), "say frame")).message?.message).toMatchObject({
            $case: "setPlayerDetailsMessage",
            setPlayerDetailsMessage: { sayMessage: { message: "Hello from Hermes" } },
        });
        expect(decodeClientFrame(requireItem(socket.sent.at(2), "status frame")).message?.message).toMatchObject({
            $case: "setPlayerDetailsMessage",
            setPlayerDetailsMessage: { availabilityStatus: AvailabilityStatus.BUSY },
        });
        expect(decodeClientFrame(requireItem(socket.sent.at(3), "emote frame")).message?.message).toMatchObject({
            $case: "emotePromptMessage",
            emotePromptMessage: { emote: "wave" },
        });
    });

    it("deduplicates server frames, routes speech events, replies to ping, and replays after reconnect", async () => {
        vi.useFakeTimers();
        const sockets: FakeRoomSocket[] = [];
        const urls: string[] = [];
        const events: AgentWorldEvent[] = [];
        const socketFactory: RoomSocketFactory = (url, _protocols, handlers) => {
            urls.push(url);
            const socket = new FakeRoomSocket(handlers);
            sockets.push(socket);
            return socket;
        };
        const client = new WorkAdventureRoomClient({
            agentId: "agent-1",
            token: "signed-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Agent One",
            textureIds: ["body-1"],
            companionTextureId: null,
            spawn: { x: 10, y: 20 },
            onEvent: (event) => {
                events.push(event);
                return Promise.resolve();
            },
            socketFactory,
            reconnectDelayMs: 1,
        });

        client.start();
        const firstSocket = requireItem(sockets.at(0), "first socket");
        firstSocket.open();
        firstSocket.receive(1, userJoinedBatch("Hello agent"));
        firstSocket.receive(1, userJoinedBatch("This duplicate must be ignored"));
        firstSocket.receive(2, {
            message: {
                $case: "batchMessage",
                batchMessage: {
                    event: "",
                    payload: [{ message: { $case: "pingMessage", pingMessage: {} } }],
                },
            },
        });

        expect(events.filter((event) => event.type === "user.said")).toHaveLength(1);
        expect(events).toContainEqual(expect.objectContaining({ type: "user.said", text: "Hello agent" }));
        expect(decodeClientFrame(requireItem(firstSocket.sent.at(-1), "pong frame")).message?.message?.$case).toBe(
            "pingMessage",
        );

        firstSocket.disconnect();
        await vi.advanceTimersByTimeAsync(1);
        const secondSocket = requireItem(sockets.at(1), "reconnected socket");
        expect(new URL(requireItem(urls.at(1), "reconnect URL")).searchParams.get("lastReceivedNonce")).toBe("2");
        secondSocket.open();
        expect(secondSocket.sent.map((payload) => decodeClientFrame(payload).nonce)).toEqual([1, 2]);
        client.stop();
        vi.useRealTimers();
    });
});
