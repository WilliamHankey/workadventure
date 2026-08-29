# Phase 0 repository and migration checklist

## Repository safety

- [x] Confirm the authenticated owner is `WilliamHankey`.
- [x] Create a proper fork at `WilliamHankey/workadventure`.
- [x] Verify the fork parent/source is `workadventure/workadventure`.
- [x] Verify fork `master` and upstream `master` both point to `f03bc682e43f3c96dab5925948a68bbbdf66ae25`.
- [x] Create `feature/hermes-agent-platform` from that exact SHA.
- [x] Keep `master` free of project commits.
- [x] Enable GitHub Issues on the fork.
- [x] Preserve the PoC SHA with `archive/poc-2026-08-14`.
- [ ] Add optional annotated tag `poc-2026-08-14` when a tag-capable authenticated surface is available.
- [x] Create `WilliamHankey/workadventure-agent-world` from the official map starter template.
- [x] Record and verify the generated map repository baseline.

## Migration rules

- [x] Treat `workadventure-ai-npc` as evidence and migration input, not as upstream history.
- [x] Do not delete, rename, archive, overwrite, or force-push the PoC.
- [x] Do not merge the PoC root snapshot into the fork.
- [x] Document the accepted Hermes-controlled architecture before implementation.
- [x] Begin implementation in small, reviewed commits only after Phase 0 closed.
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

- [x] the map project exists and its baseline is recorded;
- [x] the baseline documentation is reviewed;
- [x] phase tracking issues are created; milestones are deferred until release grouping is useful;
- [x] the untouched upstream baseline smoke/build procedure is recorded or run in the connected Codex environment;
- [x] William explicitly accepts the Phase 0 checkpoint.
