# Hermes Agent Platform roadmap

This file is the repository-local phase ledger. GitHub issues hold the active checklists.

## Phase 0 — Repository and baseline safety

Status: completed and accepted on 24 August 2026 ([issue #2](https://github.com/WilliamHankey/workadventure/issues/2)).

- Clean fork and feature branch
- PoC preservation
- Approved ADR, blueprint, API skeleton, migration checklist
- Map starter project
- Baseline smoke/build record
- Phase 0 approval checkpoint

## Phase 1 — Administration API and registry

Status: completed on 24 August 2026 ([issue #3](https://github.com/WilliamHankey/workadventure/issues/3)).

- Map CRUD
- Agent CRUD
- Supporting read-only catalogs
- Desired-state reconciliation
- Authentication, authorization, validation, idempotency, audit events

## Phase 2 — Hermes Connector and agent driver loop

Status: next.

- Profile/model discovery
- Outbound authenticated connector
- World/media events into the correct Hermes session
- Model tool calls through identity and capability guards
- Profile isolation and reconnect behavior

## Phase 3 — WorkAdventure presence and text

- Production agent OIDC identity
- Woka presence and roster/spaces
- Text events and Hermes-controlled responses
- Status and emote tools

## Phase 4 — Navigation and owner binding

- WAM/TMJ navigation graph
- Collision-aware movement
- Owner relationship context
- Hermes movement/follow/approach tools

## Phase 5 — Lowcoder administration UI

- Map CRUD UI
- Agent CRUD UI
- Read-only status/diagnostics
- No live control or Hermes-run UI

## Phase 6 — Voice

- Invitation-bound LiveKit audio
- VAD/STT → Hermes decision → TTS
- Consent, indicators, loop prevention, and isolation tests

## Phase 7 — Virtual video

- Synthetic Woka/avatar track
- Hermes-controlled publication
- Camera-state synchronization and CPU limits

## Phase 8 — Browser compatibility

- On-demand Playwright pool
- Supported Scripting API tools for missing parity
- Strict permission and resource limits

## Phase 9 — Production hardening

- Deployment, backups, monitoring, upgrades, incident recovery
- Resource gates and private pilot
