# Phase 0 repository and migration checklist

## Repository safety

- [x] Confirm the authenticated owner is `WilliamHankey`.
- [x] Create a proper fork at `WilliamHankey/workadventure`.
- [x] Verify the fork parent/source is `workadventure/workadventure`.
- [x] Verify fork `master` and upstream `master` both point to `f03bc682e43f3c96dab5925948a68bbbdf66ae25`.
- [x] Create `feature/hermes-agent-platform` from that exact SHA.
- [x] Keep `master` free of project commits.
- [x] Preserve the PoC SHA with `archive/poc-2026-08-14`.
- [ ] Add annotated tag `poc-2026-08-14` to the PoC when a tag-capable GitHub surface is available.
- [ ] Create `WilliamHankey/workadventure-agent-world` from the official map starter template.
- [ ] Record and verify the generated map repository baseline.

## Migration rules

- [x] Treat `workadventure-ai-npc` as evidence and migration input, not as upstream history.
- [x] Do not delete, rename, archive, overwrite, or force-push the PoC.
- [x] Do not merge the PoC root snapshot into the fork.
- [x] Document the accepted Hermes-controlled architecture before implementation.
- [ ] Port useful PoC components in small, reviewed commits only after Phase 0 closes.
- [ ] Add a source-to-target inventory for each migrated module.
- [ ] Add a regression test with each migrated behavior.
- [ ] Remove Zackary/Wally hard-coding as code is migrated.
- [ ] Replace the direct LLM bridge with the profile-bound Hermes connector.
- [ ] Replace LiveKit room listing/largest-room selection with invitation-bound media.
- [ ] Fix voice trailing-silence detection and shared STT model lifecycle.

## Administration boundary

- [x] Lowcoder is limited to map CRUD and agent CRUD.
- [x] Hermes profile/model controls every enabled agent.
- [x] No Lowcoder movement, chat, voice, video, model-run, approval, or generic command endpoint is planned.
- [x] Agent `enabled` is desired state, not a behavioral command.

## Phase 0 exit gate

Phase 1 must not start until:

- [ ] the map project exists and its baseline is recorded;
- [ ] the baseline documentation is reviewed;
- [ ] tracking issues are enabled/created;
- [ ] the untouched upstream baseline smoke/build procedure is recorded or run in the connected Codex environment;
- [ ] William explicitly accepts the Phase 0 checkpoint.
