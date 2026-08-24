# Phase 5 implementation and acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #7](https://github.com/WilliamHankey/workadventure/issues/7)

## Delivered

- Portable Lowcoder application JSON built against the Lowcoder 2.7.6 export structure.
- Map list, create, edit, delete, content, and asset administration surfaces.
- Agent list, create, edit, and delete surfaces with map and Hermes-profile selectors.
- Read-only Hermes profile and platform-health panels.
- Session-only API base URL and empty password input for the administration token; no credential is committed.
- Manual-trigger-only mutations, explicit buttons, guarded deletion, idempotency keys, and optimistic `If-Match` versions.
- Loading, empty, success, validation, conflict, and network-error feedback.
- A checked-in query inventory and static validator that fail on live-control or undeclared routes.
- API-backed contract tests proving every Lowcoder route exists and page-load reads work against the Fastify API.
- Import, configuration, publishing, regeneration, and rollback instructions.

## Safety and control boundary

Lowcoder contains exactly 18 allowlisted administration queries. It cannot walk, follow, approach, message, speak, join media, publish video, start a Hermes run, approve a run, spawn a runtime, stop a runtime, or issue a generic command. Enabling an agent only changes desired state. Every live action remains available solely to the bound Hermes profile/model over its immutable agent/profile/session lane.

## Automated verification

- Focused GitHub Actions run [32688809459](https://github.com/WilliamHankey/workadventure/actions/runs/32688809459): passed.
- Agent platform: TypeScript and ESLint passed; Vitest 19/19 passed.
- Lowcoder app freshness check: passed.
- Lowcoder query-boundary validator: passed with 18 allowed queries and no live-control route.
- Hermes Connector and shared protocol checks: passed.
- Pusher identity adapter checks: passed.
- `git diff --check`: passed locally.

## Remaining live-environment gate

Automated implementation acceptance is complete. Final operator acceptance remains open until the checked-in JSON is imported into an actual Lowcoder 2.7.6 instance and William completes one map and one agent create/update/delete cycle. That external-instance check cannot be replaced by a source-schema assertion, so issue #7 remains open until the click-through is recorded.

## Published implementation

- [`787e00e58aff7d6c43e893a6e127eb839bb0f4a6`](https://github.com/WilliamHankey/workadventure/commit/787e00e58aff7d6c43e893a6e127eb839bb0f4a6) — administration-only Lowcoder app, boundary validator, and API-backed inventory tests.

Phase 5 is code-complete and CI-accepted, with the live Lowcoder import gate outstanding. Phase 6 may proceed independently because it does not expand Lowcoder's authority.
