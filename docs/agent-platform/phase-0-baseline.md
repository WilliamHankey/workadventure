# Phase 0 baseline record

Date: 2026-08-24

## WorkAdventure fork

- Repository: https://github.com/WilliamHankey/workadventure
- GitHub reports `fork: true`.
- Parent/source: `workadventure/workadventure`
- Default branch: `master`
- Verified upstream `master`: `f03bc682e43f3c96dab5925948a68bbbdf66ae25`
- Verified fork `master`: `f03bc682e43f3c96dab5925948a68bbbdf66ae25`
- Result: the fork baseline exactly matched upstream before project commits.
- Project branch: `feature/hermes-agent-platform`
- The project branch was created directly from the verified upstream SHA.
- GitHub Issues are enabled on the fork.
- No project commit was written to `master`.

## Existing proof of concept

- Repository: https://github.com/WilliamHankey/workadventure-ai-npc
- Default branch: `ai-npc`
- Preserved commit: `d5c11261a0d7708cdd6d064607e97dd593fcf3bc`
- Preservation branch: `archive/poc-2026-08-14`
- The preservation branch points to the original PoC root commit.
- The archive branch is the authoritative remote preservation reference.
- An annotated `poc-2026-08-14` tag remains optional; the connected GitHub API does not expose annotated-tag creation.

## Map starter baseline

- Repository: https://github.com/WilliamHankey/workadventure-agent-world
- Source template: `workadventure/map-starter-kit`
- Recorded template `master`: `7fa5e41701761085fac1e1113d73557d833af5b8`
- Generated repository `master`: `e7174b04c43afd6954a933fd8ef7d8789163cdec`
- Template tree: `8a2b4550fce8fee0037ed823ea555215931e3b54`
- Generated repository tree: `8a2b4550fce8fee0037ed823ea555215931e3b54`
- Result: the generated repository exactly matches the official template tree.
- Only the template's default branch was included.

## Change boundary

The commits on `feature/hermes-agent-platform` at this checkpoint contain planning and architecture documentation only. No WorkAdventure runtime, bot, Hermes connector, Lowcoder API, media, authentication, or deployment implementation has started. The separate map repository contains only the generated official template baseline.
