ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT 'shield';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT 'v1.0.0';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT 'main';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_environment text NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT 'Team Server';

UPDATE projects SET name = '默认风控项目' WHERE id = 'default' AND name = '默认项目';

CREATE TABLE IF NOT EXISTS packages (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  label text NOT NULL,
  parent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name),
  FOREIGN KEY (project_id, parent_id) REFERENCES packages(project_id, name) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS packages_project_created_idx ON packages(project_id, created_at);
