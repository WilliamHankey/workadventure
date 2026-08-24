# Hermes Agent Platform operator guide

## Safety boundary

- Deploy only from `WilliamHankey/workadventure:feature/hermes-agent-platform` until the private pilot is accepted.
- Lowcoder receives the administration bearer token and can use only map CRUD, agent CRUD, and read-only health/catalog/status routes.
- Hermes Desktop makes the outbound `wss://` connection. Raw Hermes profile/provider keys remain in the local Hermes home and never enter Lowcoder, WorkAdventure, GitHub, or the server.
- Each enabled AgentDefinition is immutable-bound to one Hermes profile/model lane. Never share registration tokens between unrelated connector hosts.
- WorkAdventure identity tokens are short-lived service tokens issued per agent. Never reuse a human browser token.

## Host prerequisites

- Linux host with Docker Engine and Compose v2.
- At least 4 vCPU and 8 GiB available for the initial core plane; the stated 4 vCPU/24 GiB host is sufficient only if the staged gates below are respected.
- DNS for the agent API and LiveKit HTTPS/WebSocket endpoint.
- TCP 80/443 to Traefik; direct TCP 7881 and UDP 7882 to LiveKit; direct TCP/UDP 3478 and the configured UDP relay range to Coturn.
- Production WorkAdventure OIDC and an enabled agent identity broker.
- A Hermes Desktop machine that can reach `wss://<agent-domain>/connector/v1/ws` and only uses a loopback media bridge.

Cloudflare Tunnel may front the HTTP administration/connector hostname, but it must not carry LiveKit RTP or TURN relay traffic.

## Secret bootstrap

Create `deploy/hermes-agent-platform/secrets/` with mode `0700`. Create separate random values for:

