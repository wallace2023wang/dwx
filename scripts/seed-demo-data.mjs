import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, 'fixtures', 'demo-data');
const targetDir = process.env.RULES_DATA_DIR || path.join(root, 'data');
const force = process.argv.includes('--force');

await fs.mkdir(targetDir, { recursive: true });
const entries = await fs.readdir(sourceDir, { withFileTypes: true });
let copied = 0;
let skipped = 0;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const source = path.join(sourceDir, entry.name);
  const target = path.join(targetDir, entry.name);
  try {
    if (!force) await fs.access(target);
    if (!force) {
      skipped += 1;
      continue;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.copyFile(source, target);
  copied += 1;
}

console.log(`Demo data ready: copied ${copied}, skipped ${skipped}, target ${targetDir}`);
