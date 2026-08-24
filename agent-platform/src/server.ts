import { buildApp, createDefaultDependencies } from "./app";
import { AgentIdentityBrokerClient } from "./runtime/agent-identity-client";
import { AgentRuntimeSupervisor } from "./runtime/agent-runtime-supervisor";

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
const dependencies = createDefaultDependencies();
const app = await buildApp({ adminToken, connectorToken, dependencies, logger: true });

if (process.env.AGENT_RUNTIME_ENABLED === "true") {
    const brokerEndpoint = process.env.AGENT_IDENTITY_BROKER_URL;
    const identityToken = process.env.AGENT_IDENTITY_TOKEN;
    const pusherWebSocketUrl = process.env.WORKADVENTURE_PUSHER_WS_URL;
    if (brokerEndpoint === undefined || identityToken === undefined || pusherWebSocketUrl === undefined) {
        throw new Error(
            "AGENT_IDENTITY_BROKER_URL, AGENT_IDENTITY_TOKEN, and WORKADVENTURE_PUSHER_WS_URL are required when AGENT_RUNTIME_ENABLED=true",
        );
    }
    if (identityToken.length < 32) {
        throw new Error("AGENT_IDENTITY_TOKEN must contain at least 32 characters");
    }
    if (dependencies.connectorHub === undefined) {
        throw new Error("The Hermes Connector hub is required when the agent runtime is enabled");
    }
    const runtime = new AgentRuntimeSupervisor(dependencies.service, dependencies.connectorHub, {
        pusherWebSocketUrl: new URL(pusherWebSocketUrl),
        identityProvider: new AgentIdentityBrokerClient(new URL(brokerEndpoint), identityToken),
        onError: (agentId, error) => app.log.error({ agentId, error }, "Hermes agent runtime error"),
    });
    app.addHook("onClose", () => runtime.stop());
    await runtime.start();
}
await app.listen({ host, port });
