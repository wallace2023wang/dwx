import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [73421091]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await fs.readdir(migrationsDir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version));
    for (const file of files) {
      const version = Number(file.match(/^(\d+)_/)[1]);
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return files.length;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [73421091]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(count => console.log(`PostgreSQL migrations ready (${count} files)`)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
