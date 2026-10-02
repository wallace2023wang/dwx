ALTER TABLE assets ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deprecated_by text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deprecation_reason text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS replaced_by_asset_id text;

UPDATE assets SET lifecycle_status = 'archived' WHERE archived = true;

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_lifecycle_status_check;
ALTER TABLE assets ADD CONSTRAINT assets_lifecycle_status_check
  CHECK (lifecycle_status IN ('active', 'deprecated', 'archived'));

ALTER TABLE asset_revisions DROP CONSTRAINT IF EXISTS asset_revisions_reason_check;
ALTER TABLE asset_revisions ADD CONSTRAINT asset_revisions_reason_check
  CHECK (reason IN ('created', 'saved', 'restored', 'archived', 'deprecated', 'reactivated'));

CREATE INDEX IF NOT EXISTS assets_project_lifecycle_idx
  ON assets(project_id, asset_type, lifecycle_status, updated_at DESC);
