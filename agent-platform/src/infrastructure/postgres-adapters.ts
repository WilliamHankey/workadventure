import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

import type { AuditEvent, AuditSink, RegistryRepository } from "../domain/contracts";
import { ConflictError, NotFoundError, VersionConflictError } from "../domain/errors";
import {
    AgentRecordSchema,
    MapAssetSchema,
    MapContentSchema,
    MapRecordSchema,
    type AgentRecord,
    type AgentRuntimeStatus,
    type CreateAgentInput,
    type CreateMapInput,
    type MapAsset,
    type MapContent,
    type MapRecord,
    type PutMapAssetInput,
    type PutMapContentInput,
    type UpdateAgentInput,
    type UpdateMapInput,
} from "../domain/schemas";
import type { IdempotencyStore } from "../services/idempotency-store";

interface JsonRecordRow {
    record: unknown;
}

interface IdempotencyRow {
    fingerprint: string;
    response: unknown;
}

interface PostgresError {
    code?: string;
    constraint?: string;
}

const isPostgresError = (error: unknown): error is PostgresError => typeof error === "object" && error !== null;

const requireRow = <Row>(rows: Row[], resource: string, id: string): Row => {
    const row = rows[0];
    if (row === undefined) throw new NotFoundError(resource, id);
    return row;
};

const requireVersion = (resource: string, expected: number, actual: number): void => {
    if (expected !== actual) throw new VersionConflictError(resource, expected, actual);
};

const assetChecksum = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export const runPostgresMigrations = async (pool: Pool): Promise<void> => {
    const migration = await readFile(new URL("../../migrations/001_initial.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('workadventure-agent-platform-migrations'))");
        await client.query("BEGIN");
        await client.query(migration);
        await client.query(
            "INSERT INTO agent_platform_schema_migrations(version) VALUES($1) ON CONFLICT (version) DO NOTHING",
            ["001_initial"],
        );
        await client.query("COMMIT");
    } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        await client
            .query("SELECT pg_advisory_unlock(hashtext('workadventure-agent-platform-migrations'))")
            .catch(() => undefined);
        client.release();
    }
};

export class PostgresRegistryRepository implements RegistryRepository {
    constructor(private readonly pool: Pool) {}

    async healthCheck(): Promise<void> {
        await this.pool.query("SELECT 1");
    }

