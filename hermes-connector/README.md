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

## Invitation-bound voice bridge

Voice is opt-in and fail-closed. Configure `HERMES_MEDIA_BRIDGE_URL` only when a local Hermes Desktop media bridge is running on a loopback `ws://` or `wss://` URL. An optional `HERMES_MEDIA_BRIDGE_TOKEN` authenticates that local hop. The connector rejects non-loopback bridge URLs.

```powershell
$env:HERMES_MEDIA_BRIDGE_URL = "ws://127.0.0.1:8766/v1/media"
$env:HERMES_MEDIA_BRIDGE_TOKEN = "replace-with-a-local-bridge-token"
```

The bridge receives a short-lived LiveKit invitation token only after Hermes accepts a human's WorkAdventure meeting invitation. It must use the supplied participant identity/UUID allowlist, VAD policy, and session lane; return only final transcripts from that participant; run STT/TTS locally; and stop immediately when the connector sends `stop`. If the bridge is absent, the connector returns `media_adapter_unavailable` and the Woka remains silent.

Local bridge messages are `start`, `ready`, `transcript`, `speech`, `speech.result`, `stop`, and `stopped`. The checked-in `InvitationBoundVoiceSession` supplies the fixed VAD, participant filtering, single-STT lifecycle, local TTS publication, barge-in, and idempotent-stop core for a Hermes Desktop bridge implementation.
