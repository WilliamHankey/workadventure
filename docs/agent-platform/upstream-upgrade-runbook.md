# Upstream WorkAdventure upgrade runbook

The fork's `master` stays aligned with official WorkAdventure. Project work remains on `feature/hermes-agent-platform`; never push project commits to the official repository.

## Preparation

1. Record the deployed feature commit, database migration version, WorkAdventure image versions, and a successful backup checksum.
2. Disable agent definitions and drain meetings.
3. Fetch the official upstream and inspect release/security notes plus changes under pusher protocol, protobuf messages, identity, spaces, meetings, and LiveKit.
4. Create an isolated upgrade branch in `WilliamHankey/workadventure` from the current feature branch.

## Integration test

1. Merge the selected official upstream commit into the isolated branch without rewriting the preservation branches or fork `master` history.
2. Regenerate protobuf and i18n artifacts.
3. Run the focused Hermes workflow, the WorkAdventure pusher identity contract, Lowcoder build/validation, and deployment validation.
4. Start the isolated Compose stack against a restored copy of production data.
5. Test two-profile presence, text, navigation, invitation-bound voice/video, stop/reconnect, and a clean restart.
6. Compare the capability matrix with the actual runtime. Remove any capability whose underlying stable protocol no longer exists.

## Rollout and rollback

Roll out an immutable image digest to one disabled-agent canary. Enable one lightweight agent, then voice/video gates. If an identity, room-protocol, or media invariant fails, disable definitions, roll back the image digest, and restore the database only if a migration changed persistent data. Attach the tested upstream commit, CI run, pilot evidence, and rollback result to the Phase 9 issue before promoting.
