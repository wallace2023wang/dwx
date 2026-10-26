import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { importJson } from '../server/import-json.js';
import { PostgresStore, StorageConflictError } from '../server/postgres-store.js';
import { createApplicationPackage } from '../shared/application-packages.js';

const postgresTestUrl = process.env.POSTGRES_TEST_URL;

test('PG-STORE-01: JSON 导入、持久化和数据库级乐观锁', { skip: !postgresTestUrl }, async () => {
  const source = new URL(postgresTestUrl);
  const database = `rules_test_${crypto.randomBytes(6).toString('hex')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${database}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);

  try {
    const imported = await importJson(databaseUrl.toString());
    for (const kind of ['rules', 'tables', 'flows', 'eventStreams', 'suites', 'releases']) {
      assert.ok(imported[kind] > 0, `${kind} 应导入至少一条记录`);
    }
    assert.equal(imported.bomVersion, 1);
    await assert.rejects(() => importJson(databaseUrl.toString()), /拒绝重复导入/);

    const first = new PostgresStore(databaseUrl.toString());
    const second = new PostgresStore(databaseUrl.toString());
    await Promise.all([first.initialize(), second.initialize()]);
    try {
      const [firstRules, secondRules] = await Promise.all([first.listAssets('rules'), second.listAssets('rules')]);
      assert.equal(firstRules.length, imported.rules);
      const changed = firstRules[0];
      changed.draft = { ...changed.draft, name: '数据库集成测试' };
      changed.lifecycleStatus = 'deprecated';
      changed.deprecatedAt = new Date().toISOString();
      changed.deprecatedBy = 'integration-test';
      changed.deprecationReason = '生命周期持久化验证';
      changed.replacedByAssetId = firstRules[1]?.id || null;
      changed.revision += 1;
      changed.revisions.push({
        number: changed.revision,
        reason: 'saved',
        createdAt: new Date().toISOString(),
        draft: structuredClone(changed.draft),
      });
      await first.saveAssets('rules', firstRules);
      const persistedLifecycle = (await first.listAssets('rules')).find(item => item.id === changed.id);
      assert.equal(persistedLifecycle.lifecycleStatus, 'deprecated');
      assert.equal(persistedLifecycle.deprecatedBy, 'integration-test');
      assert.equal(persistedLifecycle.deprecationReason, '生命周期持久化验证');
      assert.equal(persistedLifecycle.replacedByAssetId, changed.replacedByAssetId);
      assert.ok(persistedLifecycle.deprecatedAt);

      const stale = secondRules.find(item => item.id === changed.id);
      stale.draft = { ...stale.draft, name: '过期写入' };
      stale.revision += 1;
      await assert.rejects(() => second.saveAssets('rules', secondRules), error => {
        assert.ok(error instanceof StorageConflictError);
        assert.equal(error.currentRevision, changed.revision);
        return true;
      });

      const currentBom = await first.getBom();
      const nextBom = { ...currentBom, version: currentBom.version + 1, updatedAt: new Date().toISOString() };
      await first.saveBom(nextBom, currentBom.version);
      await assert.rejects(() => second.saveBom(nextBom, currentBom.version), error => {
        assert.ok(error instanceof StorageConflictError);
        assert.equal(error.currentRevision, nextBom.version);
        return true;
      });

      const suites = await first.listTestSuites();
      assert.equal(suites.length, imported.suites);
      assert.ok(Array.isArray(suites[0].cases));
      assert.ok(suites.some(suite => suite.runs.length >= 2));

      const now = new Date().toISOString();
      const changeSet = {
        id: crypto.randomUUID(), revision: 1, status: 'DRAFT', name: '数据库治理验证',
        description: '', items: [], createdBy: 'test', createdAt: now, updatedAt: now,
        submittedAt: null, decidedAt: null, decisionComment: '',
      };
      await first.saveChangeSets([changeSet]);
      const [firstSets, secondSets] = await Promise.all([first.listChangeSets(), second.listChangeSets()]);
      firstSets[0].description = '第一个连接更新';
      firstSets[0].revision += 1;
      firstSets[0].updatedAt = new Date().toISOString();
      await first.saveChangeSets(firstSets);
      secondSets[0].description = '过期连接更新';
      secondSets[0].revision += 1;
      await assert.rejects(() => second.saveChangeSets(secondSets), error => {
        assert.ok(error instanceof StorageConflictError);
        assert.equal(error.currentRevision, 2);
        return true;
      });

      const event = {
        id: crypto.randomUUID(), actor: 'integration-test', action: 'change-set.created',
        resourceType: 'change-set', resourceId: changeSet.id, summary: '创建测试变更集', details: {}, occurredAt: now,
      };
      await first.appendAuditEvent(event);
      const events = await first.listAuditEvents(10);
      assert.equal(events[0].id, event.id);

      const isolatedProject = {
        id: `project-${crypto.randomBytes(4).toString('hex')}`, name: '数据库隔离项目', description: '',
        icon: 'shield', version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local', archived: false,
        variables: [{
          name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false,
          enum: null, description: 'PostgreSQL 变量持久化验证',
        }],
        createdAt: now, updatedAt: now, updatedBy: 'integration-test',
      };
      await first.createProject(isolatedProject, { ...structuredClone(currentBom), version: 1 }, []);
      const persistedProject = await first.getProject(isolatedProject.id);
      assert.deepEqual(persistedProject.variables.map(variable => variable.name), ['approved']);
      persistedProject.variables[0].defaultValue = true;
      persistedProject.updatedAt = new Date().toISOString();
      await first.updateProject(isolatedProject.id, persistedProject);
      assert.equal((await second.getProject(isolatedProject.id)).variables[0].defaultValue, true);
      const isolatedChangeSet = {
        ...changeSet, id: crypto.randomUUID(), name: '隔离项目变更集', revision: 1,
        createdAt: now, updatedAt: now,
      };
      await first.saveChangeSets([isolatedChangeSet], isolatedProject.id);
      assert.deepEqual((await first.listChangeSets(isolatedProject.id)).map(item => item.id), [isolatedChangeSet.id]);
      assert.equal((await first.listChangeSets('default')).some(item => item.id === isolatedChangeSet.id), false);
      const isolatedEvent = {
        ...event, id: crypto.randomUUID(), projectId: isolatedProject.id,
        resourceId: isolatedChangeSet.id, summary: '隔离项目审计事件',
      };
      await first.appendAuditEvent(isolatedEvent);
      assert.equal((await first.listAuditEvents(10, isolatedProject.id))[0].id, isolatedEvent.id);
      assert.equal((await first.listAuditEvents(10, 'default')).some(item => item.id === isolatedEvent.id), false);

      const isolatedSuite = {
        id: crypto.randomUUID(), revision: 1, name: '隔离项目测试套件', description: '',
        target: { type: 'rule', id: changed.id }, required: true,
        cases: [{
          id: 'isolated-case', name: '隔离场景', enabled: true, facts: { customerAge: 30 },
          expected: { outputs: { riskLevel: '中' }, fired: [] },
        }],
        archived: false, createdAt: now, updatedAt: now, lastRun: null, runs: [],
      };
      await first.saveTestSuites([isolatedSuite], null, isolatedProject.id);
      assert.deepEqual((await first.listTestSuites(isolatedProject.id)).map(item => item.id), [isolatedSuite.id]);
      assert.equal((await first.listTestSuites('default')).some(item => item.id === isolatedSuite.id), false);
      const isolatedRun = {
        id: crypto.randomUUID(), suiteId: isolatedSuite.id, suiteName: isolatedSuite.name,
        target: structuredClone(isolatedSuite.target), targetVersion: 1,
        passed: true, total: 1, passedCount: 1, failedCount: 0,
        runAt: now, durationMs: 2, cases: [],
      };
      isolatedSuite.revision = 2;
      isolatedSuite.updatedAt = new Date(Date.now() + 1000).toISOString();
      isolatedSuite.lastRun = isolatedRun;
      isolatedSuite.runs = [isolatedRun];
      await first.saveTestSuites([isolatedSuite], null, isolatedProject.id);
      assert.equal((await first.listTestSuites(isolatedProject.id))[0].lastRun.id, isolatedRun.id);

      const isolatedRelease = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        decisionService: `${isolatedProject.id}/eligibility`,
        version: 1,
        name: '隔离项目 Release',
        description: 'PostgreSQL 项目发布隔离',
        target: { type: 'flow', id: changed.id, assetVersion: 1 },
        engine: { type: 'drools', drools: '10.2.0' },
        model: structuredClone(currentBom),
        steps: [{ name: '隔离规则', type: 'rule', assetId: changed.id, assetVersion: 1, drl: 'package workbench' }],
        checksum: `sha256:${'a'.repeat(64)}`,
        deployments: [],
        createdAt: now,
      };
      await first.saveReleases([isolatedRelease], null, isolatedProject.id);
      assert.deepEqual((await first.listReleases(isolatedProject.id)).map(item => item.id), [isolatedRelease.id]);
      assert.equal((await first.listReleases('default')).some(item => item.id === isolatedRelease.id), false);

      const applicationPackage = createApplicationPackage({
        id: crypto.randomUUID(), manifestId: crypto.randomUUID(), projectId: isolatedProject.id,
        name: '隔离项目应用包', release: isolatedRelease, createdAt: now, createdBy: 'pg-test',
      });
      await first.saveApplicationPackages([applicationPackage], isolatedProject.id);
      const storedApplicationPackage = (await first.listApplicationPackages(isolatedProject.id))[0];
      assert.equal(storedApplicationPackage.decisionService, isolatedRelease.decisionService);
      assert.equal(storedApplicationPackage.manifests[0].releaseChecksum, isolatedRelease.checksum);
      assert.equal((await first.listApplicationPackages('default')).some(item => item.id === applicationPackage.id), false);

      const target = {
        id: crypto.randomUUID(), name: '隔离项目 RES', environmentId: 'local', engine: 'drools',
        endpoint: 'http://127.0.0.1:18790', enabled: true, status: 'ready', nodeId: 'pg-node',
        engineVersion: '10.2.0', lastSeenAt: now, lastError: null,
        createdAt: now, updatedAt: now, createdBy: 'pg-test',
      };
      await first.saveTargets([target], isolatedProject.id);
      assert.equal((await first.listTargets(isolatedProject.id))[0].nodeId, 'pg-node');
      assert.deepEqual(await first.listTargets('default'), []);
      const activationGeneration = {
        id: crypto.randomUUID(), applicationPackageId: applicationPackage.id,
        manifestId: applicationPackage.manifests[0].id, releaseId: isolatedRelease.id,
        decisionService: isolatedRelease.decisionService, environmentId: 'local',
        generation: 1, expectedGeneration: 0, status: 'preparing',
        targets: [{ targetId: target.id, status: 'ready', updatedAt: now }],
        createdAt: now, updatedAt: now, createdBy: 'pg-test',
        activatedAt: null, failedAt: null, error: null,
      };
      await first.saveActivationGenerations([activationGeneration], isolatedProject.id);
      activationGeneration.status = 'active';
      activationGeneration.activatedAt = now;
      await first.saveActivationGenerations([activationGeneration], isolatedProject.id);
      const storedGeneration = (await first.listActivationGenerations(isolatedProject.id))[0];
      assert.equal(storedGeneration.status, 'active');
      assert.equal(storedGeneration.targets[0].targetId, target.id);

      isolatedRelease.deployments.push({
        id: `local:${isolatedRelease.id}`, environment: 'local', deployedAt: now,
        checksum: isolatedRelease.checksum, modelVersion: currentBom.version, status: 'deployed',
      });
      await first.saveDeployments([{
        id: `local:${isolatedRelease.id}`, releaseId: isolatedRelease.id,
        decisionService: isolatedRelease.decisionService, environmentId: 'local',
        checksum: isolatedRelease.checksum, modelVersion: currentBom.version,
        engine: 'drools', engineVersion: '10.2.0', status: 'ready',
        createdAt: now, updatedAt: now, events: [],
      }], isolatedProject.id);
      assert.equal((await first.listReleases(isolatedProject.id))[0].deployments[0].status, 'deployed');
      const isolatedDeployment = (await first.listDeployments(isolatedProject.id))[0];
      isolatedDeployment.status = 'active';
      isolatedDeployment.activatedAt = now;
      isolatedDeployment.updatedAt = now;
      await first.saveDeployments([isolatedDeployment], isolatedProject.id);
      assert.equal((await first.listReleases(isolatedProject.id))[0].deployments[0].status, 'active');

      assert.deepEqual(await first.deleteProject(isolatedProject.id), { deleted: true });
      assert.deepEqual(await first.listReleases(isolatedProject.id), []);
      assert.deepEqual(await first.listApplicationPackages(isolatedProject.id), []);
      assert.deepEqual(await first.listTargets(isolatedProject.id), []);
      assert.deepEqual(await first.listActivationGenerations(isolatedProject.id), []);
      assert.deepEqual(await first.listTestSuites(isolatedProject.id), []);
      assert.equal(Number((await first.pool.query('SELECT count(*) FROM test_runs WHERE suite_id = $1', [isolatedSuite.id])).rows[0].count), 0);
      assert.equal(await first.getProject(isolatedProject.id), null);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  } finally {
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
