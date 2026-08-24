# Hermes Desktop connector

The connector runs beside Hermes on William's Windows machine. It discovers API-enabled Hermes profiles locally, keeps every profile API key in local memory, and opens one outbound WebSocket to the platform. Only normalized profile/model health metadata crosses that connection.

Hermes profiles remain separate homes and gateway processes. The connector probes each local gateway's authenticated `/v1/capabilities`, `/health/detailed`, and `/v1/models` endpoints, then routes world events by an immutable agent/profile/session lane.

## Hermes profile prerequisites

For each profile selected as an in-world agent, enable its loopback API server and give it a unique key and port:

```powershell
researcher config set API_SERVER_ENABLED true
researcher config set API_SERVER_KEY replace-with-a-unique-local-key
researcher config set API_SERVER_PORT 8643
researcher gateway start
```

Repeat with a different port and key for every profile. The connector discovers the default Hermes home and named homes under `%USERPROFILE%\.hermes\profiles`. Non-loopback gateways are ignored by default.

## Start on Windows

```powershell
$env:HERMES_CONNECTOR_URL = "wss://your-platform.example/connector/v1/ws"
$env:HERMES_CONNECTOR_TOKEN = "replace-with-the-platform-registration-token"
$env:HERMES_CONNECTOR_ID = "william-hermes-desktop"
npm run start --workspace=@workadventure/hermes-connector
```

Use `ws://localhost` only for local development. Production startup rejects non-TLS connector URLs.

The connector registration token authenticates the outbound platform connection; it is not a Hermes profile key. Raw profile keys are read only from each profile's local `.env` or `config.yaml`, used only for loopback HTTP requests, and omitted from protocol schemas and logs.
