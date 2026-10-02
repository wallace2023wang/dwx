CREATE TABLE IF NOT EXISTS change_sets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  revision bigint NOT NULL CHECK (revision >= 1),
  status text NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS change_sets_project_status_idx ON change_sets(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES projects(id),
  actor text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_project_time_idx ON audit_events(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events(project_id, resource_type, resource_id, sequence DESC);
