CREATE TABLE IF NOT EXISTS deployment_targets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  environment_id text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('drools', 'esper')),
  endpoint text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('unknown', 'ready', 'unreachable', 'mismatch')),
  node_id text,
  engine_version text,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  UNIQUE (project_id, environment_id, endpoint),
  FOREIGN KEY (project_id, environment_id) REFERENCES environments(project_id, id)
);

CREATE TABLE IF NOT EXISTS activation_generations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_package_id text NOT NULL REFERENCES application_packages(id) ON DELETE CASCADE,
  manifest_id text NOT NULL REFERENCES application_package_manifests(id),
  release_id text NOT NULL REFERENCES releases(id),
  decision_service text NOT NULL,
  environment_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  expected_generation bigint NOT NULL CHECK (expected_generation >= 0),
  status text NOT NULL CHECK (status IN ('preparing', 'activating', 'active', 'draining', 'failed')),
  targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  activated_at timestamptz,
  failed_at timestamptz,
  error text,
  FOREIGN KEY (project_id, environment_id) REFERENCES environments(project_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS activation_generations_active_idx
  ON activation_generations(project_id, decision_service, environment_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS deployment_targets_project_idx
  ON deployment_targets(project_id, environment_id, enabled);
CREATE INDEX IF NOT EXISTS activation_generations_project_idx
  ON activation_generations(project_id, decision_service, environment_id, generation DESC);
