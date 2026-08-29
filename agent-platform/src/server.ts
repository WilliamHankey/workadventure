import { buildApp, createDefaultDependencies } from "./app";
import { createProductionDependencies } from "./infrastructure/production-dependencies";
import { readPositiveInteger, readSecret } from "./infrastructure/runtime-config";
import { AgentIdentityBrokerClient } from "./runtime/agent-identity-client";
import { AgentRuntimeSupervisor } from "./runtime/agent-runtime-supervisor";

const adminToken = await readSecret("AGENT_PLATFORM_ADMIN_TOKEN", 32);
const connectorToken = await readSecret("HERMES_CONNECTOR_TOKEN", 32);

const port = Number.parseInt(process.env.AGENT_PLATFORM_PORT ?? "3200", 10);
const host = process.env.AGENT_PLATFORM_HOST ?? "0.0.0.0";
const storage = process.env.AGENT_PLATFORM_STORAGE ?? "postgres";
if (storage !== "postgres" && storage !== "memory") {
    throw new Error("AGENT_PLATFORM_STORAGE must be 'postgres' or 'memory'");
}
if (storage === "memory" && process.env.NODE_ENV === "production") {
    throw new Error("In-memory storage is not permitted in production");
}
const databaseUrl = storage === "postgres" ? await readSecret("DATABASE_URL", 1) : undefined;
const redisUrl = storage === "postgres" ? await readSecret("REDIS_URL", 1) : undefined;
const mapStorageAuthorization = storage === "postgres" ? await readSecret("MAP_STORAGE_AUTHORIZATION", 16) : undefined;
const mapStorageUrl = storage === "postgres" ? process.env.MAP_STORAGE_URL : undefined;
if (storage === "postgres" && mapStorageUrl === undefined) throw new Error("MAP_STORAGE_URL is required");
const dependencies =
    storage === "memory"
        ? createDefaultDependencies()
        : await createProductionDependencies({
              databaseUrl: databaseUrl ?? "",
              redisUrl: redisUrl ?? "",
              databasePoolMax: readPositiveInteger("DATABASE_POOL_MAX", 12),
              idempotencyRetentionHours: readPositiveInteger("IDEMPOTENCY_RETENTION_HOURS", 24),
              maxMediaSessions: readPositiveInteger("MEDIA_MAX_SESSIONS", 2),
              mapStorageUrl,
              mapStorageAuthorization,
              onDegraded: (dependency, error) => console.error(`${dependency} degraded`, error),
          });

// Build the agent runtime supervisor (if enabled) before the app so its onClose
// hook can be registered inside buildApp (which readies the instance). The hook
// must be registered before ready(); passing it as an option satisfies that.
let runtime: AgentRuntimeSupervisor | undefined;
if (process.env.AGENT_RUNTIME_ENABLED === "true") {
    const brokerEndpoint = process.env.AGENT_IDENTITY_BROKER_URL;
    const identityToken = await readSecret("AGENT_IDENTITY_TOKEN", 32);
    const pusherWebSocketUrl = process.env.WORKADVENTURE_PUSHER_WS_URL;
    if (brokerEndpoint === undefined || pusherWebSocketUrl === undefined) {
        throw new Error(
            "AGENT_IDENTITY_BROKER_URL and WORKADVENTURE_PUSHER_WS_URL are required when AGENT_RUNTIME_ENABLED=true",
        );
    }
    if (dependencies.connectorHub === undefined) {
        throw new Error("The Hermes Connector hub is required when the agent runtime is enabled");
    }
    runtime = new AgentRuntimeSupervisor(dependencies.service, dependencies.connectorHub, {
        pusherWebSocketUrl: new URL(pusherWebSocketUrl),
        identityProvider: new AgentIdentityBrokerClient(new URL(brokerEndpoint), identityToken),
        onError: (agentId, error) => console.error({ agentId, error }, "Hermes agent runtime error"),
        maxActiveAgents: readPositiveInteger("AGENT_MAX_ACTIVE", 10),
    });
    await runtime.start();
}

const app = await buildApp({
    adminToken,
    connectorToken,
    dependencies,
    logger: true,
    rateLimit: {
        windowMs: readPositiveInteger("RATE_LIMIT_WINDOW_MS", 60_000),
        adminRequests: readPositiveInteger("ADMIN_RATE_LIMIT", 120),
        connectorRequests: readPositiveInteger("CONNECTOR_RATE_LIMIT", 30),
    },
    onClose: runtime
        ? () => runtime.stop()
        : undefined,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        app.close()
            .catch((error: unknown) => app.log.error({ error, signal }, "Agent platform shutdown failed"))
            .finally(() => process.exit(0));
    });
}

await app.listen({ host, port });
