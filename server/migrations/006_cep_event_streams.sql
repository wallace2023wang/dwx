ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_asset_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_asset_type_check CHECK (asset_type IN ('rule', 'table', 'flow', 'event-stream'));

ALTER TABLE test_suites DROP CONSTRAINT IF EXISTS test_suites_target_type_check;
ALTER TABLE test_suites ADD CONSTRAINT test_suites_target_type_check CHECK (target_type IN ('rule', 'table', 'flow', 'event-stream'));

ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_target_type_check;
ALTER TABLE releases ADD CONSTRAINT releases_target_type_check CHECK (target_type IN ('rule', 'table', 'flow', 'event-stream'));
