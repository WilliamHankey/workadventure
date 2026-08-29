# Phase 9 repository acceptance record

Date: 24 August 2026

Repository: `WilliamHankey/workadventure`

Branch: `feature/hermes-agent-platform`

Issue: [#11](https://github.com/WilliamHankey/workadventure/issues/11)

## Accepted repository implementation

- Production-pilot Compose substrate with Traefik, Postgres, Redis, Prometheus, Alertmanager, optional LiveKit/Coturn direct media, restart policies, health checks, and resource caps.
- Production storage defaults to Postgres; production startup rejects in-memory storage. Redis remains a recoverable desired-state notification layer rather than authoritative state.
- Durable map, map-content, asset, agent, audit, idempotency, runtime-status, and ordered Map Storage outbox persistence.
- Isolated Map Storage HTTP Basic lane with server-held credentials, JSON map PUTs, multipart asset uploads, typed put/delete/move operations, capped retries, and readiness failure after retry exhaustion. Upstream Map Storage authentication code is unchanged.
- Secret-file configuration for platform, connector, database, Redis, identity, Map Storage, and media lanes; no credentials are committed.
- Local and Traefik rate limits, bounded metrics, alerts, dependency readiness, active-agent/media/browser limits, and graceful shutdown.
- Backup and guarded restore scripts, operator/incident procedures, secret-rotation guidance, and upstream-upgrade runbook.
- Hermes Desktop uses the documented `/v1/runs` submission/status/stop surface. A strict final JSON decision envelope is translated into locally correlated, allowlisted WorkAdventure actions; action results are matched before completion and observation-only follow-ups are capped at two rounds.
- Lowcoder remains exactly map CRUD, agent CRUD, and supporting read-only administration. It has no movement, model-run, voice, video, or live-agent control route.
- Production image workflow builds on pull requests and publishes commit/branch tags to GHCR on the isolated feature-branch push event.

## Verification

- Focused GitHub workflow [run 32695827023](https://github.com/WilliamHankey/workadventure/actions/runs/32695827023): passed.
- Production image build [run 32695827034](https://github.com/WilliamHankey/workadventure/actions/runs/32695827034): passed.
- Agent platform: 13 test files and 34 tests passed in CI, including real Postgres/Redis restart recovery and Map Storage outbox delivery.
- Hermes Connector: 4 test files and 12 tests passed, including strict decision parsing, ordered action-result correlation, profile isolation, invitation-bound voice, and virtual video limits.
- WorkAdventure service identity: 2 tests passed.
- Protocol, connector, platform, and pusher type/lint gates: passed.
- Lowcoder boundary validator: 18 allowed queries and no live-control route.
- Deployment contract, shell syntax, secret-file bindings, resource gates, and direct media-port validation: passed.

## Principal commits

- [`93a73a2fefae32f91f54bf88f2db993fd4d87fa2`](https://github.com/WilliamHankey/workadventure/commit/93a73a2fefae32f91f54bf88f2db993fd4d87fa2) — production persistence, operations, deployment, and pilot substrate.
- [`3c5a3a7e68601330f56d7c12539de7f70dcb56ff`](https://github.com/WilliamHankey/workadventure/commit/3c5a3a7e68601330f56d7c12539de7f70dcb56ff) — observable pull-request production image build.
- [`9fd247ac9935c1aa5081478a0f3b31b7ee10e17f`](https://github.com/WilliamHankey/workadventure/commit/9fd247ac9935c1aa5081478a0f3b31b7ee10e17f) — Map Storage multipart asset interoperability.
- [`8b00efa8c1f9d4eed31495e740f76a0e1f22525a`](https://github.com/WilliamHankey/workadventure/commit/8b00efa8c1f9d4eed31495e740f76a0e1f22525a) — documented Hermes Runs decision/action loop.
- [`bf209f937e4157368facd53dadf0081d374047d9`](https://github.com/WilliamHankey/workadventure/commit/bf209f937e4157368facd53dadf0081d374047d9) — deploy example aligned with the published GHCR branch tag.

## External private-pilot gates remain open

- Import and click through the checked-in application in a real Lowcoder 2.7.6 instance.
- Configure the target host, DNS, firewall, OIDC identity broker, dedicated Map Storage Basic account, and local secrets.
- Connect at least two real Hermes Desktop profiles/models and prove profile/session isolation.
- Exercise real WorkAdventure Woka presence, avatar, text, navigation, follow/approach, and restart recovery.
- Exercise an invitation-bound LiveKit voice call and virtual-camera video publication through the local Hermes media bridge.
- Run an isolated backup/restore drill, upstream-upgrade drill, and record host resource measurements.

The Phase 9 repository work is accepted. Issue #11 intentionally remains open and the project must not be described as production-ready until the external private-pilot evidence is attached. All repository writes remain isolated to `WilliamHankey/workadventure`; the official WorkAdventure repository was not modified.
