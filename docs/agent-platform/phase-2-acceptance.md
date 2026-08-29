# Phase 2 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #4](https://github.com/WilliamHankey/workadventure/issues/4)

## Delivered

- Versioned Zod protocol shared by the control plane and the Windows-local connector.
- Authenticated outbound WebSocket transport with exponential reconnect and duplicate-instance replacement.
- Local default/named profile discovery from Hermes homes, with loopback-only gateway enforcement by default.
- Authenticated `/v1/capabilities`, `/health/detailed`, and `/v1/models` probes per profile.
- Hermes `/v1/runs`, stable `X-Hermes-Session-Id`/`X-Hermes-Session-Key`, polling, and stop adapter.
- Strict final JSON decision envelope translated into locally correlated WorkAdventure actions; no reliance on an undocumented Runs `tool_calls` field and no steering of a completed run.
- Ordered action-result correlation plus at most two observation-only follow-up rounds.
- One profile gateway object and one bounded event queue per discovered profile.
- Immutable agent/profile/session/version lanes, capability-derived tool allowlists, cancellation, and stale-lane rejection.
- Dynamic safe profile metadata in Lowcoder's read-only catalog.
- Windows PowerShell setup/pairing instructions.

Hermes' official API server documents the probe/run/session-key contracts used here: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md>. Hermes' profile documentation confirms that profiles use independent homes, keys, memory, sessions, and gateway processes: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md>.

## Secret boundary

The connector reads each `API_SERVER_KEY` locally and uses it only for loopback requests. The shared wire protocol has no profile-key field. Tests inspect serialized connector messages and Lowcoder catalog responses to prove local profile and connector-registration secrets are absent.

## Verification

- Shared connector protocol: TypeScript and ESLint passed.
- Windows connector: TypeScript passed; Vitest 5/5 passed; ESLint passed.
- Administration/control-plane service: TypeScript passed; Vitest 8/8 passed; ESLint passed.
- Prettier and `git diff --check`: passed.

The acceptance suite proves safe profile discovery, independent gateway routing, stable bounded session keys, allowed tool-call round trips, rejected unpermitted tools, rejected stale lanes, dynamic catalog sync, authenticated WebSocket delivery, and unchanged Lowcoder command boundaries.

## Published implementation

- `309cda85c8058cb3648351024f09cd731114aaee` — outbound profile-isolated Hermes connector and control-plane hub.

Phase 2 is accepted. Phase 3 may attach real WorkAdventure Woka presence and text tools to these lanes.
