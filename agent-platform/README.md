# Hermes agent administration service

This package is the Lowcoder-facing administration plane for maps and Hermes-controlled agent definitions.

Lowcoder can create, read, update, and delete maps and agent definitions. It can also read the Hermes profile catalog and health state. It cannot move an agent, send chat, start a model run, or control voice/video. Every live action belongs to Hermes; definition changes are emitted as desired-state events only.

## Run locally

```bash
export AGENT_PLATFORM_ADMIN_TOKEN='replace-with-at-least-16-characters'
npm run start --workspace=@workadventure/agent-platform
```

OpenAPI is available at `/documentation`. Mutating requests require `Idempotency-Key`; updates and deletes also require `If-Match` with the current resource version.

The default boot path uses in-memory adapters for the Phase 1 contract slice. `migrations/0001_agent_platform.sql` defines the durable PostgreSQL model, including an outbox restricted to definition-change events. `RedisDesiredStatePublisher` provides the internal event adapter; its typed input permits only `agent.definition.changed` and `agent.definition.deleted` events.
