import { Pool } from "pg";
import { createClient } from "redis";

import type { AppDependencies } from "../app";
import { ConnectorHub } from "../connector/connector-hub";
import { AdminService } from "../services/admin-service";
import { MapStorageOutboxWorker, WorkAdventureMapStorageClient } from "./map-storage-sync";
import { MemoryHermesProfileCatalog } from "./memory-adapters";
import {
    PostgresAuditSink,
    PostgresIdempotencyStore,
    PostgresRegistryRepository,
    runPostgresMigrations,
} from "./postgres-adapters";
import { RedisDesiredStatePublisher, ResilientDesiredStatePublisher } from "./redis-desired-state-publisher";

const normalizeError = (error: unknown): Error =>
    error instanceof Error ? error : new Error("Unknown production dependency error");

export interface ProductionDependencyOptions {
    databaseUrl: string;
    redisUrl: string;
    databasePoolMax?: number;
    idempotencyRetentionHours?: number;
    maxMediaSessions?: number;
    mapStorageUrl?: string;
    mapStorageAuthorization?: string;
    mapStoragePollIntervalMs?: number;
    onDegraded?: (dependency: "redis", error: Error) => void;
}

export const createProductionDependencies = async (options: ProductionDependencyOptions): Promise<AppDependencies> => {
    const pool = new Pool({
        connectionString: options.databaseUrl,
        max: options.databasePoolMax ?? 12,
        application_name: "workadventure-agent-platform",
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        allowExitOnIdle: false,
    });
    const redis = createClient({
        url: options.redisUrl,
        disableOfflineQueue: true,
        socket: {
            connectTimeout: 10_000,
            reconnectStrategy: (retries) => Math.min(5_000, 100 * 2 ** Math.min(retries, 6)),
        },
    });
    redis.on("error", (error: unknown) => options.onDegraded?.("redis", normalizeError(error)));
    try {
        await runPostgresMigrations(pool);
        await redis.connect();
    } catch (error: unknown) {
        await pool.end().catch(() => undefined);
        if (redis.isOpen) await redis.disconnect().catch(() => undefined);
        throw error;
    }

    const catalog = new MemoryHermesProfileCatalog();
    const repository = new PostgresRegistryRepository(pool);
    const desiredState = new ResilientDesiredStatePublisher(new RedisDesiredStatePublisher(redis), (error) =>
        options.onDegraded?.("redis", error),
    );
    const service = new AdminService(repository, new PostgresAuditSink(pool), desiredState, catalog);
    const mapStorageWorker =
        options.mapStorageUrl === undefined || options.mapStorageAuthorization === undefined
            ? undefined
            : new MapStorageOutboxWorker(
                  pool,
                  new WorkAdventureMapStorageClient(new URL(options.mapStorageUrl), options.mapStorageAuthorization),
                  options.mapStoragePollIntervalMs,
              );
    mapStorageWorker?.start();
    return {
        service,
        idempotency: new PostgresIdempotencyStore(pool, options.idempotencyRetentionHours),
        connectorHub: new ConnectorHub(service, catalog, 30_000, options.maxMediaSessions),
        healthCheck: async () => {
            await Promise.all([repository.healthCheck(), redis.ping(), mapStorageWorker?.healthCheck()]);
        },
        close: async () => {
            await mapStorageWorker?.stop();
            await Promise.allSettled([pool.end(), redis.isOpen ? redis.quit() : Promise.resolve()]);
        },
    };
};
