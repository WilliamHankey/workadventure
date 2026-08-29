BEGIN;

CREATE TABLE agent_platform_maps (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    room_url text,
    description text,
    state text NOT NULL CHECK (state IN ('draft', 'published', 'archived')),
    entry_points jsonb NOT NULL DEFAULT '[]'::jsonb,
    validation_state text NOT NULL CHECK (validation_state IN ('pending', 'valid', 'invalid')),
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    version integer NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE agent_platform_map_content (
    map_id uuid PRIMARY KEY REFERENCES agent_platform_maps(id) ON DELETE CASCADE,
    format text NOT NULL CHECK (format IN ('tmj', 'wam')),
    document jsonb NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    updated_at timestamptz NOT NULL
);

CREATE TABLE agent_platform_map_assets (
    map_id uuid NOT NULL REFERENCES agent_platform_maps(id) ON DELETE CASCADE,
    path text NOT NULL,
    mime_type text NOT NULL,
    content bytea NOT NULL,
    checksum text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (map_id, path)
);

CREATE TABLE agent_platform_agents (
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    description text,
    hermes_profile_id text NOT NULL UNIQUE,
    model_id text NOT NULL,
    map_id uuid NOT NULL REFERENCES agent_platform_maps(id) ON DELETE RESTRICT,
    spawn_point text NOT NULL,
    owner_workadventure_uuid text NOT NULL,
    definition jsonb NOT NULL,
    control_mode text NOT NULL DEFAULT 'hermes' CHECK (control_mode = 'hermes'),
    enabled boolean NOT NULL DEFAULT false,
    runtime_status text NOT NULL DEFAULT 'offline',
    runtime_error_code text,
    version integer NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE agent_platform_audit_events (
    id bigserial PRIMARY KEY,
    action text NOT NULL,
    actor text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL
);

CREATE TABLE agent_platform_idempotency (
    idempotency_key text PRIMARY KEY,
    fingerprint text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE TABLE agent_platform_desired_state_outbox (
    id bigserial PRIMARY KEY,
    event_type text NOT NULL CHECK (event_type IN ('agent.definition.changed', 'agent.definition.deleted')),
    agent_id uuid NOT NULL,
    definition_version integer NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    published_at timestamptz
);

CREATE INDEX agent_platform_outbox_pending_idx
    ON agent_platform_desired_state_outbox (id)
    WHERE published_at IS NULL;

COMMIT;
