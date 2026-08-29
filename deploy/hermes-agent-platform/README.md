# Hermes agent platform deployment

This directory is the production-pilot substrate for the administration/control plane. It does not contain Hermes profile keys and it does not give Lowcoder any live-agent command route.

1. Copy `.env.example` to `.env` and replace every example host/IP.
2. Create the local `secrets/` files listed by `compose.yaml`; never commit that directory.
3. Run `./render-media-config.sh` and `./render-observability-config.sh` after exporting the variables from `.env`.
4. Run `node validate.mjs` and `docker compose config --quiet`.
5. Start the core plane with `docker compose up -d postgres redis agent-platform alertmanager prometheus traefik`.
6. Add `--profile pilot-media` only after direct UDP/TCP firewall and DNS checks pass.

The platform route exposes the authenticated administration API, authenticated outbound connector WebSocket, health, and documentation. `/metrics`, Postgres, and Redis remain on the internal Docker network. LiveKit and Coturn media ports must be direct; do not put WebRTC/TURN media through a Cloudflare HTTP tunnel.

Configure WorkAdventure Map Storage HTTP Basic authentication and put the complete `Basic <base64(user:password)>` header in the local `map_storage_authorization` secret file. The platform uses it only from the server-side synchronization worker; Lowcoder never receives it.

See [`docs/agent-platform/operator-guide.md`](../../docs/agent-platform/operator-guide.md) for exact bootstrap, recovery, rotation, and pilot procedures.
