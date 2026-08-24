# Phase 8 acceptance record

Date: 24 August 2026

Repository: `WilliamHankey/workadventure`

Branch: `feature/hermes-agent-platform`

Issue: [#10](https://github.com/WilliamHankey/workadventure/issues/10)

## Accepted implementation

- On-demand Playwright 1.60.0 compatibility driver using the version already pinned by the WorkAdventure monorepo.
- Global browser-session cap of two by default, per-agent action serialization, two-minute idle shutdown, and one clean recovery attempt.
- Checked-in WorkAdventure Scripting API bridge with only named `open_co_website` and `close_co_website` actions.
- Explicit co-website origin allowlist and per-agent browser permission.
- No arbitrary Hermes-supplied JavaScript, selector, browser navigation, or generic browser command.
- Exact capability matrix covering implemented, pilot-gated, and unavailable normal-user actions.
- `wa_direct_message` removed from advertised bindings because the current lightweight runtime has no stable private Matrix-message operation.
- Contract test proving every advertised Hermes tool has a concrete supervisor implementation.
- Lowcoder remains at exactly 18 administration-only queries with no live-control route.

## Verification

- Agent platform typecheck and lint: passed.
- Agent platform tests: 9 files, 25 tests passed.
- Hermes Connector typecheck and lint: passed.
- Hermes Connector tests: 3 files, 9 tests passed.
- Connector protocol typecheck and lint: passed.
- Lowcoder boundary validator: 18 allowed queries and no live-control route.
- Clean npm lockfile regeneration: passed offline.
- GitHub focused workflow: [run 32691813005](https://github.com/WilliamHankey/workadventure/actions/runs/32691813005), passed.

## Commits

- [`e6ff557fc2242e766cb82d0b260c66d0e3c48754`](https://github.com/WilliamHankey/workadventure/commit/e6ff557fc2242e766cb82d0b260c66d0e3c48754) — bounded browser compatibility layer and capability contract.
- [`285724424b5e04563e20f449a1f0e236156eb1f1`](https://github.com/WilliamHankey/workadventure/commit/285724424b5e04563e20f449a1f0e236156eb1f1) — complete dependency lockfile publication.

## Pilot gate

The browser compatibility runtime stays disabled by default until the target map loads the checked-in bridge, the deployment image contains a compatible Chromium executable, and the same WorkAdventure agent identity can be handed from the lightweight runtime to the browser runtime without duplicate presence. Phase 9 owns that live validation. This gate is explicit and no browser-only capability is advertised before it passes.

Phase 8 is accepted. Phase 9 may proceed with production hardening and the private pilot.
