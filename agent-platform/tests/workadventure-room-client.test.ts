import {
    AvailabilityStatus,
    FrontToPusherWebSocketMessage,
    PositionMessage_Direction,
    PusherToFrontWebSocketMessage,
    RoomJoinedMessage,
    SpaceUser,
    type ServerToClientMessage,
} from "@workadventure/messages";
import { describe, expect, it, vi } from "vitest";

import type {
    AgentMediaInvitation,
    AgentWorldEvent,
    RoomSocket,
    RoomSocketFactory,
    RoomSocketHandlers,
} from "../src/runtime/contracts";
import { parseTiledNavigationGraph } from "../src/runtime/navigation-graph";
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

const userJoinedBatch = (sayMessage?: string, x = 120, y = 220): ServerToClientMessage => ({
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
                                x,
                                y,
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

const userMovedBatch = (x: number, y: number): ServerToClientMessage => ({
    message: {
        $case: "batchMessage",
        batchMessage: {
            event: "",
            payload: [
                {
                    message: {
                        $case: "userMovedMessage",
                        userMovedMessage: {
                            userId: 42,
                            position: {
                                x,
                                y,
                                direction: PositionMessage_Direction.RIGHT,
                                moving: true,
                            },
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
            ownerWorkAdventureUuid: "owner-1",
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
            ownerWorkAdventureUuid: "owner-1",
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

    it("accepts only the Hermes-approved invitation and binds LiveKit media to that human and space", async () => {
        const sockets: FakeRoomSocket[] = [];
        const events: AgentWorldEvent[] = [];
        const mediaInvitations: AgentMediaInvitation[] = [];
        const stoppedMedia: Array<{ mediaSessionId: string; reason: string }> = [];
        const client = new WorkAdventureRoomClient({
            agentId: "agent-voice",
            token: "signed-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Voice Agent",
            textureIds: ["body-1"],
            companionTextureId: null,
            spawn: { x: 16, y: 16 },
            ownerWorkAdventureUuid: "owner-1",
            onEvent: (event) => {
                events.push(event);
                return Promise.resolve();
            },
            onMediaInvitation: (invitation) => {
                mediaInvitations.push(invitation);
                return Promise.resolve();
            },
            onMediaStop: (mediaSessionId, reason) => {
                stoppedMedia.push({ mediaSessionId, reason });
                return Promise.resolve();
            },
            socketFactory: (_url, _protocols, handlers) => {
                const socket = new FakeRoomSocket(handlers);
                sockets.push(socket);
                return socket;
            },
        });

        client.start();
        const socket = requireItem(sockets.at(0), "voice socket");
        socket.open();
        socket.receive(1, {
            message: {
                $case: "meetingInvitationRequestReceivedMessage",
                meetingInvitationRequestReceivedMessage: {
                    senderUserUuid: "owner-1",
                    senderUserId: 42,
                    senderName: "William",
                    senderPlayUri: "https://play.example/_/global/maps.example/office.tmj",
                },
            },
        });
        expect(events).toContainEqual({
            type: "meeting.invitation",
            senderUserUuid: "owner-1",
            senderUserId: 42,
            senderName: "William",
            senderPlayUri: "https://play.example/_/global/maps.example/office.tmj",
        });
        expect(() => client.respondToMeetingInvitation("other-user", true)).toThrow(/No current meeting invitation/);

        client.respondToMeetingInvitation("owner-1", true);
        expect(socket.sent.slice(-2).map((payload) => decodeClientFrame(payload).message?.message?.$case)).toEqual([
            "meetingInvitationResponseMessage",
            "askPositionMessage",
        ]);

        socket.receive(2, {
            message: {
                $case: "joinSpaceRequestMessage",
                joinSpaceRequestMessage: { spaceName: "meeting-space", propertiesToSync: ["microphoneState"] },
            },
        });
        const joinQuery = decodeClientFrame(requireItem(socket.sent.at(-1), "join space query"));
        expect(joinQuery.message?.message).toMatchObject({
            $case: "queryMessage",
            queryMessage: { query: { $case: "joinSpaceQuery", joinSpaceQuery: { spaceName: "meeting-space" } } },
        });
        const queryId =
            joinQuery.message?.message?.$case === "queryMessage" ? joinQuery.message.message.queryMessage.id : 0;
        socket.receive(3, {
            message: {
                $case: "answerMessage",
                answerMessage: {
                    id: queryId,
                    answer: { $case: "joinSpaceAnswer", joinSpaceAnswer: { spaceUserId: "agent-space" } },
                },
            },
        });
        await Promise.resolve();
        socket.receive(4, {
            message: {
                $case: "batchMessage",
                batchMessage: {
                    event: "",
                    payload: [
                        {
                            message: {
                                $case: "initSpaceUsersMessage",
                                initSpaceUsersMessage: {
                                    spaceName: "meeting-space",
                                    metadata: "{}",
                                    users: [
                                        SpaceUser.fromPartial({
                                            spaceUserId: "human-space",
                                            uuid: "owner-1",
                                            name: "William",
                                            microphoneState: true,
                                        }),
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
        });
        socket.receive(5, {
            message: {
                $case: "batchMessage",
                batchMessage: {
                    event: "",
                    payload: [
                        {
                            message: {
                                $case: "privateEvent",
                                privateEvent: {
                                    spaceName: "meeting-space",
                                    receiverUserId: "agent-space",
                                    sender: SpaceUser.fromPartial({ spaceUserId: "agent-space", uuid: "agent-voice" }),
                                    spaceEvent: {
                                        event: {
                                            $case: "livekitInvitationMessage",
                                            livekitInvitationMessage: {
                                                serverUrl: "wss://livekit.example",
                                                token: "invitation-token",
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            },
        });
        await Promise.resolve();

        expect(mediaInvitations).toHaveLength(1);
        expect(mediaInvitations.at(0)).toMatchObject({
            spaceName: "meeting-space",
            serverUrl: "wss://livekit.example",
            token: "invitation-token",
            allowedParticipantIdentity: "human-space",
            allowedParticipantUuid: "owner-1",
        });
        client.setVoiceIndicator(true);
        expect(
            decodeClientFrame(requireItem(socket.sent.at(-1), "voice indicator frame")).message?.message,
        ).toMatchObject({
            $case: "updateSpaceUserMessage",
            updateSpaceUserMessage: {
                spaceName: "meeting-space",
                user: { spaceUserId: "agent-space", microphoneState: true, showVoiceIndicator: true },
            },
        });
        client.setCameraState(true);
        expect(decodeClientFrame(requireItem(socket.sent.at(-1), "camera state frame")).message?.message).toMatchObject(
            {
                $case: "updateSpaceUserMessage",
                updateSpaceUserMessage: {
                    spaceName: "meeting-space",
                    user: { spaceUserId: "agent-space", cameraState: true },
                },
            },
        );
        socket.receive(6, {
            message: {
                $case: "batchMessage",
                batchMessage: {
                    event: "",
                    payload: [
                        {
                            message: {
                                $case: "privateEvent",
                                privateEvent: {
                                    spaceName: "meeting-space",
                                    receiverUserId: "agent-space",
                                    sender: SpaceUser.fromPartial({ spaceUserId: "agent-space", uuid: "agent-voice" }),
                                    spaceEvent: {
                                        event: {
                                            $case: "livekitInvitationMessage",
                                            livekitInvitationMessage: {
                                                serverUrl: "wss://livekit.example",
                                                token: "replacement-token",
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(mediaInvitations).toHaveLength(2);
        expect(stoppedMedia).toEqual([
            { mediaSessionId: mediaInvitations[0]?.mediaSessionId, reason: "media_invitation_replaced" },
        ]);
        client.stop();
    });

    it("emits collision-aware movement frames and a typed completion observation", async () => {
        vi.useFakeTimers();
        const sockets: FakeRoomSocket[] = [];
        const events: AgentWorldEvent[] = [];
        const socketFactory: RoomSocketFactory = (_url, _protocols, handlers) => {
            const socket = new FakeRoomSocket(handlers);
            sockets.push(socket);
            return socket;
        };
        const navigationGraph = parseTiledNavigationGraph({
            orientation: "orthogonal",
            width: 3,
            height: 1,
            tilewidth: 32,
            tileheight: 32,
            tilesets: [],
            layers: [{ type: "tilelayer", width: 3, height: 1, data: [0, 0, 0] }],
        });
        const client = new WorkAdventureRoomClient({
            agentId: "agent-moving",
            token: "signed-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Moving Agent",
            textureIds: ["body-1"],
            companionTextureId: null,
            spawn: { x: 16, y: 16 },
            ownerWorkAdventureUuid: "owner-1",
            navigationGraph,
            movementStepMs: 10,
            onEvent: (event) => {
                events.push(event);
                return Promise.resolve();
            },
            socketFactory,
        });

        client.start();
        const socket = requireItem(sockets.at(0), "movement socket");
        socket.open();
        const resultPromise = client.moveTo(80, 16, "move-1");
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        const movementFrames = socket.sent
            .map(decodeClientFrame)
            .filter((frame) => frame.message?.message?.$case === "userMovesMessage");

        expect(result).toEqual({ actionId: "move-1", status: "completed", target: { x: 80, y: 16 } });
        expect(movementFrames.map((frame) => frame.message?.message)).toMatchObject([
            { userMovesMessage: { position: { x: 48, y: 16, moving: true } } },
            { userMovesMessage: { position: { x: 80, y: 16, moving: true } } },
            { userMovesMessage: { position: { x: 80, y: 16, moving: false } } },
        ]);
        expect(events).toContainEqual({
            type: "navigation.completed",
            actionId: "move-1",
            target: { x: 80, y: 16 },
        });
        client.stop();
        vi.useRealTimers();
    });

    it("cancels an in-flight route immediately when Hermes stops movement", async () => {
        vi.useFakeTimers();
        const sockets: FakeRoomSocket[] = [];
        const socketFactory: RoomSocketFactory = (_url, _protocols, handlers) => {
            const socket = new FakeRoomSocket(handlers);
            sockets.push(socket);
            return socket;
        };
        const navigationGraph = parseTiledNavigationGraph({
            orientation: "orthogonal",
            width: 5,
            height: 1,
            tilewidth: 32,
            tileheight: 32,
            tilesets: [],
            layers: [{ type: "tilelayer", width: 5, height: 1, data: [0, 0, 0, 0, 0] }],
        });
        const client = new WorkAdventureRoomClient({
            agentId: "agent-stopping",
            token: "signed-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Stopping Agent",
            textureIds: ["body-1"],
            companionTextureId: null,
            spawn: { x: 16, y: 16 },
            ownerWorkAdventureUuid: "owner-1",
            navigationGraph,
            movementStepMs: 1_000,
            onEvent: () => Promise.resolve(),
            socketFactory,
        });

        client.start();
        requireItem(sockets.at(0), "stop socket").open();
        const movement = client.moveTo(144, 16, "move-long");
        const stop = client.stopMoving("stop-1");
        await vi.runAllTimersAsync();

        await expect(movement).resolves.toMatchObject({ actionId: "move-long", status: "cancelled" });
        expect(stop).toMatchObject({ actionId: "stop-1", status: "cancelled", reason: "stopped_by_hermes" });
        client.stop();
        vi.useRealTimers();
    });

    it("keeps owner-follow binding across socket reconnect and replans after owner movement", async () => {
        vi.useFakeTimers();
        const sockets: FakeRoomSocket[] = [];
        const socketFactory: RoomSocketFactory = (_url, _protocols, handlers) => {
            const socket = new FakeRoomSocket(handlers);
            sockets.push(socket);
            return socket;
        };
        const navigationGraph = parseTiledNavigationGraph({
            orientation: "orthogonal",
            width: 6,
            height: 1,
            tilewidth: 32,
            tileheight: 32,
            tilesets: [],
            layers: [{ type: "tilelayer", width: 6, height: 1, data: [0, 0, 0, 0, 0, 0] }],
        });
        const client = new WorkAdventureRoomClient({
            agentId: "agent-following",
            token: "signed-token",
            pusherWebSocketUrl: new URL("ws://play.example/ws/room"),
            roomUrl: "https://play.example/_/global/maps.example/office.tmj",
            roomName: "Agent Office",
            displayName: "Following Agent",
            textureIds: ["body-1"],
            companionTextureId: null,
            spawn: { x: 16, y: 16 },
            ownerWorkAdventureUuid: "owner-1",
            navigationGraph,
            movementStepMs: 10,
            reconnectDelayMs: 1,
            onEvent: () => Promise.resolve(),
            socketFactory,
        });

        client.start();
        const firstSocket = requireItem(sockets.at(0), "first follow socket");
        firstSocket.open();
        firstSocket.receive(1, userJoinedBatch(undefined, 80, 16));
        const initialFollow = client.followUser("owner-1", 32, "follow-owner");
        await vi.runAllTimersAsync();
        await expect(initialFollow).resolves.toMatchObject({ status: "completed" });
        expect(client.getSelfState()).toMatchObject({ followingUserUuid: "owner-1", x: 48, y: 16 });

        firstSocket.disconnect();
        await vi.advanceTimersByTimeAsync(1);
        const secondSocket = requireItem(sockets.at(1), "second follow socket");
        secondSocket.open();
        secondSocket.receive(2, {
            message: {
                $case: "roomJoinedMessage",
                roomJoinedMessage: RoomJoinedMessage.fromPartial({ currentUserId: 9 }),
            },
        });
        secondSocket.receive(3, userMovedBatch(144, 16));
        await vi.runAllTimersAsync();

        expect(client.getSelfState()).toMatchObject({ followingUserUuid: "owner-1", x: 112, y: 16 });
        client.stop();
        vi.useRealTimers();
    });
});
