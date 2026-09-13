CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  department_id uuid REFERENCES departments(id),
  position text NOT NULL,
  manager_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS role_assignments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  scope_type text NOT NULL CHECK (scope_type IN ('organization','department','resource')),
  scope_value text,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (user_id, role_id, scope_type, scope_value)
);

CREATE TABLE IF NOT EXISTS organization_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organization_meta(singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS policies (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES policies(id),
  version integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  rules jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('draft','published','retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(policy_id, version)
);
CREATE INDEX IF NOT EXISTS policy_versions_search_idx ON policy_versions USING gin ((title || ' ' || body) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1,
  requester_id uuid NOT NULL REFERENCES users(id),
  description text NOT NULL,
  structured_input jsonb NOT NULL DEFAULT '{}',
  external_id text,
  idempotency_key text,
  context jsonb,
  context_confirmed_at timestamptz,
  status text NOT NULL,
  policy_snapshot jsonb,
  organization_version integer,
  plan jsonb,
  validation jsonb,
  risk text,
  context_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requester_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id),
  request_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  stage text NOT NULL DEFAULT 'understanding',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid,
  understanding_output jsonb,
  policy_snapshot jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id, request_revision)
);
CREATE INDEX IF NOT EXISTS analysis_jobs_claim_idx ON analysis_jobs(status, available_at, lease_until);

CREATE TABLE IF NOT EXISTS approval_steps (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id),
  request_revision integer NOT NULL,
  step_order integer NOT NULL,
  selector jsonb NOT NULL,
  assignee_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  policy_version_ids jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('waiting','pending','approved','rejected','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acted_at timestamptz,
  UNIQUE(request_id, request_revision, step_order)
);

CREATE TABLE IF NOT EXISTS approval_actions (
  id uuid PRIMARY KEY,
  step_id uuid NOT NULL REFERENCES approval_steps(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('approve','reject','request_information')),
  comment text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  request_id uuid REFERENCES requests(id),
  request_revision integer,
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
