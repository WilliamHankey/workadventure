# Phase 7 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #9](https://github.com/WilliamHankey/workadventure/issues/9)

## Delivered

- Immutable-lane video publish, stop, and acknowledged-state protocol messages.
- Hermes-only `wa_start_video` and `wa_stop_video` execution inside the agent's active invitation-bound media session.
- Animated-Woka and configured-asset representation contracts; asset mode fails when its asset reference is absent.
- Loopback Hermes Desktop bridge messages for video start/stop/state.
- WorkAdventure `cameraState` becomes true only after the bridge reports `publishing`, and false after acknowledged stop, media disconnect, meeting leave, or runtime stop.
- Replacement LiveKit invitations stop the previous media session before starting another, preventing orphan audio/video tracks.
- A virtual-camera renderer contract with speaking-state animation phases, frame pacing, exact RGBA-size validation, and a rolling bitrate gate.
- Fixed production ceilings of 640×360, 15 FPS, and 600 kbit/s per virtual camera publication.
- Agent-lane integration tests proving Agent One's camera action never updates Agent Two.
- Lowcoder remains limited to configuring `videoMode`/`videoAssetRef` through agent CRUD and has no live video query.

## Verification

- Focused GitHub Actions run [32690832085](https://github.com/WilliamHankey/workadventure/actions/runs/32690832085): passed.
- Hermes Connector: TypeScript and ESLint passed; Vitest 9/9 passed.
- Agent Platform: TypeScript and ESLint passed; Vitest 21/21 passed in the published Phase 7 commit.
- Shared connector protocol: TypeScript and ESLint passed.
- Lowcoder freshness and 18-query no-live-control checks: passed.
- Pusher identity checks: passed.

The tests cover publish acknowledgement, stop acknowledgement, camera-state synchronization, two-agent isolation, replacement-session teardown, renderer pacing, speaking animation, RGBA validation, and bitrate enforcement.

## Live-environment gate

The real Hermes Desktop media bridge must rasterize the supplied Woka layers or asset, publish the LiveKit camera track, and unpublish all tracks before disconnecting. A real WorkAdventure/LiveKit video call remains part of Phase 9's private pilot because this workspace does not have William's LiveKit service, Chromium/media bridge process, or deployment credentials. No real-call claim is made here.

## Published implementation

- [`be58fdacdccaf29d27f45939cad0967369ed927c`](https://github.com/WilliamHankey/workadventure/commit/be58fdacdccaf29d27f45939cad0967369ed927c) — Hermes virtual-camera protocol, bridge controls, renderer budgets, camera synchronization, and isolation tests.

Phase 7 is code-complete and CI-accepted. Phase 8 may add a resource-bounded browser compatibility lane while leaving the lightweight Woka as the default.
