ALTER TABLE projects ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'rules';
UPDATE projects SET engine = 'rules' WHERE engine IS NULL OR engine NOT IN ('rules', 'cep');
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_engine_check;
ALTER TABLE projects ADD CONSTRAINT projects_engine_check CHECK (engine IN ('rules', 'cep'));
