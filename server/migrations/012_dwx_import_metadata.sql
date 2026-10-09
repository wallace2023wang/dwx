ALTER TABLE assets ADD COLUMN IF NOT EXISTS migration jsonb;

ALTER TABLE asset_revisions DROP CONSTRAINT IF EXISTS asset_revisions_reason_check;
ALTER TABLE asset_revisions ADD CONSTRAINT asset_revisions_reason_check
  CHECK (reason IN ('created', 'saved', 'restored', 'archived', 'deprecated', 'reactivated', 'owner-transferred', 'metadata-updated', 'dwx-imported'));
