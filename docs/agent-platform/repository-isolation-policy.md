# Repository isolation policy

Status: accepted Phase 0 constraint  
Owner: William Hankey  
Date: 2026-08-24

## Rule

All MeiFlume WorkAdventure agent-platform development stays inside repositories owned by `WilliamHankey`.

- Writable fork: `WilliamHankey/workadventure`
- Read-only upstream reference: `workadventure/workadventure`
- Project branch: `feature/hermes-agent-platform`
- Pull-request base: `WilliamHankey/workadventure:master`

No project branch, commit, tag, release, pull request, or deployment action may target the original `workadventure/workadventure` repository.

## Remote configuration

A local Codex checkout should use:

```bash
git remote set-url origin https://github.com/WilliamHankey/workadventure.git
git remote add upstream https://github.com/workadventure/workadventure.git
git config remote.upstream.pushurl DISABLED
```

If `upstream` already exists, keep its fetch URL but set its push URL to `DISABLED`.

Required pre-write checks:

```bash
git remote -v
git branch --show-current
git status --short
```

Expected behavior:

- `origin` may fetch and push only William's fork.
- `upstream` may fetch official changes but must fail on push.
- Feature work is pushed only to `origin/feature/hermes-agent-platform`.
- Pull requests are opened only within `WilliamHankey/workadventure`.

## Upstream updates

Official WorkAdventure updates may be fetched and reviewed:

```bash
git fetch upstream master
git log --oneline --decorate --max-count=10 upstream/master
```

Merging or rebasing an upstream update into the project branch requires a compatibility review. It does not authorize any write back to the original repository.

## Safety checks

Before any automated push or pull-request action:

1. assert the repository owner is `WilliamHankey`;
2. assert the destination repository is `WilliamHankey/workadventure`;
3. assert the destination branch is not the official upstream;
4. refuse force-pushes and history deletion;
5. keep `master` clean until a reviewed internal PR is deliberately merged.

The connected GitHub account currently has push permission on William's fork and no push permission on `workadventure/workadventure`, providing an additional provider-level safety boundary.
