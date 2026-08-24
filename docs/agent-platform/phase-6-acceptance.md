# Phase 6 acceptance record

Date: 24 August 2026 (Africa/Johannesburg)  
Branch: `WilliamHankey/workadventure:feature/hermes-agent-platform`  
Tracker: [issue #8](https://github.com/WilliamHankey/workadventure/issues/8)

## Delivered

- Human meeting invitations become Hermes world events; only the bound model can accept or decline with `wa_join_meeting`.
- The headless Woka follows WorkAdventure's current meeting-response, move-to-inviter, join-space query, space roster, private LiveKit invitation, and disconnect protocol.
- LiveKit tokens are accepted only for the consented space and participant, then forwarded over the authenticated immutable agent/profile/session lane to Hermes Desktop.
- Connector protocol messages for media invitation, ready, transcript, speech publication/result, stop, and audit state.
- Server-side and desktop-side participant identity/UUID checks, preventing cross-agent, cross-profile, cross-session, cross-space, and cross-participant audio injection.
- Fixed RMS VAD, bounded utterance duration, one STT lifecycle per utterance, transcript normalization, local TTS, barge-in, loop prevention, and idempotent immediate stop.
- A loopback-only Hermes Desktop media-bridge adapter. Raw profile/provider keys stay local; a missing bridge fails closed with `media_adapter_unavailable`.
- Voice/listening indicators are synchronized only after the local media bridge reports ready.
- `wa_speak` publishes only through an active invitation-bound session and returns the actual publication/interruption/failure result to Hermes.
- Transcript policy defaults to audit metadata rather than full retention.

## Control boundary

Lowcoder still has exactly 18 administration queries and no voice, meeting, media, model-run, or live-control route. A human invitation does not auto-accept or start the microphone. The bound Hermes model must accept the invitation and later call `wa_speak`; the administration plane cannot do either.

## Verification

- Focused GitHub Actions run [32690088785](https://github.com/WilliamHankey/workadventure/actions/runs/32690088785): passed.
- Hermes Connector: TypeScript and ESLint passed; Vitest 8/8 passed in the published Phase 6 commit.
- Agent Platform: TypeScript and ESLint passed; Vitest 21/21 passed.
- Shared connector protocol: TypeScript and ESLint passed.
- Lowcoder freshness and no-live-control boundary checks: passed.
- Pusher identity adapter checks: passed.
- Local post-commit suite additionally exercises the Phase 7 camera work without weakening these voice checks.

The synthetic PCM test proves authorized-speaker filtering, VAD, one STT result, transcript routing, local TTS publication, barge-in, and idempotent stop. The agent-runtime integration test proves transcript → correct Hermes lane → `wa_speak` → same media session, while another agent remains untouched.

## Live-environment gate

The repository cannot manufacture William's LiveKit deployment, WorkAdventure meeting, Hermes Desktop process, microphone, STT/TTS providers, or local bridge credentials. Production acceptance therefore still requires one real invitation/call using the loopback bridge documented in `hermes-connector/README.md`. Phase 9's pilot checklist owns that external test. No claim of a completed real call is made here.

## Published implementation

- [`b957c9912c92f7a0d3581e78ad2bb3914252ff97`](https://github.com/WilliamHankey/workadventure/commit/b957c9912c92f7a0d3581e78ad2bb3914252ff97) — invitation-bound WorkAdventure/LiveKit voice lane, local bridge, VAD/STT/TTS core, and synthetic isolation tests.

Phase 6 is code-complete and CI-accepted. Phase 7 may add virtual video publication over the same consented media session.
