CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspaces (id, name) VALUES ('default', '默认工作空间') ON CONFLICT DO NOTHING;
INSERT INTO projects (id, workspace_id, name) VALUES ('default', 'default', '默认项目') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  asset_type text NOT NULL CHECK (asset_type IN ('rule', 'table', 'flow')),
  revision bigint NOT NULL CHECK (revision >= 1),
  draft jsonb NOT NULL,
  published jsonb,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_project_type_idx ON assets(project_id, asset_type, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_revisions (
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 1),
  draft jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('created', 'saved', 'restored')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (asset_id, revision)
);

CREATE TABLE IF NOT EXISTS asset_versions (
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (asset_id, version)
);

CREATE TABLE IF NOT EXISTS bom_versions (
  project_id text NOT NULL REFERENCES projects(id),
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (project_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS bom_one_active_idx ON bom_versions(project_id) WHERE active;

CREATE TABLE IF NOT EXISTS test_suites (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  revision bigint NOT NULL CHECK (revision >= 1),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_type text NOT NULL CHECK (target_type IN ('rule', 'table', 'flow')),
  target_asset_id text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  cases jsonb NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_run_id text
);
CREATE INDEX IF NOT EXISTS test_suites_target_idx ON test_suites(project_id, target_type, target_asset_id, archived);

CREATE TABLE IF NOT EXISTS test_runs (
  id text PRIMARY KEY,
  suite_id text NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  target_version integer,
  passed boolean NOT NULL,
  report jsonb NOT NULL,
  run_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS test_runs_suite_idx ON test_runs(suite_id, run_at DESC);
ALTER TABLE test_suites DROP CONSTRAINT IF EXISTS test_suites_last_run_fk;
ALTER TABLE test_suites ADD CONSTRAINT test_suites_last_run_fk FOREIGN KEY (last_run_id) REFERENCES test_runs(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS releases (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  decision_service text NOT NULL,
  release_version integer NOT NULL CHECK (release_version >= 1),
  target_type text NOT NULL CHECK (target_type IN ('rule', 'table', 'flow')),
  target_asset_id text NOT NULL,
  checksum text NOT NULL,
  content jsonb NOT NULL,
  row_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, decision_service, release_version),
  UNIQUE (checksum, id)
);
CREATE INDEX IF NOT EXISTS releases_created_idx ON releases(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  environment text NOT NULL,
  deployed_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  UNIQUE (release_id, environment, id)
);
CREATE INDEX IF NOT EXISTS deployments_release_idx ON deployments(release_id, deployed_at);
