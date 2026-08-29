CREATE TABLE IF NOT EXISTS agent_platform_schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_platform_maps (
    id text PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_platform_map_contents (
    map_id text PRIMARY KEY REFERENCES agent_platform_maps(id) ON DELETE CASCADE,
    record jsonb NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_platform_map_assets (
    map_id text NOT NULL REFERENCES agent_platform_maps(id) ON DELETE CASCADE,
    path text NOT NULL,
    record jsonb NOT NULL,
    content bytea NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (map_id, path)
);

CREATE TABLE IF NOT EXISTS agent_platform_agents (
    id text PRIMARY KEY,
    hermes_profile_id text NOT NULL UNIQUE,
    map_id text NOT NULL REFERENCES agent_platform_maps(id) ON DELETE RESTRICT,
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_platform_agents_map_id_idx ON agent_platform_agents(map_id);

CREATE TABLE IF NOT EXISTS agent_platform_audit_events (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action text NOT NULL,
    actor text NOT NULL CHECK (actor = 'lowcoder'),
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    outcome text NOT NULL,
    occurred_at timestamptz NOT NULL,
    metadata jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_platform_audit_events_occurred_at_idx
    ON agent_platform_audit_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS agent_platform_idempotency (
    key text PRIMARY KEY,
    fingerprint text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_platform_idempotency_expires_at_idx
    ON agent_platform_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS agent_platform_map_storage_outbox (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation text NOT NULL CHECK (operation IN ('put', 'delete', 'move')),
    payload jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_platform_map_storage_outbox_available_idx
    ON agent_platform_map_storage_outbox(available_at, sequence);
