ALTER TABLE assets ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS owner_name text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS effective_to date;

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_effective_dates_check;
ALTER TABLE assets ADD CONSTRAINT assets_effective_dates_check
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to);

ALTER TABLE asset_revisions DROP CONSTRAINT IF EXISTS asset_revisions_reason_check;
ALTER TABLE asset_revisions ADD CONSTRAINT asset_revisions_reason_check
  CHECK (reason IN ('created', 'saved', 'restored', 'archived', 'deprecated', 'reactivated', 'owner-transferred', 'metadata-updated'));
