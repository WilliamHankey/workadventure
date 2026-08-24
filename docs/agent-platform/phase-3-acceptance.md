# Phase 3 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #5](https://github.com/WilliamHankey/workadventure/issues/5)

## Delivered

- Disabled-by-default WorkAdventure service-identity broker protected by a dedicated bearer token.
- Fifteen-minute WorkAdventure JWTs marked as service identities, with no Hermes profile or provider key claims.
- A current-protocol binary room client using `@workadventure/messages`, API version validation, monotonic nonces, keepalive replies, duplicate suppression, reconnect, and replay.
- One visible Woka per enabled agent definition, using the configured name, Woka textures, companion, room URL, and spawn point.
- Per-agent roster, position, status, speech-bubble, and emote state derived from WorkAdventure room events.
- Stable conversation/session identifiers and exact agent/profile/session/version routing into Hermes Desktop.
- Hermes-owned `wa_say`, `wa_set_status`, `wa_emote`, and read-only world-state tools with typed results.
- Reconciliation when agent or map definitions change, without adding any Lowcoder live-action route.
- Focused GitHub Actions verification for the shared protocol, connector, control plane, pusher identity adapter, and runtime.

## Identity and secret boundary

Upstream WorkAdventure room sockets accept WorkAdventure-signed JWTs rather than raw identity-provider tokens. This fork adds a narrow internal service-identity endpoint at `/internal/agent-identities/token`. It is absent unless `AGENT_IDENTITY_TOKEN` is configured, compares the bearer secret in constant time, issues a short-lived token, and returns `Cache-Control: no-store`.

Hermes profile keys remain on Hermes Desktop. The runtime sends the identity broker only `{ agentId, displayName }`; no profile home, model-provider key, `API_SERVER_KEY`, or Hermes session secret is present.

## Verification

- Administration/runtime: TypeScript passed; ESLint passed; Prettier passed; Vitest 12/12 passed.
- Pusher identity adapter: pusher TypeScript project passed; ESLint passed; Vitest 2/2 passed.
- Hermes Connector: TypeScript passed; ESLint passed; Vitest 5/5 passed.
- Shared connector protocol: TypeScript and ESLint passed.
- `git diff --check`: passed.

The suite proves configured Woka join data, roster and speech event normalization, ping handling, duplicate-frame suppression, reconnect replay, two-agent lane isolation, an inbound human message reaching only the intended Hermes lane, and the resulting `wa_say` reply reaching only that agent's room client.

## Published implementation

- [`614cf061e01c1afcb21aa4d50e13b552968421d7`](https://github.com/WilliamHankey/workadventure/commit/614cf061e01c1afcb21aa4d50e13b552968421d7) — authenticated WorkAdventure Woka runtime and Hermes text actions.

Phase 3 is accepted. Phase 4 may add collision-aware navigation and owner-follow behavior to the same immutable lanes.
