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
- No project commit was written to `master`.

## Existing proof of concept

- Repository: https://github.com/WilliamHankey/workadventure-ai-npc
- Default branch: `ai-npc`
- Preserved commit: `d5c11261a0d7708cdd6d064607e97dd593fcf3bc`
- Preservation branch: `archive/poc-2026-08-14`
- The preservation branch points to the original PoC root commit.
- An annotated `poc-2026-08-14` tag remains desirable; the current GitHub connector does not expose tag creation.

## Map starter baseline

- Required repository: `WilliamHankey/workadventure-agent-world`
- Status at this checkpoint: not yet created.
- Source template: `workadventure/map-starter-kit`
- Recorded template `master`: `7fa5e41701761085fac1e1113d73557d833af5b8`

## Change boundary

The commits on `feature/hermes-agent-platform` at this checkpoint contain planning and architecture documentation only. No WorkAdventure runtime, map, bot, Hermes connector, Lowcoder API, media, authentication, or deployment implementation has started.
