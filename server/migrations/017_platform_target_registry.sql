DELETE FROM deployment_targets
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY environment_id, engine, endpoint
      ORDER BY updated_at DESC, id DESC
    ) AS position
    FROM deployment_targets
  ) ranked
  WHERE position > 1
);

UPDATE deployment_targets
SET project_id = 'default'
WHERE project_id <> 'default';
