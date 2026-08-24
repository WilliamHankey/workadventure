# Phase 1 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #3](https://github.com/WilliamHankey/workadventure/issues/3)

## Delivered

- TypeScript/Fastify administration workspace with Zod request/response contracts and generated OpenAPI.
- Bearer authentication, idempotency replay protection, optimistic resource versions, stable errors, health probes, and safe audit events.
- Map metadata/content/asset CRUD with guarded deletion and validation state.
- Agent-definition CRUD with one Hermes profile binding, a forced `controlMode: hermes`, and guarded map references.
- Read-only Hermes profile catalog.
- PostgreSQL migration for registry, content, assets, agents, audit, idempotency, and the desired-state outbox.
- In-memory contract adapters and a Redis-compatible desired-state publisher.

## Boundary evidence

The administration API has no movement, chat, speech, video, model-run, approval, or generic command routes. Agent writes publish only `agent.definition.changed` or `agent.definition.deleted`. The API never accepts `controlMode: lowcoder` and never handles Hermes or WorkAdventure credentials in its public schemas.

## Verification

From the `@workadventure/agent-platform` workspace:

- TypeScript typecheck: passed.
- Vitest: 1 file, 7 tests passed.
- ESLint: passed.
- Prettier and `git diff --check`: passed.

The tests cover authentication, map CRUD, agent CRUD, idempotent replay and conflicting reuse, optimistic versions, Hermes-only control, dependency-guarded deletion, desired-state events, the read-only catalog, and explicit 404 responses for prohibited operational routes.

## Published commits

- `be923b0ea0e9a38864c3e6b4bb1cb80d9a3dd826` — administration API and registry foundation.
- `73035a4583d240b28ae11a0a6efcfdabd2b0062e` — Phase 1 CRUD/boundary acceptance coverage and Redis event adapter.

Phase 1 is accepted. Phase 2 may implement the outbound Hermes connector and driver loop without widening Lowcoder's surface.
