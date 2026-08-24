import {
    AvailabilityStatus,
    apiVersionHash,
    FrontToPusherWebSocketMessage,
    PositionMessage_Direction,
    PusherToFrontWebSocketMessage,
    SayMessageType,
    SetPlayerDetailsMessage,
    type ClientToServerMessage,
    type ServerToClientMessage,
    type SubMessage,
    type UserJoinedMessage,
} from "@workadventure/messages";

import type {
    AgentWorldEventHandler,
    NearbyUser,
    RoomSocket,
    RoomSocketFactory,
    RoomSocketHandlers,
} from "./contracts";
import type { NavigationGraph, PixelPoint } from "./navigation-graph";
import { createWsRoomSocket } from "./ws-room-socket";

export interface WorkAdventureRoomClientOptions {
    agentId: string;
    token: string;
    pusherWebSocketUrl: URL;
    roomUrl: string;
    roomName: string;
    displayName: string;
    textureIds: string[];
    companionTextureId: string | null;
    spawn: { x: number; y: number };
    ownerWorkAdventureUuid: string;
    navigationGraph?: NavigationGraph;
    onEvent: AgentWorldEventHandler;
    socketFactory?: RoomSocketFactory;
    reconnectDelayMs?: number;
    movementStepMs?: number;
    movementTimeoutMs?: number;
}

interface StoredFrame {
    payload: Uint8Array;
    createdAt: number;
}

const OUTGOING_RETENTION_MS = 30_000;

const statusByName = {
    online: AvailabilityStatus.ONLINE,
    silent: AvailabilityStatus.SILENT,
    away: AvailabilityStatus.AWAY,
    busy: AvailabilityStatus.BUSY,
    do_not_disturb: AvailabilityStatus.DO_NOT_DISTURB,
    back_in_a_moment: AvailabilityStatus.BACK_IN_A_MOMENT,
} as const;

export type AgentAvailabilityName = keyof typeof statusByName;

export interface NavigationOutcome {
    actionId: string;
    status: "completed" | "failed" | "cancelled";
    target: PixelPoint;
    reason?: string;
}

interface ActiveMovement {
    actionId: string;
    cancelled: boolean;
}

interface FollowTarget {
    actionId: string;
    userUuid: string;
    distance: number;
}

export class WorkAdventureRoomClient {
    private readonly users = new Map<number, NearbyUser>();
    private readonly outgoingFrames = new Map<number, StoredFrame>();
    private readonly socketFactory: RoomSocketFactory;
    private socket: RoomSocket | undefined;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    private manuallyClosed = false;
    private openedOnce = false;
    private nextOutgoingNonce = 1;
    private lastReceivedNonce = 0;
    private currentUserId: number | undefined;
    private position: PixelPoint;
    private direction = PositionMessage_Direction.DOWN;
    private activeMovement: ActiveMovement | undefined;
    private followTarget: FollowTarget | undefined;
    private followRevision = 0;

    public constructor(private readonly options: WorkAdventureRoomClientOptions) {
        this.socketFactory = options.socketFactory ?? createWsRoomSocket;
        this.position = { ...options.spawn };
    }

    start(): void {
        if (this.socket !== undefined || this.manuallyClosed) {
            return;
        }
        this.connect();
    }

    stop(): void {
        this.manuallyClosed = true;
        if (this.reconnectTimeout !== undefined) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        this.socket?.close(1000, "Hermes agent runtime stopped");
        this.socket = undefined;
    }

    say(text: string): void {
        this.send({
            message: {
                $case: "setPlayerDetailsMessage",
                setPlayerDetailsMessage: SetPlayerDetailsMessage.fromPartial({
                    sayMessage: { message: text, type: SayMessageType.SpeechBubble },
                }),
            },
        });
    }

    setStatus(status: AgentAvailabilityName): void {
        this.send({
            message: {
                $case: "setPlayerDetailsMessage",
                setPlayerDetailsMessage: SetPlayerDetailsMessage.fromPartial({
                    availabilityStatus: statusByName[status],
                }),
            },
        });
    }

    emote(emote: string): void {
        this.send({ message: { $case: "emotePromptMessage", emotePromptMessage: { emote } } });
    }

    moveTo(x: number, y: number, actionId: string): Promise<NavigationOutcome> {
        return this.navigate({ x, y }, actionId);
    }

    moveToArea(areaName: string, actionId: string): Promise<NavigationOutcome> {
        const graph = this.requireNavigationGraph();
        return this.navigate(graph.targetForArea(areaName, this.position), actionId);
    }

