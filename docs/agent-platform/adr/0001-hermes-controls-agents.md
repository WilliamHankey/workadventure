# ADR 0001: Hermes controls every in-world agent

- Status: Accepted
- Date: 2026-08-24
- Decision owners: William Hankey and the MeiFlume agent-platform project

## Context

WorkAdventure provides the world, connected participant, Woka/avatar, chat, proximity-space, and LiveKit media capabilities. Hermes Desktop provides isolated profiles, models, memory, skills, sessions, and tool execution.

The platform needs to turn every selected Hermes profile/model into a real WorkAdventure participant without making Lowcoder an agent controller or exposing Hermes credentials to a browser.

## Decision

1. Lowcoder is an administration surface only.
   - It may create, read, update, and delete maps.
   - It may create, read, update, and delete AgentDefinitions.
   - It may read supporting catalogs and health/runtime status.
   - It may not invoke movement, chat, voice, video, model runs, approvals, or generic agent commands.

2. Each enabled AgentDefinition binds exactly one Hermes profile and model.

3. The bound Hermes model controls the live agent.
   - WorkAdventure and LiveKit events are normalized and sent to that profile/session.
   - Hermes decides whether to do nothing, answer, or call an in-world tool.
   - Every tool call is validated against the same agent identity, current runtime session, map, meeting, owner binding, and capability allowlist.

4. The normal body is a lightweight WorkAdventure protocol client.
   - A small Playwright/browser pool is used only for capabilities that require the supported browser Scripting API.
   - The internal WorkAdventure protocol is isolated behind a version-pinned adapter with contract tests.

5. Voice and video attach to the same WorkAdventure/LiveKit identity.
   - Voice: authorized audio → VAD/STT → bound Hermes profile/model → TTS → agent audio.
   - Video: Hermes may publish a permitted synthetic Woka/avatar camera track.

6. Hermes profile credentials stay on the Hermes machine.
   - A local connector opens an authenticated outbound connection to the platform.
   - Lowcoder and the public platform never receive raw Hermes profile keys.

## Consequences

- There is no Lowcoder live-control drawer or generic command API.
- Updating `enabled` is desired-state administration, not behavioral control.
- Model behavior is observable and auditable, while the runtime remains responsible for identity, transport, media, and safety enforcement.
- A profile/model outage affects only its bound agent lane.
- Full user parity can be added incrementally without running Chromium for every parked agent.
