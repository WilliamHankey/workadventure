import { z } from "zod/v4";
import type { Pool, PoolClient } from "pg";

const PutPayloadSchema = z.object({
    path: z.string().min(1),
    contentType: z.string().min(1),
    contentBase64: z.string(),
});
const DeletePayloadSchema = z.object({ path: z.string().min(1) });
const MovePayloadSchema = z.object({ source: z.string().min(1), destination: z.string().min(1) });

interface OutboxRow {
    sequence: string;
    operation: "put" | "delete" | "move";
    payload: unknown;
    attempts: number;
}

export interface MapStorageOperation {
    operation: "put" | "delete" | "move";
    payload: unknown;
}

const safePath = (path: string): string =>
    path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

export class WorkAdventureMapStorageClient {
    private readonly endpoint: URL;

    constructor(
        endpoint: URL,
        private readonly authorizationHeader: string,
        private readonly timeoutMs = 15_000,
    ) {
        if (!/^Basic [A-Za-z0-9+/=]+$/.test(authorizationHeader)) {
            throw new Error("Map Storage authorization must be an HTTP Basic header");
        }
        this.endpoint = new URL(endpoint.toString());
        if (!this.endpoint.pathname.endsWith("/")) this.endpoint.pathname += "/";
    }

    async execute(event: MapStorageOperation): Promise<void> {
        if (event.operation === "put") {
            const payload = PutPayloadSchema.parse(event.payload);
            const bytes = new Uint8Array(Buffer.from(payload.contentBase64, "base64"));
            if (payload.contentType === "application/json" || payload.contentType.endsWith("+json")) {
                await this.request(safePath(payload.path), {
                    method: "PUT",
                    headers: { "content-type": payload.contentType },
                    body: bytes,
                });
            } else {
                const form = new FormData();
                form.append(
                    "file",
                    new Blob([bytes], { type: payload.contentType }),
                    payload.path.split("/").at(-1) ?? "asset",
                );
                await this.request(safePath(payload.path), { method: "PUT", body: form });
            }
            return;
        }
        if (event.operation === "delete") {
            const payload = DeletePayloadSchema.parse(event.payload);
            await this.request(safePath(payload.path), { method: "DELETE" }, true);
            return;
        }
        const payload = MovePayloadSchema.parse(event.payload);
        await this.request("move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    private async request(path: string, init: RequestInit, allowNotFound = false): Promise<void> {
        const response = await fetch(new URL(path, this.endpoint), {
            ...init,
            headers: { ...init.headers, authorization: this.authorizationHeader },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok || (allowNotFound && response.status === 404)) return;
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Map Storage ${init.method ?? "GET"} failed with HTTP ${String(response.status)}`);
    }
}

export class MapStorageOutboxWorker {
    private timer: ReturnType<typeof setInterval> | undefined;
    private active: Promise<void> | undefined;

    constructor(
        private readonly pool: Pool,
        private readonly mapStorage: WorkAdventureMapStorageClient,
        private readonly pollIntervalMs = 1_000,
        private readonly maxAttempts = 10,
    ) {}

    start(): void {
        if (this.timer !== undefined) return;
        this.trigger();
        this.timer = setInterval(() => this.trigger(), this.pollIntervalMs);
    }

    async stop(): Promise<void> {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        await this.active?.catch(() => undefined);
    }

    async healthCheck(): Promise<void> {
        const result = await this.pool.query<{ failed: string }>(
            "SELECT count(*) AS failed FROM agent_platform_map_storage_outbox WHERE attempts >= $1",
            [this.maxAttempts],
        );
        if (Number(result.rows[0]?.failed ?? 0) > 0)
            throw new Error("Map Storage synchronization has exhausted retries");
    }

    private trigger(): void {
        if (this.active !== undefined) return;
        this.active = this.processOne()
            .catch(() => undefined)
            .finally(() => {
                this.active = undefined;
            });
    }

    private async processOne(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query<OutboxRow>(
                "SELECT sequence, operation, payload, attempts FROM agent_platform_map_storage_outbox WHERE sequence = (SELECT min(sequence) FROM agent_platform_map_storage_outbox) AND available_at <= now() AND attempts < $1 FOR UPDATE SKIP LOCKED",
                [this.maxAttempts],
            );
            const event = result.rows[0];
            if (event === undefined) {
                await client.query("COMMIT");
                return;
            }
            try {
                await this.mapStorage.execute({ operation: event.operation, payload: event.payload });
                await client.query("DELETE FROM agent_platform_map_storage_outbox WHERE sequence = $1", [
                    event.sequence,
                ]);
            } catch (error: unknown) {
                await this.recordFailure(client, event, error);
            }
            await client.query("COMMIT");
        } catch (error: unknown) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async recordFailure(client: PoolClient, event: OutboxRow, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : "Unknown Map Storage synchronization error";
        const attempts = event.attempts + 1;
        const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
        await client.query(
            "UPDATE agent_platform_map_storage_outbox SET attempts = $2, available_at = now() + ($3 * interval '1 second'), last_error = $4 WHERE sequence = $1",
            [event.sequence, attempts, delaySeconds, message.slice(0, 500)],
        );
    }
}
