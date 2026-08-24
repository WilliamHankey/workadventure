# Lowcoder WorkAdventure administration app

This folder contains a portable Lowcoder application for map and agent-definition administration. It was built against Lowcoder 2.7.6's JSON export structure and direct REST query model.

## Import and configure

1. Deploy or open Lowcoder 2.7.6.
2. Choose **New → Import application** and select `workadventure-agent-admin.json`.
3. Open the app in edit or preview mode.
4. Enter the public Agent Platform base URL and `AGENT_PLATFORM_ADMIN_TOKEN` in the password field.
5. Use **Refresh health, maps, agents, and profiles** before editing records.
6. Publish the app only to the administrator group. Do not make it public.

The export contains no token. The token is entered into a password component for the current app session and is injected into the direct REST queries as a bearer header. For a shared installation, replace this with a Lowcoder REST data source whose secret header is stored server-side, then keep the same query inventory.

## Operation

- Select a map/agent row before update or delete. The selected row's `version` becomes `If-Match`.
- Paste a complete create body or partial update body into the corresponding JSON editor.
- Map content accepts `{ "format": "tmj" | "wam", "document": { ... } }`.
- Assets accept `{ "mimeType": "...", "contentBase64": "..." }` and an asset path.
- Every write is manual-triggered by a visible button, carries a fresh idempotency key, and refreshes its list after success.
- A 409 response means the selected version is stale or a dependency prevents deletion. Refresh before retrying.

Hermes profiles and agent runtime fields are read-only. There are no movement, chat, model-run, voice, video, media, spawn/stop, approval, or generic-command queries.

## Validate and regenerate

```bash
node lowcoder/build-app.mjs --check
node lowcoder/validate.mjs
```

After intentionally changing the builder, regenerate the import file with `node lowcoder/build-app.mjs`, review the JSON diff, and rerun both checks. Roll back by re-importing the previously reviewed JSON export into a new Lowcoder app; the application itself stores no registry data.
