import type { AvailabilityStatus, PositionMessage_Direction } from "@workadventure/messages";

export interface AgentIdentityProvider {
    issueToken(agentId: string, displayName: string): Promise<string>;
}

export interface RoomSocketHandlers {
    open(): void;
    message(payload: Uint8Array): void;
    close(code: number, reason: string): void;
    error(error: Error): void;
}

export interface RoomSocket {
    send(payload: Uint8Array): void;
    close(code: number, reason: string): void;
}

export type RoomSocketFactory = (url: string, protocols: string[], handlers: RoomSocketHandlers) => RoomSocket;

export interface NearbyUser {
    userId: number;
    userUuid: string;
    name: string;
    x: number;
    y: number;
    direction: PositionMessage_Direction;
    moving: boolean;
    availabilityStatus: AvailabilityStatus;
}

export interface AgentMediaInvitation {
    mediaSessionId: string;
    spaceName: string;
    serverUrl: string;
    token: string;
    allowedParticipantIdentity: string;
    allowedParticipantUuid: string;
}

export type AgentMediaInvitationHandler = (invitation: AgentMediaInvitation) => Promise<void>;

export type AgentWorldEvent =
    | { type: "user.joined"; user: NearbyUser }
    | { type: "user.left"; user: NearbyUser }
    | { type: "user.moved"; user: NearbyUser }
    | { type: "user.said"; user: NearbyUser; text: string }
    | { type: "user.emoted"; user: NearbyUser; emote: string }
    | {
          type: "meeting.invitation";
          senderUserUuid: string;
          senderUserId: number | null;
          senderName: string;
          senderPlayUri: string;
      }
    | { type: "meeting.joined"; spaceName: string; inviterUuid: string }
    | { type: "meeting.left"; spaceName: string; reason: string }
    | { type: "room.joined"; userId: number }
    | {
          type: "navigation.completed" | "navigation.failed" | "navigation.cancelled";
          actionId: string;
          target: { x: number; y: number };
          reason?: string;
      }
    | { type: "connection.degraded"; reason: string };

export type AgentWorldEventHandler = (event: AgentWorldEvent) => Promise<void>;
