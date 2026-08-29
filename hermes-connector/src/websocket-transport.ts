import WebSocket, { type RawData } from "ws";

import type { ConnectorTransport } from "./contracts";

interface TransportOptions {
    url: string;
    registrationToken: string;
    minimumReconnectDelayMs?: number;
    maximumReconnectDelayMs?: number;
}

export class OutboundWebSocketTransport implements ConnectorTransport {
    private socket: WebSocket | undefined;
    private openHandler: (() => Promise<void>) | undefined;
    private messageHandler: ((message: unknown) => Promise<void>) | undefined;
    private manuallyClosed = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: TransportOptions) {}

    onOpen(handler: () => Promise<void>): void {
        this.openHandler = handler;
    }

    onMessage(handler: (message: unknown) => Promise<void>): void {
        this.messageHandler = handler;
    }

    async connect(): Promise<void> {
        this.manuallyClosed = false;
        await this.openSocket();
    }

    async send(message: unknown): Promise<void> {
        const socket = this.socket;
        if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
            throw new Error("The connector WebSocket is not open");
        }
        await new Promise<void>((resolve, reject) => {
            socket.send(JSON.stringify(message), (error) => {
                if (error === undefined || error === null) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    async close(): Promise<void> {
        this.manuallyClosed = true;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
        }
        const socket = this.socket;
        if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
            return;
        }
        await new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close(1000, "Connector stopped");
        });
    }

    private async openSocket(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(this.options.url, {
                headers: { authorization: `Bearer ${this.options.registrationToken}` },
            });
            this.socket = socket;
            const initialError = (error: Error): void => reject(error);
            socket.once("error", initialError);
            socket.once("open", () => {
                socket.off("error", initialError);
                this.reconnectAttempt = 0;
                socket.on("message", (data) => this.handleRawMessage(data));
                socket.on("close", () => this.scheduleReconnect());
                socket.on("error", () => undefined);
                const opened = this.openHandler?.() ?? Promise.resolve();
                opened.then(resolve).catch(reject);
            });
        });
    }

    private handleRawMessage(data: RawData): void {
        const handler = this.messageHandler;
        if (handler === undefined) {
            return;
        }
        try {
            const serialized = Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : data instanceof ArrayBuffer
                  ? Buffer.from(new Uint8Array(data)).toString("utf8")
                  : data.toString("utf8");
            const value: unknown = JSON.parse(serialized);
            handler(value).catch(() => undefined);
        } catch {
            this.socket?.close(1008, "Invalid connector message");
        }
    }

    private scheduleReconnect(): void {
        if (this.manuallyClosed) {
            return;
        }
        const minimum = this.options.minimumReconnectDelayMs ?? 500;
        const maximum = this.options.maximumReconnectDelayMs ?? 30_000;
        const delay = Math.min(maximum, minimum * 2 ** this.reconnectAttempt);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.openSocket().catch(() => this.scheduleReconnect());
        }, delay);
    }
}