    async listMaps(): Promise<MapRecord[]> {
        const result = await this.pool.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_maps ORDER BY created_at, id",
        );
        return result.rows.map((row) => MapRecordSchema.parse(row.record));
    }

    async getMap(id: string): Promise<MapRecord> {
        const result = await this.pool.query<JsonRecordRow>("SELECT record FROM agent_platform_maps WHERE id = $1", [
            id,
        ]);
        return MapRecordSchema.parse(requireRow(result.rows, "Map", id).record);
    }

    async createMap(input: CreateMapInput): Promise<MapRecord> {
        const id = randomUUID();
        const now = new Date().toISOString();
        const record: MapRecord = {
            id,
            name: input.name,
            slug: input.slug,
            roomUrl: input.roomUrl,
            description: input.description,
            state: input.state,
            entryPoints: structuredClone(input.entryPoints),
            validationState: input.initialContent === undefined ? "pending" : "valid",
            validationErrors: [],
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
        try {
            await this.transaction(async (client) => {
                await client.query(
                    "INSERT INTO agent_platform_maps(id, slug, record, created_at, updated_at) VALUES($1, $2, $3::jsonb, $4, $4)",
                    [id, record.slug, JSON.stringify(record), now],
                );
                if (input.initialContent !== undefined) {
                    const content: MapContent = {
                        mapId: id,
                        format: input.initialContent.format,
                        document: structuredClone(input.initialContent.document),
                        version: 1,
                        updatedAt: now,
                    };
                    await client.query(
                        "INSERT INTO agent_platform_map_contents(map_id, record, updated_at) VALUES($1, $2::jsonb, $3)",
                        [id, JSON.stringify(content), now],
                    );
                    await this.enqueueMapStorage(client, "put", {
                        path: this.mapContentPath(record.slug, content.format),
                        contentType: "application/json",
                        contentBase64: Buffer.from(JSON.stringify(content.document)).toString("base64"),
                    });
                }
            });
        } catch (error: unknown) {
            this.translateUnique(error, "map_slug_conflict", `Map slug '${input.slug}' is already in use`);
        }
        return record;
    }

    async updateMap(id: string, expectedVersion: number, input: UpdateMapInput): Promise<MapRecord> {
        return this.transaction(async (client) => {
            const current = await this.lockMap(client, id);
            requireVersion("Map", expectedVersion, current.version);
            const updated: MapRecord = {
                ...current,
                ...structuredClone(input),
                version: current.version + 1,
                updatedAt: new Date().toISOString(),
            };
            try {
                await client.query(
                    "UPDATE agent_platform_maps SET slug = $2, record = $3::jsonb, updated_at = $4 WHERE id = $1",
                    [id, updated.slug, JSON.stringify(updated), updated.updatedAt],
                );
                if (updated.slug !== current.slug) {
                    await this.enqueueMapStorage(client, "move", {
                        source: current.slug,
                        destination: updated.slug,
                    });
                }
            } catch (error: unknown) {
                this.translateUnique(error, "map_slug_conflict", `Map slug '${updated.slug}' is already in use`);
            }
            return updated;
        });
    }

    async deleteMap(id: string, expectedVersion: number): Promise<void> {
        await this.transaction(async (client) => {
            const current = await this.lockMap(client, id);
            requireVersion("Map", expectedVersion, current.version);
            const referenced = await client.query<{ exists: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM agent_platform_agents WHERE map_id = $1) AS exists",
                [id],
            );
            if (referenced.rows[0]?.exists === true) {
                throw new ConflictError("map_in_use", "Map cannot be deleted while agent definitions reference it");
            }
            await this.enqueueMapStorage(client, "delete", { path: current.slug });
            await client.query("DELETE FROM agent_platform_maps WHERE id = $1", [id]);
        });
    }

    async getMapContent(mapId: string): Promise<MapContent> {
        await this.requireMapExists(this.pool, mapId);
        const result = await this.pool.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_map_contents WHERE map_id = $1",
            [mapId],
        );
        return MapContentSchema.parse(requireRow(result.rows, "Map content", mapId).record);
    }

    async putMapContent(mapId: string, expectedVersion: number, input: PutMapContentInput): Promise<MapContent> {
        return this.transaction(async (client) => {
            const map = await this.lockMap(client, mapId);
            requireVersion("Map", expectedVersion, map.version);
            const current = await client.query<JsonRecordRow>(
                "SELECT record FROM agent_platform_map_contents WHERE map_id = $1",
                [mapId],
            );
            const previous = current.rows[0] === undefined ? undefined : MapContentSchema.parse(current.rows[0].record);
            const now = new Date().toISOString();
            const content: MapContent = {
                mapId,
                format: input.format,
                document: structuredClone(input.document),
                version: (previous?.version ?? 0) + 1,
                updatedAt: now,
            };
            await client.query(
                "INSERT INTO agent_platform_map_contents(map_id, record, updated_at) VALUES($1, $2::jsonb, $3) ON CONFLICT (map_id) DO UPDATE SET record = EXCLUDED.record, updated_at = EXCLUDED.updated_at",
                [mapId, JSON.stringify(content), now],
            );
            if (previous !== undefined && previous.format !== content.format) {
                await this.enqueueMapStorage(client, "delete", {
                    path: this.mapContentPath(map.slug, previous.format),
                });
            }
            await this.enqueueMapStorage(client, "put", {
                path: this.mapContentPath(map.slug, content.format),
                contentType: "application/json",
                contentBase64: Buffer.from(JSON.stringify(content.document)).toString("base64"),
            });
            await this.updateMapAfterContent(client, map, now);
            return content;
        });
    }

    async listMapAssets(mapId: string): Promise<MapAsset[]> {
        await this.requireMapExists(this.pool, mapId);
        const result = await this.pool.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_map_assets WHERE map_id = $1 ORDER BY path",
            [mapId],
        );
        return result.rows.map((row) => MapAssetSchema.parse(row.record));
    }

    async putMapAsset(
        mapId: string,
        path: string,
        expectedVersion: number,
        input: PutMapAssetInput,
    ): Promise<MapAsset> {
        return this.transaction(async (client) => {
            const map = await this.lockMap(client, mapId);
            requireVersion("Map", expectedVersion, map.version);
            const current = await client.query<JsonRecordRow>(
                "SELECT record FROM agent_platform_map_assets WHERE map_id = $1 AND path = $2",
                [mapId, path],
            );
            const previous = current.rows[0] === undefined ? undefined : MapAssetSchema.parse(current.rows[0].record);
            const bytes = Buffer.from(input.contentBase64, "base64");
            const now = new Date().toISOString();
            const asset: MapAsset = {
                mapId,
                path,
                mimeType: input.mimeType,
                size: bytes.byteLength,
                checksum: assetChecksum(bytes),
                version: (previous?.version ?? 0) + 1,
                updatedAt: now,
            };
            await client.query(
                "INSERT INTO agent_platform_map_assets(map_id, path, record, content, updated_at) VALUES($1, $2, $3::jsonb, $4, $5) ON CONFLICT (map_id, path) DO UPDATE SET record = EXCLUDED.record, content = EXCLUDED.content, updated_at = EXCLUDED.updated_at",
                [mapId, path, JSON.stringify(asset), bytes, now],
            );
            await this.enqueueMapStorage(client, "put", {
                path: `${map.slug}/${path}`,
                contentType: input.mimeType,
                contentBase64: input.contentBase64,
            });
            await this.bumpMap(client, map, now);
            return asset;
        });
    }

    async deleteMapAsset(mapId: string, path: string, expectedVersion: number): Promise<void> {
        await this.transaction(async (client) => {
            const map = await this.lockMap(client, mapId);
            requireVersion("Map", expectedVersion, map.version);
            const deleted = await client.query(
                "DELETE FROM agent_platform_map_assets WHERE map_id = $1 AND path = $2",
                [mapId, path],
            );
            if (deleted.rowCount === 0) throw new NotFoundError("Map asset", path);
            await this.enqueueMapStorage(client, "delete", { path: `${map.slug}/${path}` });
            await this.bumpMap(client, map, new Date().toISOString());
        });
    }

    async listAgents(): Promise<AgentRecord[]> {
        const result = await this.pool.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_agents ORDER BY created_at, id",
        );
        return result.rows.map((row) => AgentRecordSchema.parse(row.record));
    }

    async getAgent(id: string): Promise<AgentRecord> {
        const result = await this.pool.query<JsonRecordRow>("SELECT record FROM agent_platform_agents WHERE id = $1", [
            id,
        ]);
        return AgentRecordSchema.parse(requireRow(result.rows, "Agent", id).record);
    }

    async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
        await this.requireMapExists(this.pool, input.mapId);
        const now = new Date().toISOString();
        const record: AgentRecord = {
            ...structuredClone(input),
            id: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
            runtimeStatus: "offline",
            runtimeErrorCode: null,
        };
        try {
            await this.pool.query(
                "INSERT INTO agent_platform_agents(id, hermes_profile_id, map_id, record, created_at, updated_at) VALUES($1, $2, $3, $4::jsonb, $5, $5)",
                [record.id, record.hermesProfileId, record.mapId, JSON.stringify(record), now],
            );
        } catch (error: unknown) {
            this.translateUnique(
                error,
                "hermes_profile_conflict",
                `Hermes profile '${input.hermesProfileId}' is already bound to an agent definition`,
            );
        }
        return record;
    }

    async updateAgent(id: string, expectedVersion: number, input: UpdateAgentInput): Promise<AgentRecord> {
        return this.transaction(async (client) => {
            const current = await this.lockAgent(client, id);
            requireVersion("Agent", expectedVersion, current.version);
            if (input.mapId !== undefined) await this.requireMapExists(client, input.mapId);
            const updated: AgentRecord = {
                ...current,
                ...structuredClone(input),
                controlMode: "hermes",
                version: current.version + 1,
                updatedAt: new Date().toISOString(),
            };
            try {
                await client.query(
                    "UPDATE agent_platform_agents SET hermes_profile_id = $2, map_id = $3, record = $4::jsonb, updated_at = $5 WHERE id = $1",
                    [id, updated.hermesProfileId, updated.mapId, JSON.stringify(updated), updated.updatedAt],
                );
            } catch (error: unknown) {
                this.translateUnique(
                    error,
                    "hermes_profile_conflict",
                    `Hermes profile '${updated.hermesProfileId}' is already bound to an agent definition`,
                );
            }
            return updated;
        });
    }

    async deleteAgent(id: string, expectedVersion: number): Promise<void> {
        await this.transaction(async (client) => {
            const current = await this.lockAgent(client, id);
            requireVersion("Agent", expectedVersion, current.version);
            await client.query("DELETE FROM agent_platform_agents WHERE id = $1", [id]);
        });
    }

    async setAgentRuntimeStatus(
        id: string,
        status: AgentRuntimeStatus,
        errorCode: string | null,
    ): Promise<AgentRecord> {
        return this.transaction(async (client) => {
            const current = await this.lockAgent(client, id);
            const updated: AgentRecord = { ...current, runtimeStatus: status, runtimeErrorCode: errorCode };
            await client.query("UPDATE agent_platform_agents SET record = $2::jsonb WHERE id = $1", [
                id,
                JSON.stringify(updated),
            ]);
            return updated;
        });
    }

    private async transaction<Result>(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await operation(client);
            await client.query("COMMIT");
            return result;
        } catch (error: unknown) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async lockMap(client: PoolClient, id: string): Promise<MapRecord> {
        const result = await client.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_maps WHERE id = $1 FOR UPDATE",
            [id],
        );
        return MapRecordSchema.parse(requireRow(result.rows, "Map", id).record);
    }

    private async lockAgent(client: PoolClient, id: string): Promise<AgentRecord> {
        const result = await client.query<JsonRecordRow>(
            "SELECT record FROM agent_platform_agents WHERE id = $1 FOR UPDATE",
            [id],
        );
        return AgentRecordSchema.parse(requireRow(result.rows, "Agent", id).record);
    }

    private async requireMapExists(client: Pick<Pool, "query"> | PoolClient, id: string): Promise<void> {
        const result = await client.query("SELECT 1 FROM agent_platform_maps WHERE id = $1", [id]);
        if (result.rowCount === 0) throw new NotFoundError("Map", id);
    }

    private async bumpMap(client: PoolClient, current: MapRecord, now: string): Promise<void> {
        const updated: MapRecord = { ...current, version: current.version + 1, updatedAt: now };
        await client.query("UPDATE agent_platform_maps SET record = $2::jsonb, updated_at = $3 WHERE id = $1", [
            current.id,
            JSON.stringify(updated),
            now,
        ]);
    }

    private async updateMapAfterContent(client: PoolClient, current: MapRecord, now: string): Promise<void> {
        const updated: MapRecord = {
            ...current,
            validationState: "valid",
            validationErrors: [],
            version: current.version + 1,
            updatedAt: now,
        };
        await client.query("UPDATE agent_platform_maps SET record = $2::jsonb, updated_at = $3 WHERE id = $1", [
            current.id,
            JSON.stringify(updated),
            now,
        ]);
    }

    private translateUnique(error: unknown, code: string, message: string): never {
        if (isPostgresError(error) && error.code === "23505") throw new ConflictError(code, message);
        throw error;
    }

    private mapContentPath(slug: string, format: MapContent["format"]): string {
        return `${slug}/map.${format}`;
    }

    private async enqueueMapStorage(
        client: PoolClient,
        operation: "put" | "delete" | "move",
        payload: Record<string, string>,
    ): Promise<void> {
        await client.query("INSERT INTO agent_platform_map_storage_outbox(operation, payload) VALUES($1, $2::jsonb)", [
            operation,
            JSON.stringify(payload),
        ]);
    }
}

