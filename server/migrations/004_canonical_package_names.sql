WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE assets a
SET draft = jsonb_set(a.draft, '{category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE a.draft->>'category' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE assets a
SET published = jsonb_set(a.published, '{category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE a.published IS NOT NULL AND a.published->>'category' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE asset_revisions r
SET draft = jsonb_set(r.draft, '{category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE r.draft->>'category' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE asset_versions v
SET content = jsonb_set(v.content, '{category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE v.content->>'category' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE asset_versions v
SET content = jsonb_set(v.content, '{rule,category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE v.content#>>'{rule,category}' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE asset_versions v
SET content = jsonb_set(v.content, '{draft,category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE v.content#>>'{draft,category}' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE asset_versions v
SET content = jsonb_set(v.content, '{snapshot,category}', to_jsonb(l.new_name), false)
FROM legacy l
WHERE v.content#>>'{snapshot,category}' = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
INSERT INTO packages (project_id, name, label, parent_id, created_at)
SELECT p.project_id, l.new_name, l.label, NULL, p.created_at
FROM packages p
JOIN legacy l ON p.name = l.old_name
ON CONFLICT (project_id, name) DO UPDATE SET label = EXCLUDED.label;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
UPDATE packages p
SET parent_id = l.new_name
FROM legacy l
WHERE p.parent_id = l.old_name;

WITH legacy(old_name, new_name, label) AS (
  VALUES
    ('通用', 'common', '通用'),
    ('风控', 'risk_control', '风控'),
    ('信贷风控', 'credit_risk', '信贷风控'),
    ('准入', 'eligibility', '准入'),
    ('定价', 'pricing', '定价'),
    ('未分类', 'uncategorized', '未分类')
)
DELETE FROM packages p
USING legacy l
WHERE p.name = l.old_name;
