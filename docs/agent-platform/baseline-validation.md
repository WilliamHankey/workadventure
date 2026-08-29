# Phase 0 baseline validation

Date: 2026-08-24  
Repository: `WilliamHankey/workadventure`  
Baseline commit: `f03bc682e43f3c96dab5925948a68bbbdf66ae25`  
Validation target: exact upstream/fork `master` baseline in a detached worktree

## Outcome

The focused backend baseline is healthy after following the repository's documented protobuf-generation prerequisite.

| Check | Result |
| --- | --- |
| Baseline identity | PASS — detached worktree at the exact upstream/fork master SHA |
| Dependency install | PASS |
| Protobuf generation | PASS |
| Backend TypeScript check | PASS |
| Backend unit tests | PASS — 23 files passed; 227 tests passed; 2 skipped |
| Tracked worktree state | PASS — clean after validation |
| Docker Compose smoke test | NOT RUN — Docker is not installed in the execution environment |

## Environment

- Node.js: `v24.19.0`
- npm: `11.9.0`
- Docker: unavailable (`docker: command not found`)

## Commands

The npm cache and log directories were explicitly redirected to writable temporary paths for this execution environment.

```bash
npm ci --cache=/tmp/wa-npm-cache --logs-dir=/tmp/wa-npm-logs \
  --workspace=back --ignore-scripts --no-audit --no-fund

cd messages
npm ci --cache=/tmp/wa-npm-cache --logs-dir=/tmp/wa-npm-logs \
  --no-audit --no-fund
npm run ts-proto
cd ..

npm run typecheck --workspace=back
npm test --workspace=back -- --run
```

## Prerequisite observed

A direct backend typecheck before protobuf generation failed because
`libs/messages/src/ts-proto-generated` was absent. This is expected for a
fresh checkout and is documented in `back/AGENTS.md`,
`messages/AGENTS.md`, and `docs/agent/common-issues.md`. After running
`npm run ts-proto` from `messages/`, typecheck and tests passed.

Generated protobuf output is git-ignored. Validation left no tracked changes.

## Isolation

- No command pushed to or modified `workadventure/workadventure`.
- No implementation code was added during Phase 0 validation.
- Planning records remain confined to
  `WilliamHankey/workadventure:feature/hermes-agent-platform`.
- `WilliamHankey/workadventure:master` remains at the clean upstream
  baseline SHA above.
