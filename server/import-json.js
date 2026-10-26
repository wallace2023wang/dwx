import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBom } from '../shared/bom.js';
import { PostgresStore } from './postgres-store.js';
import { migrateLegacyDeployments } from '../shared/deployments.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.RULES_DATA_DIR || path.join(root, 'data');

async function json(name, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function revisionsOf(asset) {
  const revision = asset.revision || 1;
  return {
    ...asset,
    revision,
    revisions: asset.revisions?.length ? asset.revisions : [{
      number: revision, reason: 'created', createdAt: asset.updatedAt || new Date().toISOString(), draft: structuredClone(asset.draft),
    }],
  };
}

export async function importJson(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const store = new PostgresStore(databaseUrl);
  await store.initialize();
  const [rules, tables, flows, eventStreams, suites, releases, applicationPackages, storedDeployments, targets, activationGenerations, bom, changeSets, auditEvents] = await Promise.all([
    json('rules.json', []), json('tables.json', []), json('flows.json', []), json('event-streams.json', []),
    json('test-suites.json', []), json('releases.json', []), json('application-packages.json', []),
    json('deployments.json', []), json('targets.json', []), json('activation-generations.json', []), json('bom.json', defaultBom()),
    json('change-sets.json', []), json('audit-events.json', []),
  ]);
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await client.query(`SELECT
      (SELECT count(*) FROM assets) AS assets,
      (SELECT count(*) FROM test_suites) AS suites,
      (SELECT count(*) FROM releases) AS releases,
      (SELECT count(*) FROM application_packages) AS application_packages,
      (SELECT count(*) FROM deployment_targets) AS targets,
      (SELECT count(*) FROM activation_generations) AS activation_generations,
      (SELECT count(*) FROM bom_versions) AS boms,
      (SELECT count(*) FROM change_sets) AS change_sets,
      (SELECT count(*) FROM audit_events) AS audit_events`);
    if (Object.values(counts.rows[0]).some(value => Number(value) > 0)) throw new Error('PostgreSQL 已包含业务数据，拒绝重复导入');
    await store.saveBom(bom, null, client);
    await store.saveAssets('rules', rules.map(revisionsOf), client);
    await store.saveAssets('tables', tables.map(revisionsOf), client);
    await store.saveAssets('flows', flows.map(revisionsOf), client);
    await store.saveAssets('eventStreams', eventStreams.map(revisionsOf), client);
    await store.saveTestSuites(suites.map(suite => ({ ...suite, revision: suite.revision || 1 })), client);
    await store.saveReleases(releases, client);
    if (applicationPackages.length) await store.saveApplicationPackages(applicationPackages, 'default', client);
    const deployments = storedDeployments.length ? storedDeployments : migrateLegacyDeployments(releases);
    if (deployments.length) await store.saveDeployments(deployments, 'default', client);
    if (targets.length) await store.saveTargets(targets, 'default', client);
    if (activationGenerations.length) await store.saveActivationGenerations(activationGenerations, 'default', client);
    if (changeSets.length) {
      for (const changeSet of changeSets) {
        const definition = structuredClone(changeSet);
        for (const key of ['id', 'revision', 'status', 'createdAt', 'updatedAt']) delete definition[key];
        await client.query(`INSERT INTO change_sets
          (id, project_id, revision, status, definition, created_at, updated_at)
          VALUES ($1, 'default', $2, $3, $4, $5, $6)`, [
          changeSet.id, changeSet.revision || 1, changeSet.status, definition, changeSet.createdAt, changeSet.updatedAt,
        ]);
      }
    }
    for (const event of [...auditEvents].reverse()) {
      await client.query(`INSERT INTO audit_events
        (id, project_id, actor, action, resource_type, resource_id, summary, details, occurred_at)
        VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8)`, [
        event.id, event.actor, event.action, event.resourceType, event.resourceId,
        event.summary, event.details || {}, event.occurredAt,
      ]);
    }
    await client.query('COMMIT');
    return {
      rules: rules.length, tables: tables.length, flows: flows.length, eventStreams: eventStreams.length,
      suites: suites.length, releases: releases.length, applicationPackages: applicationPackages.length,
      deployments: deployments.length, targets: targets.length, activationGenerations: activationGenerations.length,
      bomVersion: bom.version,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  importJson().then(result => console.log(`JSON import complete: ${JSON.stringify(result)}`)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