- `agent_platform_admin_token` (Lowcoder only);
- `hermes_connector_token` (Hermes Desktop registration only);
- `agent_identity_token` (platform → WorkAdventure identity broker only);
- `postgres_password`;
- `database_url`, including the Postgres password and internal `postgres` host;
- `redis_url` (normally `redis://redis:6379` on the private network);
- `map_storage_authorization` (a complete `Basic <base64(user:password)>` header for WorkAdventure Map Storage's Basic strategy);
- `livekit_api_key` and `livekit_api_secret`;
- `turn_shared_secret`.
- `alert_webhook_url` (an HTTPS destination owned by the operator; stored only in rendered local Alertmanager config).

Use at least 32 random bytes for bearer tokens. The deployment binds secret files under `/run/secrets`; the application rejects an inline value when the corresponding `_FILE` variable is also set. Generated `secrets/` and `runtime/` directories are gitignored.

On the target Map Storage service, set `ENABLE_BASIC_AUTHENTICATION=true` with a dedicated `AUTHENTICATION_USER` and `AUTHENTICATION_PASSWORD`. Disable its bearer strategy for this lane. Build `map_storage_authorization` from exactly that dedicated pair; do not reuse a human or Lowcoder credential.

## Bootstrap

From `deploy/hermes-agent-platform`:

1. Copy `.env.example` to `.env` and replace all example domains, IPs, image tags, WorkAdventure URLs, and email.
2. Export the `.env` values and run `./render-media-config.sh` and `./render-observability-config.sh`.
3. Run `node validate.mjs`.
4. Run `docker compose config --quiet`; inspect the resolved images and published ports.
5. Build and pin an immutable image digest, or set `AGENT_PLATFORM_IMAGE_TAG` to a branch commit SHA.
6. Start `postgres`, `redis`, `agent-platform`, `prometheus`, and `traefik`.
7. Verify `/health/live`, `/health/ready`, the internal Prometheus target, and an empty authenticated agent list.
8. Configure Hermes Desktop from `hermes-desktop.env.example`; its connector and optional media-bridge token files stay on that machine.
9. Confirm the read-only Lowcoder profile catalog reports each expected profile separately before creating agent definitions.

The Postgres migration is idempotent and runs under a database advisory lock. Production startup refuses in-memory storage. Map content and asset mutations enqueue a durable Map Storage operation in the same database transaction; the background worker sends only typed put/delete/move operations with the server-held Basic authorization secret and retries with a capped backoff. Redis desired-state publication is an optimization: if Redis fails, CRUD remains durable and the supervisor polling loop reconciles the persisted definitions; readiness and alerts expose the degraded dependency.

## Capacity gates

Start with one lightweight agent. Move to the next row only after 30 minutes without restart loops, missed heartbeats, or sustained CPU/memory alerts.

| Gate | Maximum | Required observation |
| --- | ---: | --- |
| Lightweight presence/text/navigation | 10 agents | CPU under 70%, RSS under 1.5 GiB, stable room reconnects |
| Simultaneous voice sessions | 2 | Correct invitation/participant binding, no self-audio loop, stop under 1 second |
| Simultaneous virtual cameras | 2 | 640×360, 15 fps, 600 kbps each; no orphan publication |
| Browser compatibility | 2 | Same-identity handoff validated; idle close at 2 minutes; no duplicate Woka |

Do not enable browser mode by default. The map must load the checked-in named Scripting API bridge and the identity handoff must pass before any browser-only capability is advertised.

## Backups and restore drill

Set `BACKUP_DIR` to a dedicated absolute directory on separately backed-up storage and run `./backup.sh`. The script creates a Postgres custom-format dump and SHA-256 sidecar. It reports old files but never deletes them automatically.

Quarterly, restore the newest dump into an isolated pilot stack first. A production-target restore requires the explicit `CONFIRM_RESTORE=agent-platform` guard in `restore.sh`; it stops the control plane, restores database objects, restarts, and checks readiness. After restore, verify map and agent counts, profile bindings, definition versions, and one disabled agent before enabling live agents.

Redis contains transient desired-state notifications, so it is not authoritative and is not part of the backup. Postgres is authoritative for maps, map content/assets, pending Map Storage synchronization, agent definitions, runtime status, audit events, and idempotency results.

## Secret rotation

1. Create a new value without deleting the old recovery material.
2. For the Hermes connector token, stop Hermes Desktop, replace both server and desktop token files, restart the platform, then restart the outbound connector.
3. For the admin token, update the server secret, restart, then replace the server-side Lowcoder connection value. Never store it in a browser-visible Lowcoder state variable.
4. For the identity broker token, rotate WorkAdventure and the platform together while agents are disabled.
5. For LiveKit/TURN, drain meetings, rotate server/WorkAdventure values, render media config, restart media services, and perform a new invitation-bound call.
6. Delete retired material only after health, audit, and pilot checks pass.

## Incident response

| Failure | Expected behavior | Operator action |
| --- | --- | --- |
| Hermes Desktop offline | Wokas may remain present but cannot decide new actions; catalog becomes offline | Stop sensitive meetings, inspect connector logs, restore outbound `wss://` connection |
| WorkAdventure/pusher offline | Agent status becomes degraded and room clients retry | Keep definitions enabled, repair WorkAdventure, verify unique presence after reconnect |
| LiveKit/Coturn failure | Text/movement continue; voice/video stop and camera state clears | Stop media sessions, check direct ports/DNS, validate TURN allocation, retry one agent |
| Redis failure | Durable CRUD continues; readiness/alert shows degradation; polling reconciles | Repair Redis, confirm no definition loss, observe desired-state events |
| Map Storage failure | CRUD remains durable and the outbox retries; exhausted retries fail readiness | Repair authentication/networking, inspect the outbox error metadata, then let ordered retries drain |
| Postgres failure | Readiness fails and administration stops; existing sockets may degrade | Stop writes, repair/restore Postgres, verify schema migration and audit continuity |
| Suspected token leak | Treat the affected trust lane as compromised | Disable agents, rotate only that lane's token, inspect audit/connector metadata, then re-enable |
| Duplicate Woka | Identity handoff or reconnect invariant failed | Disable the definition, stop browser/lightweight sessions, revoke the token, capture logs before retry |

Never solve an outage by giving Lowcoder a movement/media/model endpoint or copying Hermes provider keys to the server.

## Private pilot acceptance

- Import the checked-in JSON into an actual Lowcoder 2.7.6 instance and complete map and agent create/read/update/delete.
- Connect two Hermes profiles with different models and verify catalog isolation.
- Spawn two dedicated OIDC agent identities; verify unique Wokas, avatars, owner bindings, and clean restart recovery.
- From a human browser, test nearby text, movement, follow/approach, invitation accept/decline, voice, interruption, video start/stop, and connector loss.
- Prove audio subscribes only to the invited participant and space.
- Prove camera state matches a real LiveKit publication.
- Run backup/isolated restore and upstream upgrade drills.
- Record CPU, RSS, bandwidth, and reconnect time for each capacity gate.

Do not call the project production-ready until these external checks are attached to Phase 9 issue #11.
