import { homedir } from "node:os";
import path from "node:path";

import { HermesConnector } from "./connector";
import { HermesHttpGatewayFactory } from "./hermes-http-gateway";
import { LocalMediaBridgeAdapter } from "./media/local-media-bridge";
import { FileSystemHermesProfileDiscovery } from "./profile-discovery";
import { OutboundWebSocketTransport } from "./websocket-transport";

const connectorUrl = process.env.HERMES_CONNECTOR_URL;
const registrationToken = process.env.HERMES_CONNECTOR_TOKEN;
const connectorId = process.env.HERMES_CONNECTOR_ID ?? "william-hermes-desktop";
const hermesHome = process.env.HERMES_CONNECTOR_HOME ?? path.join(homedir(), ".hermes");
const mediaBridgeUrl = process.env.HERMES_MEDIA_BRIDGE_URL;

if (connectorUrl === undefined || registrationToken === undefined) {
    throw new Error("HERMES_CONNECTOR_URL and HERMES_CONNECTOR_TOKEN are required");
}
if (!connectorUrl.startsWith("wss://") && process.env.NODE_ENV === "production") {
    throw new Error("HERMES_CONNECTOR_URL must use wss:// in production");
}

const connector = new HermesConnector(
    new FileSystemHermesProfileDiscovery({ hermesHome }),
    new HermesHttpGatewayFactory(),
    new OutboundWebSocketTransport({ url: connectorUrl, registrationToken }),
    {
        connectorId,
        mediaAdapter:
            mediaBridgeUrl === undefined
                ? undefined
                : new LocalMediaBridgeAdapter({
                      url: mediaBridgeUrl,
                      token: process.env.HERMES_MEDIA_BRIDGE_TOKEN,
                  }),
    }
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        connector
            .stop()
            .catch(() => undefined)
            .finally(() => process.exit(0));
    });
}

await connector.start();
