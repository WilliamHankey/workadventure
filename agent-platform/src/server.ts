import { buildApp } from "./app";

const adminToken = process.env.AGENT_PLATFORM_ADMIN_TOKEN;
const connectorToken = process.env.HERMES_CONNECTOR_TOKEN;
if (adminToken === undefined) {
    throw new Error("AGENT_PLATFORM_ADMIN_TOKEN is required");
}
if (connectorToken === undefined) {
    throw new Error("HERMES_CONNECTOR_TOKEN is required");
}

const port = Number.parseInt(process.env.AGENT_PLATFORM_PORT ?? "3200", 10);
const host = process.env.AGENT_PLATFORM_HOST ?? "0.0.0.0";
const app = await buildApp({ adminToken, connectorToken, logger: true });
await app.listen({ host, port });