export class PostgresAuditSink implements AuditSink {
    constructor(private readonly pool: Pool) {}

    async append(event: AuditEvent): Promise<void> {
        await this.pool.query(
            "INSERT INTO agent_platform_audit_events(action, actor, resource_type, resource_id, outcome, occurred_at, metadata) VALUES($1, $2, $3, $4, $5, $6, $7::jsonb)",
            [
                event.action,
                event.actor,
                event.resourceType,
                event.resourceId,
                event.outcome,
                event.occurredAt,
                JSON.stringify(event.metadata),
            ],
        );
    }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
    private availablePermits: number;
    private readonly permitWaiters: Array<(release: () => void) => void> = [];

    constructor(
        private readonly pool: Pool,
        private readonly retentionHours = 24,
        private readonly maxConcurrentOperations = 4,
    ) {
        this.availablePermits = maxConcurrentOperations;
    }

    async execute<Result>(
        key: string,
        fingerprint: string,
        parse: (value: unknown) => Result,
        operation: () => Promise<Result>,
    ): Promise<Result> {
        const releasePermit = await this.acquirePermit();
        try {
            const client = await this.pool.connect();
            try {
                await client.query("BEGIN");
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
                const stored = await client.query<IdempotencyRow>(
                    "SELECT fingerprint, response FROM agent_platform_idempotency WHERE key = $1 AND expires_at > now()",
                    [key],
                );
                const existing = stored.rows[0];
                if (existing !== undefined) {
                    if (existing.fingerprint !== fingerprint) {
                        throw new ConflictError(
                            "idempotency_key_reused",
                            "The idempotency key was already used for a different request",
                        );
                    }
                    await client.query("COMMIT");
                    return parse(existing.response);
                }
                const result = await operation();
                await client.query(
                    "INSERT INTO agent_platform_idempotency(key, fingerprint, response, expires_at) VALUES($1, $2, $3::jsonb, now() + ($4 * interval '1 hour')) ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, response = EXCLUDED.response, created_at = now(), expires_at = EXCLUDED.expires_at",
                    [key, fingerprint, JSON.stringify(result), this.retentionHours],
                );
                await client.query("COMMIT");
                return result;
            } catch (error: unknown) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            } finally {
                client.release();
            }
        } finally {
            releasePermit();
        }
    }

    private acquirePermit(): Promise<() => void> {
        if (this.availablePermits > 0) {
            this.availablePermits -= 1;
            return Promise.resolve(() => this.releasePermit());
        }
        return new Promise((resolve) => {
            this.permitWaiters.push(resolve);
        });
    }

    private releasePermit(): void {
        const waiter = this.permitWaiters.shift();
        if (waiter === undefined) {
            this.availablePermits = Math.min(this.maxConcurrentOperations, this.availablePermits + 1);
            return;
        }
        waiter(() => this.releasePermit());
    }
}
