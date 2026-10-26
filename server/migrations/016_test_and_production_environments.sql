INSERT INTO environments (project_id, id, name, kind, is_default)
SELECT id, 'test', '测试环境', 'test', false FROM projects
ON CONFLICT (project_id, id) DO NOTHING;

INSERT INTO environments (project_id, id, name, kind, is_default)
SELECT id, 'production', '生产环境', 'prod', false FROM projects
ON CONFLICT (project_id, id) DO NOTHING;
