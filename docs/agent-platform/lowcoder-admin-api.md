# Lowcoder administration API skeleton

Status: Phase 0 contract. Implementation has not started.

## Boundary

Lowcoder receives only:

- map CRUD;
- agent CRUD;
- read-only supporting catalogs;
- read-only health/runtime status.

Lowcoder does not receive a general command endpoint. It cannot walk an agent, send in-world messages, start/stop media, invoke Hermes, approve tools, or choose an agent's next action.

## Map CRUD

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/maps` | List maps and draft/published state |
| POST | `/api/v1/maps` | Create a map record and initial WAM/TMJ content |
| GET | `/api/v1/maps/{mapId}` | Read map metadata and validation state |
| PATCH | `/api/v1/maps/{mapId}` | Update metadata, entry points, or publication state |
| DELETE | `/api/v1/maps/{mapId}` | Guarded deletion |
| GET | `/api/v1/maps/{mapId}/content` | Read WAM/TMJ content |
| PUT | `/api/v1/maps/{mapId}/content` | Validate and replace WAM/TMJ content |
| GET | `/api/v1/maps/{mapId}/assets` | List assets |
| PUT | `/api/v1/maps/{mapId}/assets/{assetPath}` | Create or replace an asset |
| DELETE | `/api/v1/maps/{mapId}/assets/{assetPath}` | Delete an unreferenced asset |

The server holds the WorkAdventure Map Storage credential. Lowcoder never receives it.

## Agent CRUD

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/agents` | List definitions and read-only runtime status |
| POST | `/api/v1/agents` | Create an agent bound to one Hermes profile/model |
| GET | `/api/v1/agents/{agentId}` | Read configuration, binding, and status |
| PATCH | `/api/v1/agents/{agentId}` | Update identity, profile/model, Woka, map, owner, behavior, media, limits, or enabled state |
| DELETE | `/api/v1/agents/{agentId}` | Disable, remove, and delete while retaining audit history |

Read-only form catalogs:

- `GET /api/v1/catalog/hermes-profiles`
- `GET /api/v1/catalog/wokas`
- `GET /api/v1/catalog/voices`
- `GET /api/v1/system/health`

## Minimum AgentDefinition

```json
{
  "id": "agent-zackary",
  "display_name": "Zackary",
  "hermes_profile_id": "profile-zackary",
  "model_id": "profile-default",
  "map_id": "meiflume-hq",
  "spawn_point": "agent-office",
  "owner_workadventure_uuid": "william-workadventure-uuid",
  "woka_texture_ids": ["body-01", "eyes-04", "hair-09", "clothes-12"],
  "voice_id": "en-ZA-male-01",
  "video_mode": "animated-woka",
  "behavior_instructions": "Act as William's engineering agent in this world.",
  "initiative_level": "contextual",
  "permissions": {
    "movement": true,
    "listening": true,
    "speaking": true,
    "video": true,
    "browser": false
  },
  "enabled": true,
  "version": 1
}
```

## Internal Hermes action surface

This surface is not exposed to Lowcoder. The connector gives the bound Hermes profile scoped tools such as:

- perception: `wa_get_self_state`, `wa_get_nearby_users`, `wa_get_world_context`, `wa_get_map_areas`;
- navigation: `wa_move_to`, `wa_move_to_area`, `wa_approach_user`, `wa_follow_user`, `wa_stop_moving`;
- conversation: `wa_say`, `wa_direct_message`, `wa_set_status`, `wa_emote`;
- media: `wa_join_meeting`, `wa_leave_meeting`, `wa_speak`, `wa_start_video`, `wa_stop_video`.

Each tool call must carry profile, agent, runtime-session, run, and tool-call identifiers. The policy guard rejects cross-agent, stale-session, invalid-map, invalid-meeting, and disabled-capability calls.

## Write semantics

- Explicit user-triggered Lowcoder writes only.
- Authentication is server-side; no privileged bearer token is returned to the browser.
- Every mutation uses an idempotency key.
- PATCH/PUT/DELETE require an optimistic resource version.
- Validation failures return stable machine-readable error codes and field errors.
- Agent enable/disable is reconciled asynchronously, but it does not control behavior.
