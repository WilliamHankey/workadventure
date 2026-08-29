import WebSocket, { type RawData } from "ws";

import type { RoomSocket, RoomSocketFactory, RoomSocketHandlers } from "./contracts";

const toBytes = (data: RawData): Uint8Array =>
    Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

class WsRoomSocket implements RoomSocket {
    private readonly socket: WebSocket;

    public constructor(url: string, protocols: string[], handlers: RoomSocketHandlers) {
        this.socket = new WebSocket(url, protocols);
        this.socket.on("open", () => handlers.open());
        this.socket.on("message", (data) => handlers.message(toBytes(data)));
        this.socket.on("close", (code, reason) => handlers.close(code, reason.toString("utf8")));
        this.socket.on("error", (error) => handlers.error(error));
    }

    send(payload: Uint8Array): void {
        this.socket.send(payload);
    }

    close(code: number, reason: string): void {
        this.socket.close(code, reason);
    }
}

export const createWsRoomSocket: RoomSocketFactory = (url, protocols, handlers) =>
    new WsRoomSocket(url, protocols, handlers);
