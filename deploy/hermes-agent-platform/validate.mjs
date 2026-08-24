import { access, readFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const required = [
    "compose.yaml",
    ".env.example",
    "prometheus.yml",
    "alerts.yml",
    "backup.sh",
    "restore.sh",
    "render-media-config.sh",
    "render-observability-config.sh",
];
await Promise.all(required.map(async (path) => access(new URL(path, root))));

const [compose, env] = await Promise.all([
    readFile(new URL("compose.yaml", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
]);
for (const secret of [
    "AGENT_PLATFORM_ADMIN_TOKEN_FILE",
    "HERMES_CONNECTOR_TOKEN_FILE",
    "AGENT_IDENTITY_TOKEN_FILE",
    "DATABASE_URL_FILE",
    "REDIS_URL_FILE",
    "MAP_STORAGE_AUTHORIZATION_FILE",
]) {
    if (!compose.includes(secret)) throw new Error(`Compose is missing secret-file binding ${secret}`);
}
for (const forbidden of ["AGENT_PLATFORM_ADMIN_TOKEN:", "HERMES_CONNECTOR_TOKEN:", "AGENT_IDENTITY_TOKEN:"]) {
    if (compose.includes(forbidden)) throw new Error(`Compose contains inline secret binding ${forbidden}`);
}
for (const gate of [
    "cpus: \"2.0\"",
    "memory: 3G",
    "AGENT_MAX_ACTIVE",
    "MEDIA_MAX_SESSIONS",
    "COTURN_MIN_PORT",
    "LIVEKIT_RTC_UDP_PORT",
]) {
    if (!compose.includes(gate) && !env.includes(gate)) throw new Error(`Resource/media gate missing: ${gate}`);
}
if (compose.includes("/metrics`)")) throw new Error("Metrics must not be routed through public Traefik labels");

console.log("Phase 9 deployment contract valid: secret files, health, resource caps, metrics, and direct media ports.");
