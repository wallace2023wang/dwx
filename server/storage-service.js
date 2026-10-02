import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultBom, validateBom } from '../shared/bom.js';
import { canonicalPackageName, packageLabel } from '../shared/packages.js';
import { initializeAssetRevision, normalizeAssetPackages, normalizePackageRecords } from './domain-utils.js';
import { defaultProjectRecord, normalizeProjectRecord } from './project-factory.js';

const VERSIONED_ASSET_KINDS = new Set(['tables', 'flows', 'eventStreams']);
const PROJECT_SCOPED_ASSET_KINDS = new Set(['tables', 'flows', 'eventStreams', 'testSuites']);

export function createStorageService({ storage, dataDir, assetFiles, getPostgresStore, actorOf }) {
  const bomFile = projectId => projectId === 'default' ? assetFiles.bom : path.join(dataDir, `bom-${projectId}.json`);
  const assetProject = item => item.projectId || 'default';
  // Audit writes run after business mutations; queue JSON appends to avoid lost updates.
  let auditQueue = Promise.resolve();

  async function writeJsonFile(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2));
    await fs.rename(temp, file);
  }

  async function readBom(projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) {
      const stored = await postgresStore.getBom(projectId);
      if (stored && (!validateBom(stored) || stored.fields?.length === 0)) return stored;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(bomFile(projectId), 'utf8'));
      if (!validateBom(parsed) || parsed.fields?.length === 0) return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const bom = projectId === 'default' ? defaultBom() : { version: 1, updatedAt: new Date().toISOString(), fields: [] };
    await writeBom(bom, null, projectId);
    return bom;
  }

  async function writeBom(bom, expectedVersion = null, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.saveBom(bom, expectedVersion, null, projectId);
    return writeJsonFile(bomFile(projectId), bom);
  }

  async function collectUsedKeys(projectId = 'default') {
    const used = new Set();
    const add = key => { if (typeof key === 'string' && key) used.add(key); };
    const rules = await readRules(projectId);
    for (const asset of rules) {
      for (const version of asset.versions || []) {
        const rule = version.rule || version.draft;
        if (!rule) continue;
        for (const c of rule.conditions || []) { if (!c.pattern && !c.raw) { add(c.field); if (c.valueSource === 'field') add(c.valueField); } }
        for (const a of rule.actions || []) add(a.field);
      }
      for (const c of (asset.draft?.conditions || [])) { if (!c.pattern && !c.raw) { add(c.field); if (c.valueSource === 'field') add(c.valueField); } }
      for (const a of (asset.draft?.actions || [])) add(a.field);
      for (const c of (asset.published?.conditions || [])) { if (!c.pattern && !c.raw) { add(c.field); if (c.valueSource === 'field') add(c.valueField); } }
      for (const a of (asset.published?.actions || [])) add(a.field);
    }
    const tables = await readAssets('tables', projectId);
    for (const asset of tables) {
      const scan = t => {
        if (!t) return;
        for (const c of t.conditions || []) add(c.field);
        for (const a of t.actions || []) add(a.field);
      };
      scan(asset.draft);
      scan(asset.published);
      for (const version of asset.versions || []) scan(version.draft);
    }
    const flows = await readAssets('flows', projectId);
    const scanFlow = flow => {
      if (!flow) return;
      const scanSteps = steps => {
        for (const step of steps || []) {
          for (const mapping of step.inputMappings || []) { add(mapping.source); add(mapping.target); }
          for (const mapping of step.outputMappings || []) { add(mapping.source); add(mapping.target); }
        }
      };
      scanSteps(flow.steps);
      for (const branch of flow.branches || []) {
        if (!branch.default) add(branch.condition?.field);
        scanSteps(branch.steps);
      }
    };
    for (const asset of flows) {
      scanFlow(asset.draft);
      scanFlow(asset.published);
      for (const version of asset.versions || []) {
        scanFlow(version.draft);
        scanFlow(version.snapshot);
      }
    }
    return used;
  }

  async function readRules(projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return (await postgresStore.listAssets('rules', projectId)).map(item => normalizeAssetPackages(item));
    try {
      return JSON.parse(await fs.readFile(storage, 'utf8'))
        .filter(item => assetProject(item) === projectId)
        .map(item => initializeAssetRevision(normalizeAssetPackages(item)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (projectId !== 'default') return [];
      const example = {
        name: '高风险客户人工复核',
        description: '逾期且信用评分低于阈值时转人工审核。',
        category: 'credit_risk',
        priority: 80,
        conditions: [{ field: 'overdue', operator: '==', value: 'true' }, { field: 'creditScore', operator: '<', value: '600' }],
        actions: [{ field: 'riskLevel', value: '高' }, { field: 'reviewRequired', value: 'true' }],
      };
      return [initializeAssetRevision({ id: 'example-risk-review', draft: example, published: structuredClone(example), versions: [{ number: 1, createdAt: '2026-09-28T00:00:00.000Z', rule: structuredClone(example) }], archived: false, updatedAt: '2026-09-28T00:00:00.000Z' })];
    }
  }

  async function writeRules(rules, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.saveAssets('rules', rules, null, projectId);
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(storage, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const persisted = rules.map(item => projectId === 'default' ? item : { ...item, projectId });
    const combined = [...existing.filter(item => assetProject(item) !== projectId), ...persisted];
    return writeJsonFile(storage, combined);
  }

  async function readAssets(kind, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) {
      if (VERSIONED_ASSET_KINDS.has(kind)) return (await postgresStore.listAssets(kind, projectId)).map(item => initializeAssetRevision(normalizeAssetPackages(item)));
      if (kind === 'testSuites') return postgresStore.listTestSuites(projectId);
      if (kind === 'releases') return postgresStore.listReleases(projectId);
    }
    try {
      const assets = JSON.parse(await fs.readFile(assetFiles[kind], 'utf8'));
      if (VERSIONED_ASSET_KINDS.has(kind)) return assets.filter(item => assetProject(item) === projectId).map(item => initializeAssetRevision(normalizeAssetPackages(item)));
      if (kind === 'testSuites') return assets.filter(item => assetProject(item) === projectId).map(item => ({ ...item, revision: item.revision || 1 }));
      return assets;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function writeAssets(kind, assets, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) {
      if (VERSIONED_ASSET_KINDS.has(kind)) return postgresStore.saveAssets(kind, assets, null, projectId);
      if (kind === 'testSuites') return postgresStore.saveTestSuites(assets, null, projectId);
      if (kind === 'releases') return postgresStore.saveReleases(assets, null, projectId);
    }
    const file = assetFiles[kind];
    if (PROJECT_SCOPED_ASSET_KINDS.has(kind)) {
      let existing = [];
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const persisted = assets.map(item => projectId === 'default' ? item : { ...item, projectId });
      assets = [...existing.filter(item => assetProject(item) !== projectId), ...persisted];
    }
    return writeJsonFile(file, assets);
  }

  async function readReleases(projectId = 'default') {
    const postgresStore = getPostgresStore();
    const releases = postgresStore
      ? await postgresStore.listReleases(projectId)
      : (await readAssets('releases')).filter(item => assetProject(item) === projectId);
    const events = postgresStore
      ? await postgresStore.listAuditEvents(5000, projectId)
      : await readAuditEvents(projectId);
    const releaseActors = new Map(events
      .filter(event => event.action === 'release.created')
      .map(event => [event.resourceId, event.actor]));
    return releases.map(release => ({
      ...release,
      createdBy: release.createdBy || releaseActors.get(release.id) || 'Team Server',
    }));
  }

  async function writeReleases(releases, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.saveReleases(releases, null, projectId);
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(assetFiles.releases, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return writeJsonFile(assetFiles.releases, [
      ...existing.filter(item => assetProject(item) !== projectId),
      ...releases.map(item => projectId === 'default' ? item : { ...item, projectId }),
    ]);
  }

  async function readProjectRecords(includeArchived = false) {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.listProjects(includeArchived);
    let projects;
    try { projects = JSON.parse(await fs.readFile(assetFiles.projects, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      projects = [defaultProjectRecord()];
    }
    if (!projects.some(project => project.id === 'default')) projects.unshift(defaultProjectRecord());
    return projects.map(normalizeProjectRecord).filter(project => includeArchived || !project.archived);
  }

  async function writeProjectRecords(projects) {
    return writeJsonFile(assetFiles.projects, projects);
  }

  async function readProjectRecord(projectId = 'default') {
    return (await readProjectRecords(true)).find(project => project.id === projectId) || normalizeProjectRecord({ id: projectId });
  }

  async function readPackageRecords(projectId, data = null) {
    let packages;
    const postgresStore = getPostgresStore();
    if (postgresStore) packages = normalizePackageRecords(await postgresStore.listPackages(projectId));
    else {
      let all = [];
      try { all = JSON.parse(await fs.readFile(assetFiles.packages, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      packages = normalizePackageRecords(all.filter(pkg => pkg.projectId === projectId).map(({ projectId: _projectId, ...pkg }) => pkg));
    }
    if (packages.length || !data) return packages;
    const categories = [...new Set([...data.rules, ...data.tables].map(item => item.draft.category || '未分类'))];
    packages = categories.map((name, index) => ({ name: canonicalPackageName(name), label: packageLabel(name), parentId: null, createdAt: new Date(Date.UTC(2026, 8, 28, 0, index)).toISOString() }));
    return normalizePackageRecords(packages);
  }

  async function writePackageRecords(projectId, packages) {
    packages = normalizePackageRecords(packages);
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.savePackages(projectId, packages);
    let all = [];
    try { all = JSON.parse(await fs.readFile(assetFiles.packages, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return writeJsonFile(assetFiles.packages, [
      ...all.filter(pkg => pkg.projectId !== projectId),
      ...packages.map(pkg => ({ ...pkg, projectId })),
    ]);
  }

  async function deleteProjectData(projects, projectId) {
    await writeProjectRecords(projects.filter(item => item.id !== projectId));
    await writePackageRecords(projectId, []);
    await writeRules([], projectId);
    await writeAssets('tables', [], projectId);
    await writeAssets('flows', [], projectId);
    await writeAssets('eventStreams', [], projectId);
    await writeAssets('testSuites', [], projectId);
    await writeReleases([], projectId);
    await writeChangeSets([], projectId);
    await deleteAuditEvents(projectId);
    await fs.rm(bomFile(projectId), { force: true });
  }

  async function readChangeSets(projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.listChangeSets(projectId);
    try {
      const all = JSON.parse(await fs.readFile(assetFiles.changeSets, 'utf8'));
      return all.filter(item => (item.projectId || 'default') === projectId).map(({ projectId: _projectId, ...item }) => item);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function writeChangeSets(changeSets, projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.saveChangeSets(changeSets, projectId);
    let all = [];
    try { all = JSON.parse(await fs.readFile(assetFiles.changeSets, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return writeJsonFile(assetFiles.changeSets, [
      ...all.filter(item => (item.projectId || 'default') !== projectId),
      ...changeSets.map(item => projectId === 'default' ? item : { ...item, projectId }),
    ]);
  }

  async function readAuditEvents(projectId = 'default') {
    const postgresStore = getPostgresStore();
    if (postgresStore) return postgresStore.listAuditEvents(100, projectId);
    try {
      const all = JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8'));
      return all.filter(item => (item.projectId || 'default') === projectId);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function readAllAuditEvents() {
    if (getPostgresStore()) throw new Error('PostgreSQL 全局审计读取必须指定可访问项目');
    try { return JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function deleteAuditEvents(projectId) {
    if (getPostgresStore()) return;
    let all = [];
    try { all = JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeJsonFile(assetFiles.auditEvents, all.filter(item => (item.projectId || 'default') !== projectId));
  }

  async function appendAuditEvent(action, resourceType, resourceId, summary, details = {}, req = null) {
    const segments = req?.url ? new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean) : [];
    const projectId = segments[1] === 'projects' && segments[2] ? decodeURIComponent(segments[2]) : 'default';
    const event = {
      id: crypto.randomUUID(),
      projectId,
      actor: actorOf(req),
      action, resourceType, resourceId, summary, details,
      occurredAt: new Date().toISOString(),
    };
    const postgresStore = getPostgresStore();
    if (postgresStore) await postgresStore.appendAuditEvent(event);
    else {
      const pending = auditQueue.then(async () => {
        let events = [];
        try { events = JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        events.unshift(event);
        await writeJsonFile(assetFiles.auditEvents, events.slice(0, 5000));
      });
      auditQueue = pending.catch(() => {});
      await pending;
    }
    return event;
  }

  return {
    writeJsonFile,
    readBom,
    writeBom,
    collectUsedKeys,
    readRules,
    writeRules,
    readAssets,
    writeAssets,
    readReleases,
    writeReleases,
    readProjectRecords,
    writeProjectRecords,
    readProjectRecord,
    readPackageRecords,
    writePackageRecords,
    deleteProjectData,
    readChangeSets,
    writeChangeSets,
    readAuditEvents,
    readAllAuditEvents,
    deleteAuditEvents,
    appendAuditEvent,
  };
}
