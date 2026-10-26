CREATE TABLE IF NOT EXISTS application_packages (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  decision_service text NOT NULL,
  ruleset_path text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('flow', 'event-stream')),
  engine text NOT NULL CHECK (engine IN ('drools', 'esper')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  UNIQUE (project_id, decision_service)
);

CREATE TABLE IF NOT EXISTS application_package_manifests (
  id text PRIMARY KEY,
  application_package_id text NOT NULL REFERENCES application_packages(id) ON DELETE CASCADE,
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  release_id text NOT NULL REFERENCES releases(id),
  release_version integer NOT NULL CHECK (release_version >= 1),
  release_display_version text NOT NULL,
  release_checksum text NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  UNIQUE (application_package_id, manifest_version),
  UNIQUE (application_package_id, release_id)
);

CREATE INDEX IF NOT EXISTS application_packages_project_idx
  ON application_packages(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS application_package_manifests_package_idx
  ON application_package_manifests(application_package_id, manifest_version DESC);
