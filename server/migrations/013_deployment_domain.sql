CREATE TABLE IF NOT EXISTS environments (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dev', 'test', 'staging', 'prod')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

INSERT INTO environments (project_id, id, name, kind, is_default)
SELECT id, 'local', '本地环境', 'dev', true FROM projects
ON CONFLICT (project_id, id) DO NOTHING;

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS decision_service text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS environment_id text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS engine text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS model_version integer;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS engine_version text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS activated_by text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS stopped_at timestamptz;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS stopped_by text;

UPDATE deployments deployment SET
  project_id = release.project_id,
  decision_service = release.decision_service,
  environment_id = COALESCE(deployment.environment_id, deployment.environment, 'local'),
  engine = COALESCE(deployment.engine, deployment.receipt->>'engine', release.content->'engine'->>'type'),
  checksum = COALESCE(deployment.checksum, deployment.receipt->>'checksum', release.checksum),
  status = COALESCE(deployment.status, CASE deployment.receipt->>'status' WHEN 'active' THEN 'active' WHEN 'stopped' THEN 'stopped' ELSE 'ready' END),
  model_version = COALESCE(deployment.model_version, NULLIF(deployment.receipt->>'modelVersion', '')::integer),
  engine_version = COALESCE(deployment.engine_version, deployment.receipt->>'engineVersion'),
  updated_at = COALESCE(deployment.updated_at, NULLIF(deployment.receipt->>'stoppedAt', '')::timestamptz, NULLIF(deployment.receipt->>'activatedAt', '')::timestamptz, deployment.deployed_at),
  activated_at = COALESCE(deployment.activated_at, NULLIF(deployment.receipt->>'activatedAt', '')::timestamptz),
  activated_by = COALESCE(deployment.activated_by, deployment.receipt->>'activatedBy'),
  stopped_at = COALESCE(deployment.stopped_at, NULLIF(deployment.receipt->>'stoppedAt', '')::timestamptz),
  stopped_by = COALESCE(deployment.stopped_by, deployment.receipt->>'stoppedBy')
FROM releases release
WHERE release.id = deployment.release_id;

INSERT INTO environments (project_id, id, name, kind, is_default)
SELECT DISTINCT project_id, environment_id, environment_id,
  CASE environment_id
    WHEN 'production' THEN 'prod'
    WHEN 'prod' THEN 'prod'
    WHEN 'staging' THEN 'staging'
    WHEN 'test' THEN 'test'
    ELSE 'dev'
  END,
  environment_id = 'local'
FROM deployments
ON CONFLICT (project_id, id) DO NOTHING;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY project_id, decision_service, environment_id
    ORDER BY COALESCE(activated_at, deployed_at) DESC, id DESC
  ) AS position
  FROM deployments WHERE status = 'active'
)
UPDATE deployments SET status = 'ready'
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

WITH candidates AS (
  SELECT deployment.id, row_number() OVER (
    PARTITION BY deployment.project_id, deployment.decision_service, deployment.environment_id
    ORDER BY release.release_version DESC, deployment.deployed_at DESC, deployment.id DESC
  ) AS position
  FROM deployments deployment
  JOIN releases release ON release.id = deployment.release_id
  WHERE deployment.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM deployments active
      WHERE active.project_id = deployment.project_id
        AND active.decision_service = deployment.decision_service
        AND active.environment_id = deployment.environment_id
        AND active.status = 'active'
    )
)
UPDATE deployments SET status = 'active'
WHERE id IN (SELECT id FROM candidates WHERE position = 1);

ALTER TABLE deployments ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE deployments ALTER COLUMN decision_service SET NOT NULL;
ALTER TABLE deployments ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE deployments ALTER COLUMN checksum SET NOT NULL;
ALTER TABLE deployments ALTER COLUMN status SET NOT NULL;
ALTER TABLE deployments ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check CHECK (status IN ('pending', 'parsing', 'ready', 'active', 'draining', 'stopped', 'failed'));
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_environment_fk;
ALTER TABLE deployments ADD CONSTRAINT deployments_environment_fk FOREIGN KEY (project_id, environment_id) REFERENCES environments(project_id, id);

CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments(project_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active_idx
  ON deployments(project_id, decision_service, environment_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS deployment_events (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created', 'ready', 'activated', 'deactivated', 'stopped', 'failed')),
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_events_deployment_idx ON deployment_events(deployment_id, occurred_at);

INSERT INTO deployment_events (id, deployment_id, event_type, actor, details, occurred_at)
SELECT 'legacy:' || id || ':created', id, 'created', 'migration', '{"source":"release.deployments"}'::jsonb, deployed_at
FROM deployments ON CONFLICT (id) DO NOTHING;

INSERT INTO deployment_events (id, deployment_id, event_type, actor, details, occurred_at)
SELECT 'legacy:' || id || ':activated', id, 'activated', COALESCE(activated_by, 'migration'), '{"source":"release.deployments"}'::jsonb, COALESCE(activated_at, deployed_at)
FROM deployments WHERE status = 'active' ON CONFLICT (id) DO NOTHING;

INSERT INTO deployment_events (id, deployment_id, event_type, actor, details, occurred_at)
SELECT 'legacy:' || id || ':stopped', id, 'stopped', COALESCE(stopped_by, 'migration'), '{"source":"release.deployments"}'::jsonb, COALESCE(stopped_at, updated_at)
FROM deployments WHERE status = 'stopped' ON CONFLICT (id) DO NOTHING;
