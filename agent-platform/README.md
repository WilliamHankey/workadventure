# Hermes agent administration service

This package is the Lowcoder-facing administration plane for maps and Hermes-controlled agent definitions.

Lowcoder can create, read, update, and delete maps and agent definitions. It can also read the Hermes profile catalog and health state. It cannot move an agent, send chat, start a model run, or control voice/video. Every live action belongs to Hermes; definition changes are emitted as desired-state events only.

## Run locally

```bash
export AGENT_PLATFORM_ADMIN_TOKEN='replace-with-at-least-16-characters'
npm run start --workspace=@workadventure/agent-platform
```

OpenAPI is available at `/documentation`. Mutating requests require `Idempotency-Key`; updates and deletes also require `If-Match` with the current resource version.

The default boot path uses in-memory adapters for the initial contract slice. `migrations/0001_agent_platform.sql` defines the durable PostgreSQL model, including an outbox restricted to definition-change events. `RedisDesiredStatePublisher` provides the internal event adapter; its typed input permits only `agent.definition.changed` and `agent.definition.deleted` events.

## Enable real Woka presence

The Phase 3 runtime is disabled by default. Configure the WorkAdventure pusher and this service with the same independent, random `AGENT_IDENTITY_TOKEN` of at least 32 characters, then start the control plane with:

```bash
export AGENT_RUNTIME_ENABLED=true
export AGENT_IDENTITY_BROKER_URL='https://play.example.com/internal/agent-identities/token'
export AGENT_IDENTITY_TOKEN='replace-with-a-dedicated-random-32-character-secret'
export WORKADVENTURE_PUSHER_WS_URL='wss://play.example.com/ws/room'
```

The pusher endpoint issues a 15-minute WorkAdventure JWT containing only the agent identity, display name, and `bot`/`hermes-agent` tags. It is not enabled unless `AGENT_IDENTITY_TOKEN` is set. Hermes profile credentials stay on Hermes Desktop and never enter this flow.

Every enabled agent requires a map with a full `roomUrl` and a matching `spawnPoint`. Entry-point coordinates are WorkAdventure world pixels:

```json
{
    "name": "Agent World",
    "slug": "agent-world",
    "roomUrl": "https://play.example.com/_/global/maps.example.com/office.tmj",
    "entryPoints": [{ "name": "start", "x": 320, "y": 256 }]
}
```

On reconciliation the runtime creates exactly one room client per enabled definition, joins with that definition's name and Woka textures, tracks nearby users, and forwards speech events only to the immutable Hermes lane bound to that agent. Live `wa_say`, `wa_set_status`, and `wa_emote` actions enter through that authenticated lane; Lowcoder has no operational action endpoint.
