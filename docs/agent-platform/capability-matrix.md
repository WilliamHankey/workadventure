# Agent capability matrix

This is the honest parity contract for the Hermes-controlled WorkAdventure agent. A capability is advertised to Hermes only when the current runtime has an implementation and the AgentDefinition grants it.

| Normal-user capability | Status | Runtime and boundary |
| --- | --- | --- |
| Named Woka/avatar and presence | Implemented | Lightweight authenticated room client |
| Walk, stop, follow, approach | Implemented | Hermes tools; collision-aware headless navigation |
| Nearby bubble conversation | Implemented | Room protocol events and `wa_say` |
| Status and emotes | Implemented | Room protocol |
| Accept/decline and join/leave meetings | Implemented | Hermes-only tools plus WorkAdventure invitation/space protocol |
| Hear and speak in a consenting call | Implemented; real-media pilot required | Invitation-bound LiveKit token; local Hermes bridge VAD/STT/TTS |
| Virtual avatar camera | Implemented; real-media pilot required | Hermes-only publication; local bridge renderer/LiveKit track |
| Map/agent administration | Implemented | Lowcoder map CRUD and agent CRUD only |
| Co-website open/close | Browser compatibility implementation; disabled by default | On-demand Playwright pool plus allowlisted map Scripting API bridge. Requires the bridge script, Chromium image, and explicit browser permission. It is not advertised in the default Hermes binding. |
| Private/direct Matrix message | Unavailable | WorkAdventure's room socket has no stable direct-message operation. `wa_direct_message` remains reserved in the protocol but is deliberately not advertised. |
| Screen sharing | Unavailable by policy | Would expose arbitrary desktop content; no Hermes tool is advertised. |
| Map editing or file upload as a live user | Unavailable by policy | Lowcoder performs map CRUD; live agents cannot edit maps or upload files. |
| Invite users or moderate participants | Unavailable by policy | Requires a separate reviewed moderation phase and permission model. |
| Arbitrary browser selectors/navigation | Unavailable by policy | The browser pool accepts named bridge actions only; no generic command/selector tool exists. |

## Browser compatibility contract

- At most two browser sessions by default.
- One action at a time per agent.
- Browser crash gets one clean recovery attempt.
- Idle sessions close after two minutes by default.
- Co-website origins must be explicitly allowlisted.
- The driver injects the short-lived WorkAdventure identity token only into the room URL and never logs it.
- Commands execute only inside a frame that exposes the checked-in `__waHermesBridge`; the driver never evaluates arbitrary Hermes-supplied JavaScript.
- The bridge exposes only `open_co_website` and `close_co_website` today.

The browser pool is a compatibility gate, not the primary runtime. It must remain disabled until the target map loads `agent-platform/browser-bridge/hermes-agent-bridge.js`, the deployment provides Playwright 1.60.0 plus a compatible Chromium executable, and the same-identity handoff is validated in the private pilot.
