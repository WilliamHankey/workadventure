# Phase 4 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #6](https://github.com/WilliamHankey/workadventure/issues/6)

## Delivered

- Finite orthogonal TMJ parser for uncompressed tile layers, inline `collides` metadata, named WorkAdventure areas, and configured entry points.
- WAM area overlay support with a bounded `mapUrl` loader or embedded `tiledMap` navigation snapshot.
- Fail-closed handling for unknown external TSJ, compressed/chunked, infinite, and non-orthogonal navigation sources.
- Navigation-graph cache keyed by map and content version.
- Bounded collision-aware A* pathfinding with named-area target selection.
- Current binary `userMovesMessage` frames with direction, moving state, and viewport updates.
- Hermes-only move, move-to-area, approach, follow, and stop actions.
- Owner UUID as the default approach/follow target and as read-only Hermes world context.
- Follow replanning after owner movement and preservation across ordinary room-socket reconnects.
- Immediate stop state plus completed, failed, and cancelled tool outcomes and world observations.
- Exact agent/profile/session lane enforcement for navigation, with no Lowcoder movement route.

## Safety and control boundary

Lowcoder can only store map content and agent definitions. A definition's movement permission controls which navigation tools appear in its immutable connector binding. Only the bound Hermes profile/model can invoke those tools; another agent, profile, session epoch, or admin request cannot move the Woka.

Navigation parsing fails closed when collision fidelity is not known. The authenticated Woka may still join for text/presence, but its movement call fails instead of treating unknown tiles as walkable.

## Verification

- Focused GitHub Actions run [32687722887](https://github.com/WilliamHankey/workadventure/actions/runs/32687722887): passed.
- Agent platform: TypeScript passed; ESLint passed; Prettier passed; Vitest 17/17 passed.
- Hermes Connector: TypeScript passed; ESLint passed; Vitest 5/5 passed.
- Shared connector protocol: TypeScript and ESLint passed.
- Pusher identity adapter: pusher TypeScript and identity tests passed in the focused workflow.
- `git diff --check`: passed.

The suite proves collision detours, named TMJ/WAM areas, graph caching, current protocol movement frames, typed completion, immediate cancellation, owner-follow replanning after reconnect, and two-agent movement lane isolation.

## Published implementation

- [`54bf2dc80b88026650af0471e49f648622710c5e`](https://github.com/WilliamHankey/workadventure/commit/54bf2dc80b88026650af0471e49f648622710c5e) — Hermes-owned collision-aware navigation and owner binding.

Phase 4 is accepted. Phase 5 may add the Lowcoder administration app without adding any live agent control.