    approachUser(userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome> {
        return this.navigate(this.approachTarget(userUuid, distance), actionId);
    }

    async followUser(userUuid: string, distance: number, actionId: string): Promise<NavigationOutcome> {
        this.followTarget = { userUuid, distance, actionId };
        const result = await this.navigate(this.approachTarget(userUuid, distance), actionId, true);
        if (result.status === "failed" && this.followTarget?.actionId === actionId) {
            this.followTarget = undefined;
        }
        return result;
    }

    stopMoving(actionId: string): NavigationOutcome {
        const hadFollowTarget = this.followTarget !== undefined;
        this.followTarget = undefined;
        if (this.activeMovement !== undefined) {
            this.activeMovement.cancelled = true;
            if (this.socket !== undefined) {
                this.sendPosition(this.position, false);
            }
        }
        const result: NavigationOutcome = {
            actionId,
            status: hadFollowTarget || this.activeMovement !== undefined ? "cancelled" : "completed",
            target: { ...this.position },
            reason: hadFollowTarget || this.activeMovement !== undefined ? "stopped_by_hermes" : "already_stopped",
        };
        if (this.activeMovement === undefined && result.status === "cancelled") {
            this.emitNavigation(result);
        }
        return result;
    }

    getSelfState(): Record<string, unknown> {
        return {
            agentId: this.options.agentId,
            userId: this.currentUserId ?? null,
            roomUrl: this.options.roomUrl,
            connected: this.socket !== undefined,
            x: this.position.x,
            y: this.position.y,
            direction: this.direction,
            moving: this.activeMovement !== undefined,
            followingUserUuid: this.followTarget?.userUuid ?? null,
            ownerWorkAdventureUuid: this.options.ownerWorkAdventureUuid,
            owner: this.ownerState(),
        };
    }

    getNearbyUsers(): NearbyUser[] {
        return [...this.users.values()].map((user) => structuredClone(user));
    }

    getMapAreas(): unknown[] {
        return this.options.navigationGraph?.listAreas() ?? [];
    }

    private connect(): void {
        const handlers: RoomSocketHandlers = {
            open: () => this.handleOpen(),
            message: (payload) => this.handleMessage(payload),
            close: (code, reason) => this.handleClose(code, reason),
            error: (error) => this.emit({ type: "connection.degraded", reason: error.message }),
        };
        this.socket = this.socketFactory(this.buildSocketUrl(), [this.options.token], handlers);
    }

    private buildSocketUrl(): string {
        const url = new URL(this.options.pusherWebSocketUrl);
        url.searchParams.set("roomId", this.options.roomUrl);
        for (const textureId of this.options.textureIds) {
            url.searchParams.append("characterTextureIds", textureId);
        }
        if (this.options.companionTextureId !== null) {
            url.searchParams.set("companionTextureId", this.options.companionTextureId);
        }
        url.searchParams.set("version", apiVersionHash);
        url.searchParams.set("chatID", `agent:${this.options.agentId}`);
        url.searchParams.set("roomName", this.options.roomName);
        url.searchParams.set("cameraState", "false");
        url.searchParams.set("microphoneState", "false");
        url.searchParams.set("tabId", `hermes-agent-${this.options.agentId}`);
        if (this.openedOnce) {
            url.searchParams.set("lastReceivedNonce", String(this.lastReceivedNonce));
        }
        return url.toString();
    }

    private handleOpen(): void {
        if (this.openedOnce) {
            this.pruneOutgoingFrames();
            for (const frame of this.outgoingFrames.values()) {
                this.socket?.send(frame.payload);
            }
            return;
        }
        this.openedOnce = true;
        this.send({
            message: {
                $case: "joinRoomFrontMessage",
                joinRoomFrontMessage: {
                    name: this.options.displayName,
                    positionMessage: {
                        x: this.options.spawn.x,
                        y: this.options.spawn.y,
                        direction: PositionMessage_Direction.DOWN,
                        moving: false,
                    },
                    viewportMessage: this.viewportFor(this.options.spawn.x, this.options.spawn.y),
                    availabilityStatus: AvailabilityStatus.ONLINE,
                },
            },
        });
    }

    private handleClose(code: number, reason: string): void {
        this.socket = undefined;
        if (this.manuallyClosed || code === 1000 || code === 1008) {
            return;
        }
        this.emit({ type: "connection.degraded", reason: reason || `socket_closed_${String(code)}` });
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this.connect();
        }, this.options.reconnectDelayMs ?? 500);
    }

    private handleMessage(payload: Uint8Array): void {
        let frame;
        try {
            frame = PusherToFrontWebSocketMessage.decode(payload);
        } catch {
            this.emit({ type: "connection.degraded", reason: "invalid_server_frame" });
            this.socket?.close(1003, "Invalid WorkAdventure server frame");
            return;
        }
        if (frame.nonce <= this.lastReceivedNonce || frame.message === undefined) {
            return;
        }
        this.lastReceivedNonce = frame.nonce;
        this.handleServerMessage(frame.message);
    }

    private handleServerMessage(message: ServerToClientMessage): void {
        const inner = message.message;
        if (inner === undefined) {
            return;
        }
        if (inner.$case === "roomJoinedMessage") {
            this.currentUserId = inner.roomJoinedMessage.currentUserId;
            this.emit({ type: "room.joined", userId: inner.roomJoinedMessage.currentUserId });
            this.continueFollowing();
            return;
        }
        if (inner.$case === "batchMessage") {
            for (const subMessage of inner.batchMessage.payload) {
                this.handleSubMessage(subMessage);
            }
            return;
        }
        if (inner.$case === "duplicateUserConnectedMessage") {
            this.emit({ type: "connection.degraded", reason: "duplicate_user_connected" });
        }
    }

    private handleSubMessage(wrapper: SubMessage): void {
        const message = wrapper.message;
        if (message === undefined) {
            return;
        }
        switch (message.$case) {
            case "pingMessage": {
                this.send({ message: { $case: "pingMessage", pingMessage: {} } });
                break;
            }
            case "userJoinedMessage": {
                const user = this.userFromJoined(message.userJoinedMessage);
                this.users.set(user.userId, user);
                this.emit({ type: "user.joined", user });
                this.continueFollowing(user.userUuid);
                if (message.userJoinedMessage.sayMessage?.message) {
                    this.emit({ type: "user.said", user, text: message.userJoinedMessage.sayMessage.message });
                }
                break;
            }
            case "userLeftMessage": {
                const user = this.users.get(message.userLeftMessage.userId);
                if (user !== undefined) {
                    this.users.delete(user.userId);
                    this.emit({ type: "user.left", user });
                }
                break;
            }
            case "userMovedMessage": {
                const current = this.users.get(message.userMovedMessage.userId);
                const position = message.userMovedMessage.position;
                if (current !== undefined && position !== undefined) {
                    const user = { ...current, ...position };
                    this.users.set(user.userId, user);
                    this.emit({ type: "user.moved", user });
                    this.continueFollowing(user.userUuid);
                }
                break;
            }
            case "playerDetailsUpdatedMessage": {
                const current = this.users.get(message.playerDetailsUpdatedMessage.userId);
                const details = message.playerDetailsUpdatedMessage.details;
                if (current !== undefined && details !== undefined) {
                    const user = {
                        ...current,
                        availabilityStatus:
                            details.availabilityStatus === AvailabilityStatus.UNCHANGED
                                ? current.availabilityStatus
                                : details.availabilityStatus,
                    };
                    this.users.set(user.userId, user);
                    if (details.sayMessage?.message) {
                        this.emit({ type: "user.said", user, text: details.sayMessage.message });
                    }
                }
                break;
            }
            case "emoteEventMessage": {
                const user = this.users.get(message.emoteEventMessage.actorUserId);
                if (user !== undefined) {
                    this.emit({ type: "user.emoted", user, emote: message.emoteEventMessage.emote });
                }
                break;
            }
            default: {
                break;
            }
        }
    }

    private userFromJoined(message: UserJoinedMessage): NearbyUser {
        const position = message.position ?? {
            x: 0,
            y: 0,
            direction: PositionMessage_Direction.DOWN,
            moving: false,
        };
        return {
            userId: message.userId,
            userUuid: message.userUuid,
            name: message.name,
            x: position.x,
            y: position.y,
            direction: position.direction,
            moving: position.moving,
            availabilityStatus: message.availabilityStatus,
        };
    }

    private requireNavigationGraph(): NavigationGraph {
        if (this.options.navigationGraph === undefined) {
            throw new Error("No validated navigation graph is available for this map");
        }
        return this.options.navigationGraph;
    }

    private ownerState(): NearbyUser | null {
        const owner = [...this.users.values()].find(
            (candidate) => candidate.userUuid === this.options.ownerWorkAdventureUuid,
        );
        return owner === undefined ? null : structuredClone(owner);
    }

    private userByUuid(userUuid: string): NearbyUser {
        const user = [...this.users.values()].find((candidate) => candidate.userUuid === userUuid);
        if (user === undefined) {
            throw new Error(`User '${userUuid}' is not present in this room`);
        }
        return user;
    }

    private approachTarget(userUuid: string, distance: number): PixelPoint {
        const user = this.userByUuid(userUuid);
        const deltaX = this.position.x - user.x;
        const deltaY = this.position.y - user.y;
        const currentDistance = Math.hypot(deltaX, deltaY);
        if (currentDistance <= distance) {
            return { ...this.position };
        }
        const ratio = distance / currentDistance;
        return { x: user.x + deltaX * ratio, y: user.y + deltaY * ratio };
    }

    private async navigate(target: PixelPoint, actionId: string, preserveFollow = false): Promise<NavigationOutcome> {
        const graph = this.requireNavigationGraph();
        if (!preserveFollow) {
            this.followTarget = undefined;
        }
        if (this.activeMovement !== undefined) {
            this.activeMovement.cancelled = true;
        }
        const movement: ActiveMovement = { actionId, cancelled: false };
        this.activeMovement = movement;
        const startedAt = Date.now();
        let outcome: NavigationOutcome;
        try {
            const path = graph.findPath(this.position, target);
            for (const waypoint of path) {
                if (movement.cancelled) {
                    outcome = { actionId, status: "cancelled", target, reason: "movement_replaced_or_stopped" };
                    this.sendPosition(this.position, false);
                    this.emitNavigation(outcome);
                    return outcome;
                }
                if (Date.now() - startedAt > (this.options.movementTimeoutMs ?? 30_000)) {
                    throw new Error("Movement timed out before reaching the target");
                }
                this.sendPosition(waypoint, true);
                // Movement frames must be paced in path order.
                // eslint-disable-next-line no-await-in-loop
                await this.waitForMovementStep();
            }
            this.sendPosition(this.position, false);
            outcome = { actionId, status: "completed", target: { ...this.position } };
        } catch (error: unknown) {
            outcome = {
                actionId,
                status: movement.cancelled ? "cancelled" : "failed",
                target,
                reason: error instanceof Error ? error.message : "Unknown navigation error",
            };
        } finally {
            if (this.activeMovement === movement) {
                this.activeMovement = undefined;
            }
        }
        this.emitNavigation(outcome);
        return outcome;
    }

    private sendPosition(next: PixelPoint, moving: boolean): void {
        const deltaX = next.x - this.position.x;
        const deltaY = next.y - this.position.y;
        if (Math.abs(deltaX) >= Math.abs(deltaY) && deltaX !== 0) {
            this.direction = deltaX > 0 ? PositionMessage_Direction.RIGHT : PositionMessage_Direction.LEFT;
        } else if (deltaY !== 0) {
            this.direction = deltaY > 0 ? PositionMessage_Direction.DOWN : PositionMessage_Direction.UP;
        }
        this.position = { ...next };
        this.send({
            message: {
                $case: "userMovesMessage",
                userMovesMessage: {
                    position: { x: next.x, y: next.y, direction: this.direction, moving },
                    viewport: this.viewportFor(next.x, next.y),
                },
            },
        });
    }

    private waitForMovementStep(): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, this.options.movementStepMs ?? 100);
        });
    }

    private continueFollowing(changedUserUuid?: string): void {
        const follow = this.followTarget;
        if (
            follow === undefined ||
            this.activeMovement !== undefined ||
            (changedUserUuid !== undefined && changedUserUuid !== follow.userUuid)
        ) {
            return;
        }
        let target: PixelPoint;
        try {
            target = this.approachTarget(follow.userUuid, follow.distance);
        } catch {
            return;
        }
        if (Math.hypot(target.x - this.position.x, target.y - this.position.y) < Math.max(8, follow.distance / 4)) {
            return;
        }
        this.followRevision += 1;
        const actionId = `${follow.actionId}:replan:${String(this.followRevision)}`;
        this.navigate(target, actionId, true)
            .then(() => this.continueFollowing(follow.userUuid))
            .catch(() => undefined);
    }

    private emitNavigation(outcome: NavigationOutcome): void {
        this.emit({
            type: `navigation.${outcome.status}`,
            actionId: outcome.actionId,
            target: outcome.target,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
    }

    private send(message: ClientToServerMessage): void {
        if (this.socket === undefined) {
            throw new Error("WorkAdventure room socket is not connected");
        }
        const nonce = this.nextOutgoingNonce;
        this.nextOutgoingNonce += 1;
        const payload = FrontToPusherWebSocketMessage.encode({ nonce, message }).finish();
        this.outgoingFrames.set(nonce, { payload, createdAt: Date.now() });
        this.pruneOutgoingFrames();
        this.socket.send(payload);
    }

    private pruneOutgoingFrames(): void {
        const cutoff = Date.now() - OUTGOING_RETENTION_MS;
        for (const [nonce, frame] of this.outgoingFrames.entries()) {
            if (frame.createdAt < cutoff) {
                this.outgoingFrames.delete(nonce);
            }
        }
    }

    private viewportFor(x: number, y: number): { left: number; top: number; right: number; bottom: number } {
        return { left: x - 400, top: y - 300, right: x + 400, bottom: y + 300 };
    }

    private emit(event: Parameters<AgentWorldEventHandler>[0]): void {
        this.options.onEvent(event).catch(() => undefined);
    }
}
