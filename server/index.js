import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDrl, newRule, validateRule } from '../shared/rules.js';
import { applyFlowMappings, flowSnapshot, newFlow, newTable, resolveRuleGroupMembers, ruleGroupFingerprint, selectFlowBranch, tableCollectedHits, tableDrl, tableExecutionTrace, tableRules, validateFlow, validateTable } from '../shared/assets.js';
import { defaultBom, validateBom, inputFields, outputFields, findField, inferSemanticType } from '../shared/bom.js';
import { evaluateCepTestCase, evaluateTestCase, expandTestCases, validateTestSuite } from '../shared/test-suites.js';
import { canonicalPackageName, packageLabel } from '../shared/packages.js';
import { renderProjectReport } from '../shared/report.js';
import { compileEventStreamDraft, validateEventPayloads } from '../shared/event-streams.js';
import { PostgresStore, StorageConflictError } from './postgres-store.js';
import { AuthError, authenticateRequest, authorizeRequest, publicPrincipal, handleAuthRequest, authorizeProject, authorizeAsset, canAccessProject, canAccessAsset } from './auth.js';
import { bodyOf, expectedRevision, operationError, reply, revisionConflict } from './http-utils.js';
import { advanceAssetRevision, initializeAssetRevision, normalizeAssetPackages, normalizePackageRecords, normalizePackageReferences } from './domain-utils.js';
import { createAdminHandler } from './routes/admin.js';
import { createEngineClients } from './engine-client.js';
import { createBomHandlers } from './routes/bom.js';
import { createReleaseHandler } from './routes/releases.js';
import { createTestSuiteHandler } from './routes/test-suites.js';
import { createChangeSetHandler } from './routes/change-sets.js';
import { createProjectPackageHandler } from './routes/project-packages.js';
import { createProjectEventStreamHandler } from './routes/project-event-streams.js';
import { createProjectFlowHandler } from './routes/project-flows.js';
import { createProjectRuleHandler } from './routes/project-rules.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storage = process.env.RULES_DATA_FILE || path.join(root, 'data', 'rules.json');
const port = Number(process.env.API_PORT || 8787);
const rulesBuildUrl = process.env.RULES_BUILD_URL || process.env.ENGINE_URL || 'http://127.0.0.1:8788';
const rulesResUrl = process.env.RULES_RES_URL || process.env.RES_URL || 'http://127.0.0.1:8790';
const cepBuildUrl = process.env.CEP_BUILD_URL || 'http://127.0.0.1:8791';
const cepResUrl = process.env.CEP_RES_URL || 'http://127.0.0.1:8792';
const cepApiKey = process.env.CEP_API_KEY || '';
const dataDir = path.dirname(storage);
const assetFiles = {
  tables: process.env.RULES_TABLES_FILE || path.join(dataDir, 'tables.json'),
  flows: process.env.RULES_FLOWS_FILE || path.join(dataDir, 'flows.json'),
  eventStreams: process.env.RULES_EVENT_STREAMS_FILE || path.join(dataDir, 'event-streams.json'),
  releases: process.env.RULES_RELEASES_FILE || path.join(dataDir, 'releases.json'),
  testSuites: process.env.RULES_TEST_SUITES_FILE || path.join(dataDir, 'test-suites.json'),
  bom: process.env.RULES_BOM_FILE || path.join(dataDir, 'bom.json'),
  changeSets: process.env.RULES_CHANGE_SETS_FILE || path.join(dataDir, 'change-sets.json'),
  auditEvents: process.env.RULES_AUDIT_FILE || path.join(dataDir, 'audit-events.json'),
  adminUsers: process.env.RULES_ADMIN_USERS_FILE || path.join(dataDir, 'admin-users.json'),
  projects: process.env.RULES_PROJECTS_FILE || path.join(dataDir, 'projects.json'),
  packages: process.env.RULES_PACKAGES_FILE || path.join(dataDir, 'packages.json'),
};

const bomFile = projectId => projectId === 'default' ? assetFiles.bom : path.join(dataDir, `bom-${projectId}.json`);
const assetProject = item => item.projectId || 'default';
const VALID_PROJECT_ENGINES = new Set(['rules', 'cep']);
const normalizeProjectEngine = value => VALID_PROJECT_ENGINES.has(value) ? value : 'rules';
const normalizeProjectRecord = project => ({ ...project, engine: normalizeProjectEngine(project?.engine) });
const { engine, executionServer } = createEngineClients({
  rulesBuildUrl,
  rulesResUrl,
  cepBuildUrl,
  cepResUrl,
  cepApiKey,
});

// 当前生效的 BOM。启动时从 data/bom.json 加载，缺失则写入默认 BOM。
let currentBom = defaultBom();
let postgresStore = null;

/**
 * 按当前 BOM 校验并规范化调用方传入的 facts。
 * 返回 null 表示有未知字段或类型不合法。
 */
function parseFacts(raw, bom = currentBom) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inputs = inputFields(bom);
  if (Object.keys(raw).some(key => !inputs.some(f => f.key === key))) return null;
  const facts = {};
  for (const field of inputs) {
    const value = raw[field.key];
    if (value === undefined || value === '' || value === null) {
      if (field.required === true) return null;
      continue;
    }
    if (field.type === 'Integer') {
      if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) return null;
      if (field.min != null && value < field.min) return null;
      if (field.max != null && value > field.max) return null;
    } else if (field.type === 'Double') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      if (field.min != null && value < field.min) return null;
      if (field.max != null && value > field.max) return null;
    } else if (field.type === 'Boolean') {
      if (typeof value !== 'boolean') return null;
    } else if (field.type === 'String') {
      if (typeof value !== 'string' || value.length > 200) return null;
      if (field.enum && !field.enum.includes(value)) return null;
    }
    facts[field.key] = value;
  }
  return facts;
}

async function readBom(projectId = 'default') {
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
  if (postgresStore) return postgresStore.saveBom(bom, expectedVersion, null, projectId);
  const file = bomFile(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(bom, null, 2));
  await fs.rename(temp, file);
}

/**
 * 扫描所有资产，收集被引用过的 field key 集合（用于 BOM 变更影响分析）。
 */
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
  if (postgresStore) return (await postgresStore.listAssets('rules', projectId)).map(item => normalizeAssetPackages(item));
  try {
    return JSON.parse(await fs.readFile(storage, 'utf8'))
      .filter(item => assetProject(item) === projectId)
      .map(item => initializeAssetRevision(normalizeAssetPackages(item)));
  }
  catch (error) {
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
  if (postgresStore) return postgresStore.saveAssets('rules', rules, null, projectId);
  let existing = [];
  try { existing = JSON.parse(await fs.readFile(storage, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persisted = rules.map(item => projectId === 'default' ? item : { ...item, projectId });
  const combined = [...existing.filter(item => assetProject(item) !== projectId), ...persisted];
  await fs.mkdir(path.dirname(storage), { recursive: true });
  const temp = `${storage}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(combined, null, 2));
  await fs.rename(temp, storage);
}

async function readAssets(kind, projectId = 'default') {
  if (postgresStore) {
    if (['tables', 'flows', 'eventStreams'].includes(kind)) return (await postgresStore.listAssets(kind, projectId)).map(item => initializeAssetRevision(normalizeAssetPackages(item)));
    if (kind === 'testSuites') return postgresStore.listTestSuites(projectId);
    if (kind === 'releases') return postgresStore.listReleases(projectId);
  }
  try {
    const assets = JSON.parse(await fs.readFile(assetFiles[kind], 'utf8'));
    if (['tables', 'flows', 'eventStreams'].includes(kind)) return assets.filter(item => assetProject(item) === projectId).map(item => initializeAssetRevision(normalizeAssetPackages(item)));
    if (kind === 'testSuites') return assets.filter(item => assetProject(item) === projectId).map(item => ({ ...item, revision: item.revision || 1 }));
    return assets;
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function writeAssets(kind, assets, projectId = 'default') {
  if (postgresStore) {
    if (['tables', 'flows', 'eventStreams'].includes(kind)) return postgresStore.saveAssets(kind, assets, null, projectId);
    if (kind === 'testSuites') return postgresStore.saveTestSuites(assets, null, projectId);
    if (kind === 'releases') return postgresStore.saveReleases(assets, null, projectId);
  }
  const file = assetFiles[kind];
  if (['tables', 'flows', 'eventStreams', 'testSuites'].includes(kind)) {
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const persisted = assets.map(item => projectId === 'default' ? item : { ...item, projectId });
    assets = [...existing.filter(item => assetProject(item) !== projectId), ...persisted];
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(assets, null, 2));
  await fs.rename(temp, file);
}

async function readReleases(projectId = 'default') {
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
  if (postgresStore) return postgresStore.saveReleases(releases, null, projectId);
  let existing = [];
  try { existing = JSON.parse(await fs.readFile(assetFiles.releases, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return writeJsonFile(assetFiles.releases, [
    ...existing.filter(item => assetProject(item) !== projectId),
    ...releases.map(item => projectId === 'default' ? item : { ...item, projectId }),
  ]);
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

function defaultProjectRecord() {
  return {
    id: 'default', name: '默认风控项目', description: 'Team Server 当前 default 工作空间中的真实规则资产',
    icon: 'shield', engine: 'rules', version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local', archived: false,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: new Date().toISOString(), updatedBy: 'Team Server',
  };
}

async function readProjectRecords(includeArchived = false) {
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
  if (postgresStore) return postgresStore.savePackages(projectId, packages);
  let all = [];
  try { all = JSON.parse(await fs.readFile(assetFiles.packages, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return writeJsonFile(assetFiles.packages, [
    ...all.filter(pkg => pkg.projectId !== projectId),
    ...packages.map(pkg => ({ ...pkg, projectId })),
  ]);
}




function blankBom() {
  return { version: 1, updatedAt: new Date().toISOString(), fields: [], eventTypes: [] };
}

function grainBomTemplate() {
  const bom = defaultBom();
  bom.fields = [
    { key: 'eventId', label: '事件 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'sampledAt', label: '采样时间', type: 'String', semanticType: 'Date', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'date', description: '' },
    { key: 'warehouseId', label: '粮仓 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'sensorId', label: '传感器 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'averageTemperature', label: '整仓均温', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓', group: '温控监测', unit: '°C', min: -50, max: 80, enum: null, control: 'number', description: '' },
    { key: 'humidity', label: '仓内湿度', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓', group: '温控监测', unit: '%', min: 0, max: 100, enum: null, control: 'number', description: '' },
    { key: 'ventilationRequired', label: '是否通风', type: 'Boolean', semanticType: 'Boolean', kind: 'output', factType: 'ControlDecision', factTypeLabel: '调控决策', group: '结果输出', unit: null, min: null, max: null, enum: null, control: 'boolean', description: '' },
  ];
  bom.eventTypes = [{
    name: 'GrainStore',
    label: '粮仓温控采样事件',
    version: 1,
    keyField: 'warehouseId',
    timeField: 'sampledAt',
    sourceField: 'sensorId',
    retention: '24h',
    allowedLateness: '5m',
    duplicateKey: ['eventId'],
    fields: [
      { field: 'eventId', required: true },
      { field: 'warehouseId', required: true },
      { field: 'sensorId', required: true },
      { field: 'sampledAt', required: true },
      { field: 'averageTemperature', required: true },
      { field: 'humidity', required: false },
    ],
  }];
  return bom;
}

async function createProjectRecord(payload, actor) {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > 80) return { status: 400, error: '项目名称需为 1-80 个字符' };
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
  if (description.length > 500) return { status: 400, error: '项目描述不能超过 500 个字符' };
  const icon = ['loan', 'warehouse', 'shield'].includes(payload?.icon) ? payload.icon : 'shield';
  const engine = payload?.engine == null ? 'rules' : payload.engine;
  if (!VALID_PROJECT_ENGINES.has(engine)) return { status: 400, error: '项目引擎类型必须是 rules 或 cep' };
  const existing = await readProjectRecords(true);
  if (existing.some(project => project.name === name)) return { status: 409, error: '项目名称已存在' };
  const id = `project-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const project = { id, name, description, icon, engine, version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local', archived: false, createdAt: now, updatedAt: now, updatedBy: actor };
  let bom = blankBom();
  let packages = [];
  if (payload?.bomTemplate === 'loan' || payload?.bomTemplate === 'risk') bom = defaultBom();
  else if (payload?.bomTemplate === 'grain') bom = grainBomTemplate();
  else if (typeof payload?.copyProjectId === 'string') {
    const source = existing.find(item => item.id === payload.copyProjectId);
    if (!source) return { status: 400, error: '复制来源项目不存在' };
    bom = structuredClone(await readBom(source.id));
    bom.version = 1;
    bom.updatedAt = now;
    const sourceData = await projectData(source.id);
    packages = structuredClone(await readPackageRecords(source.id, sourceData));
  }
  if (postgresStore) await postgresStore.createProject(project, bom, packages);
  else {
    await writeProjectRecords([...existing, project]);
    await writeBom(bom, null, id);
    await writePackageRecords(id, packages);
  }
  return { item: { ...project, packageCount: packages.length, assetCount: 0, environmentCount: 0, source: 'server' } };
}

async function readChangeSets(projectId = 'default') {
  if (postgresStore) return postgresStore.listChangeSets(projectId);
  try {
    const all = JSON.parse(await fs.readFile(assetFiles.changeSets, 'utf8'));
    return all.filter(item => (item.projectId || 'default') === projectId).map(({ projectId: _projectId, ...item }) => item);
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function writeChangeSets(changeSets, projectId = 'default') {
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
  if (postgresStore) return postgresStore.listAuditEvents(100, projectId);
  try {
    const all = JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8'));
    return all.filter(item => (item.projectId || 'default') === projectId);
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readAllAuditEvents() {
  if (postgresStore) throw new Error('PostgreSQL 全局审计读取必须指定可访问项目');
  try { return JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function deleteAuditEvents(projectId) {
  if (postgresStore) return;
  let all = [];
  try { all = JSON.parse(await fs.readFile(assetFiles.auditEvents, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJsonFile(assetFiles.auditEvents, all.filter(item => (item.projectId || 'default') !== projectId));
}

// JSON storage needs a dedicated append queue because audit writes happen after
// the business mutation queue has been released. PostgreSQL uses atomic inserts.
let auditQueue = Promise.resolve();

function actorOf(req) {
  if (req?.principal?.id) return req.principal.id;
  const actorHeader = req?.headers?.['x-actor'];
  return typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim().slice(0, 80) : 'local-user';
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

const ASSET_ACTIVITY_TYPES = new Set(['rule', 'table', 'flow', 'event-stream']);

const handleAdmin = createAdminHandler({
  adminUsersFile: assetFiles.adminUsers,
  writeJsonFile,
  appendAuditEvent,
});

const { bomFieldReferences, handleBom, updateProjectBom } = createBomHandlers({
  getCurrentBom: () => currentBom,
  setCurrentBom: bom => { currentBom = bom; },
  getPostgresStore: () => postgresStore,
  readRules,
  readAssets,
  collectUsedKeys,
  writeBom,
  appendAuditEvent,
});

const handleReleases = createReleaseHandler({
  readProjectRecord,
  readReleases,
  mutateReleases,
  readRules,
  readAssets,
  writeAssets,
  readBom,
  actorOf,
  appendAuditEvent,
  engine,
  executionServer,
  runTestSuite,
  recordSuiteRun,
  parseFacts,
});

const handleTestSuites = createTestSuiteHandler({
  readAssets,
  mutateTestSuites,
  appendAuditEvent,
  validateSuiteTarget,
  runAllTestSuites,
  runSingleTestSuite,
  runTestSuiteComparison,
  presentTestSuite: (suite, project) => project ? projectTestSuite(suite, project) : suite,
});

const handleChangeSets = createChangeSetHandler({
  readChangeSets,
  mutateChangeSets,
  readRules,
  readAssets,
  readBom,
  projectData,
  readProjectRecord,
  compileProjectEventStream,
  compileProjectFlow,
  compileProjectAsset,
  publishProjectEventStream,
  publishProjectFlow,
  publishProjectAsset,
  actorOf,
  appendAuditEvent,
  serializeReview,
});

const handleProjectPackages = createProjectPackageHandler({
  visibleProjectPackages,
  mutatePackageRecords,
  readPackageRecords,
  projectData,
  flowReferencesPackage,
  flowPackageSelectors,
  reviewLock,
  mutate,
  mutateAssets,
  advanceAssetRevision,
});

const handleProjectEventStreams = createProjectEventStreamHandler({
  projectBomModel,
  mutateAssets,
  initializeAssetRevision,
  appendAuditEvent,
  projectEventStreamSummary,
  projectEventStreamDetail,
  authorizeAsset,
  reviewLock,
  advanceAssetRevision,
  compileProjectEventStream,
  publishProjectEventStream,
  actorOf,
});

const handleProjectFlows = createProjectFlowHandler({
  canAccessAsset,
  authorizeAsset,
  mutateAssets,
  initializeAssetRevision,
  appendAuditEvent,
  projectRuleset,
  projectFlowDetail,
  reviewLock,
  advanceAssetRevision,
  compileProjectFlow,
  publishProjectFlow,
});

const handleProjectRules = createProjectRuleHandler({
  canAccessAsset,
  authorizeAsset,
  projectPackages,
  projectAssetDetail,
  writePackageRecords,
  initializeAssetRevision,
  mutate,
  mutateAssets,
  appendAuditEvent,
  reviewLock,
  saveProjectAsset,
  advanceAssetRevision,
  compileProjectAsset,
  publishProjectAsset,
  mutateChangeSets,
  submittedChangeSetForAsset,
  readRules,
  readAssets,
  actorOf,
  readChangeSets,
});

async function recentActivity(principal, limit) {
  const projects = (await readProjectRecords(false)).filter(project => canAccessProject(principal, project));
  const projectById = new Map(projects.map(project => [project.id, project]));
  const projectIds = [...projectById.keys()];
  const scanLimit = Math.min(5000, Math.max(limit * 20, 200));
  const events = postgresStore
    ? await postgresStore.listAuditEventsForProjects(scanLimit, projectIds)
    : (await readAllAuditEvents()).filter(event => projectById.has(event.projectId || 'default'));
  return events
    .filter(event => !ASSET_ACTIVITY_TYPES.has(event.resourceType) || canAccessAsset(principal, event.resourceId))
    .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
    .slice(0, limit)
    .map(event => {
      const project = projectById.get(event.projectId || 'default');
      return {
        id: event.id,
        project: { id: project.id, name: project.name, engine: normalizeProjectEngine(project.engine) },
        actor: event.actor,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        summary: event.summary,
        details: event.details || {},
        occurredAt: event.occurredAt,
      };
    });
}






// Serialize mutations so concurrent requests cannot overwrite each other's snapshots.
let queue = Promise.resolve();
let packageQueue = Promise.resolve();
let reviewQueue = Promise.resolve();

function serializeReview(operation) {
  const pending = reviewQueue.then(operation);
  reviewQueue = pending.catch(() => {});
  return pending;
}

function mutatePackageRecords(projectId, data, operation) {
  const pending = packageQueue.then(async () => {
    const packages = await readPackageRecords(projectId, data);
    const result = await operation(packages);
    if (result?.changed) await writePackageRecords(projectId, packages);
    return result;
  });
  packageQueue = pending.catch(() => {});
  return pending;
}

function mutate(operation, projectId = 'default') {
  const pending = queue.then(async () => {
    const rules = await readRules(projectId);
    const result = await operation(rules);
    await writeRules(rules, projectId);
    return result;
  });
  queue = pending.catch(() => {});
  return pending;
}

function mutateAssets(kind, operation, projectId = 'default') {
  const pending = queue.then(async () => {
    const assets = await readAssets(kind, projectId);
    const result = await operation(assets);
    if (result?.item || result?.changed) await writeAssets(kind, assets, projectId);
    return result;
  });
  queue = pending.catch(() => {});
  return pending;
}

function mutateReleases(operation, projectId = 'default') {
  const pending = queue.then(async () => {
    const releases = await readReleases(projectId);
    const result = await operation(releases);
    if (result?.changed) await writeReleases(releases, projectId);
    return result;
  });
  queue = pending.catch(() => {});
  return pending;
}

function mutateTestSuites(operation, projectId = 'default') {
  const pending = queue.then(async () => {
    const suites = await readAssets('testSuites', projectId);
    const result = await operation(suites);
    if (result?.changed) await writeAssets('testSuites', suites, projectId);
    return result;
  });
  queue = pending.catch(() => {});
  return pending;
}

function mutateChangeSets(operation, projectId = 'default') {
  const pending = queue.then(async () => {
    const changeSets = await readChangeSets(projectId);
    const result = await operation(changeSets);
    if (result?.changed) await writeChangeSets(changeSets, projectId);
    return result;
  });
  queue = pending.catch(() => {});
  return pending;
}


async function publishedTarget(target, projectId = 'default', versionNumber = null) {
  const project = await readProjectRecord(projectId);
  const collection = target.type === 'rule' ? await readRules(projectId) : await readAssets(target.type === 'event-stream' ? 'eventStreams' : `${target.type}s`, projectId);
  const item = collection.find(asset => asset.id === target.id && !asset.archived);
  if (!item) return { status: 404, error: '测试目标不存在' };
  const version = versionNumber == null
    ? item.versions?.at(-1)
    : item.versions?.find(entry => entry.number === versionNumber);
  if (!item.published || !item.versions?.length) return { status: 400, error: '测试目标尚未发布' };
  if (!version) return { status: 404, error: `测试目标版本 v${versionNumber} 不存在` };
	  if (target.type === 'rule') {
	    const bom = version.bom || await readBom(projectId);
	    return {
	      type: target.type, item, version: version.number, bom, project,
	      drl: version.drl || generateDrl([version.rule || item.published], bom),
	    };
	  }
  if (target.type === 'table') {
    const bom = version.bom || await readBom(projectId);
	    const table = version.draft || item.published;
	    return {
	      type: target.type, item, version: version.number, bom, table, project,
	      drl: version.drl || tableDrl(table, bom, item.id),
	    };
	  }
  if (target.type === 'event-stream') {
    return {
	      type: target.type,
	      item,
	      version: version.number,
	      project,
	      bom: version.bom || await readBom(projectId),
	      module: version.module || { schemas: version.schemas || [], statements: version.statements || [] },
	    };
	  }
	  const flow = version.snapshot || item.published;
	  return { type: target.type, item, version: version.number, project, bom: flow.bom || version.bom || await readBom(projectId), flow };
}

async function executeFlow(flow, initialFacts, options = {}) {
  const facts = { ...initialFacts };
  const nodeIds = new Set();
  const nodeAddress = (step, legacyNodeId) => ({ nodeId: step.nodeId || legacyNodeId, legacyNodeId });
  flow.steps.forEach((step, index) => {
    const address = nodeAddress(step, `common:${index}`);
    nodeIds.add(address.nodeId);
    nodeIds.add(address.legacyNodeId);
  });
  if (flow.branches?.length) {
    nodeIds.add('gateway');
    for (const branch of flow.branches) branch.steps.forEach((step, index) => {
      const address = nodeAddress(step, `branch:${branch.id}:${index}`);
      nodeIds.add(address.nodeId);
      nodeIds.add(address.legacyNodeId);
    });
  }
  const stopAfter = options.stopAfter == null || options.stopAfter === '' ? null : options.stopAfter;
  if (stopAfter != null && (typeof stopAfter !== 'string' || !nodeIds.has(stopAfter))) return { status: 400, error: '调试停止节点无效' };
  const expectsPath = Object.prototype.hasOwnProperty.call(options, 'expectedPath');
  const expectedPath = options.expectedPath;
  if (expectsPath && expectedPath !== null && (typeof expectedPath !== 'string' || !flow.branches?.some(branch => branch.id === expectedPath))) {
    return { status: 400, error: '期望流程路径无效' };
  }

  const trace = [];
  const outFields = outputFields(flow.bom || currentBom);
  let limitReached = false;
  let stoppedAt = null;
  let selectedBranch = null;
  let gatewayEvaluated = false;
  const runSteps = async (steps, scope) => {
    for (const [index, step] of steps.entries()) {
      const legacyNodeId = scope.kind === 'common' ? `common:${index}` : `branch:${scope.branch.id}:${index}`;
      const nodeId = step.nodeId || legacyNodeId;
      const inputMappings = applyFlowMappings(step.inputMappings, facts);
      const checked = await engine('/test', { drl: step.drl, facts });
      if (checked.error) {
        return {
          error: `${step.name}：${checked.error}`,
          status: checked.status,
          failedStep: {
            nodeId, legacyNodeId, name: step.name, type: step.type, version: step.version,
            branchId: scope.branch?.id || null, branchName: scope.branch?.name || null,
          },
        };
      }
      for (const field of outFields) {
        const value = checked.result.facts[field.key];
        if (value !== undefined && value !== null) facts[field.key] = value;
      }
      const outputMappings = applyFlowMappings(step.outputMappings, facts);
      trace.push({
        nodeId, legacyNodeId, name: step.name, type: step.type, version: step.version, fired: checked.result.fired,
        decisionHits: checked.result.decisionHits || [],
        count: checked.result.count, facts: { ...facts }, mappings: { inputs: inputMappings, outputs: outputMappings },
      });
      if (checked.result.limitReached) { limitReached = true; break; }
      if (stopAfter === nodeId || stopAfter === legacyNodeId) { stoppedAt = nodeId; break; }
    }
    return null;
  };
  const failure = async failed => ({ status: failed.status, result: {
    error: failed.error, failedStep: failed.failedStep, facts, trace,
    path: selectedBranch ? { branchId: selectedBranch.id, branchName: selectedBranch.name, default: selectedBranch.default } : null,
    debug: { requestedStop: stopAfter, stoppedAt },
  } });

  const commonError = await runSteps(flow.steps, { kind: 'common' });
  if (commonError) return failure(commonError);
  if (!limitReached && !stoppedAt && flow.branches?.length) {
    selectedBranch = selectFlowBranch(flow.branches, facts);
    gatewayEvaluated = true;
    trace.push({
      nodeId: 'gateway', name: '条件网关', type: 'gateway', count: 0, facts: { ...facts },
      branchId: selectedBranch?.id || null, branchName: selectedBranch?.name || null, default: selectedBranch?.default === true,
    });
    if (stopAfter === 'gateway') stoppedAt = 'gateway';
    if (selectedBranch && !stoppedAt) {
      const branchError = await runSteps(selectedBranch.steps, { kind: 'branch', branch: selectedBranch });
      if (branchError) return failure(branchError);
    }
  }
  const assertions = [];
  if (expectsPath) {
    const actual = gatewayEvaluated ? selectedBranch?.id || null : null;
    const expectedBranch = flow.branches?.find(branch => branch.id === expectedPath);
    assertions.push({
      type: 'path', expected: expectedPath, actual,
      expectedName: expectedBranch?.name || (expectedPath === null ? '无匹配分支' : null),
      actualName: selectedBranch?.name || (gatewayEvaluated ? '无匹配分支' : null),
      evaluated: gatewayEvaluated, passed: gatewayEvaluated && actual === expectedPath,
    });
  }
  return { status: 200, result: {
    ok: true, facts, trace, limitReached,
    path: selectedBranch ? { branchId: selectedBranch.id, branchName: selectedBranch.name, default: selectedBranch.default } : null,
    debug: { requestedStop: stopAfter, stoppedAt }, assertions,
    passed: assertions.every(assertion => assertion.passed),
    count: trace.reduce((total, step) => total + step.count, 0),
  } };
}

async function executeResolvedTarget(resolved, rawFacts) {
  if (resolved.type === 'event-stream') {
    const events = Array.isArray(rawFacts?.events) ? rawFacts.events : Array.isArray(rawFacts) ? rawFacts : [];
    if (!Array.isArray(events)) return { status: 400, error: '事件输入无效' };
    const validation = validateEventPayloads(events, resolved.bom);
    if (validation) return { status: 400, error: validation, targetVersion: resolved.version, bom: resolved.bom };
    const waitMs = Number.isInteger(rawFacts?.waitMs) ? rawFacts.waitMs : 0;
    const checked = await engine('/test', { module: resolved.module, events, ...(waitMs ? { waitMs } : {}) }, resolved.project || 'cep');
    if (checked.error) return { ...checked, targetVersion: resolved.version, bom: resolved.bom };
    return { status: 200, result: checked.result, targetVersion: resolved.version, bom: resolved.bom, normalizedFacts: { events, ...(waitMs ? { waitMs } : {}) } };
  }
  const facts = parseFacts(rawFacts, resolved.bom);
  if (!facts) return { status: 400, error: '测试输入字段或类型无效' };
  const normalizedFacts = structuredClone(facts);
  if (resolved.type === 'flow') {
    const executed = await executeFlow(resolved.flow, facts);
    return { ...executed, targetVersion: resolved.version, bom: resolved.bom, normalizedFacts };
  }
  const checked = await engine('/test', { drl: resolved.drl, facts });
  if (checked.error) return { ...checked, targetVersion: resolved.version, bom: resolved.bom };
  const result = resolved.type === 'table' ? {
    ...checked.result,
    hitPolicy: resolved.table.hitPolicy || 'ALL',
    decisionTrace: tableExecutionTrace(resolved.table, checked.result.fired, resolved.bom),
    decisionHits: Array.isArray(checked.result.decisionHits) && checked.result.decisionHits.length ? checked.result.decisionHits : tableCollectedHits(resolved.table, checked.result.fired, resolved.bom),
  } : checked.result;
  return { status: 200, result, targetVersion: resolved.version, bom: resolved.bom, normalizedFacts };
}

async function executePublishedTarget(target, rawFacts, projectId = 'default', versionNumber = null) {
  const resolved = await publishedTarget(target, projectId, versionNumber);
  if (resolved.error) return resolved;
  return executeResolvedTarget(resolved, rawFacts);
}

function coverageDefinition(resolved) {
  if (resolved.type === 'rule') {
    const rule = resolved.item.versions.find(version => version.number === resolved.version)?.rule || resolved.item.published;
    return { kind: 'rule', items: [{ id: resolved.item.id, label: rule?.name || resolved.item.id }] };
  }
  if (resolved.type === 'table') {
    return {
      kind: 'table-row',
      items: resolved.table.rows.flatMap((row, index) => row.enabled === false ? [] : [{
        id: `row:${index}`,
        label: row.isDefault ? `默认行（第 ${index + 1} 行）` : `第 ${index + 1} 行`,
      }]),
    };
  }
  if (resolved.type === 'event-stream') {
    const statements = resolved.module?.statements || [];
    return {
      kind: 'event-statement',
      items: statements.length
        ? statements.map(statement => ({ id: statement.name, label: statement.name }))
        : [{ id: 'event-stream', label: resolved.item?.draft?.name || '事件流' }],
    };
  }
  const branches = resolved.flow.branches || [];
  return {
    kind: 'flow-path',
    items: branches.length
      ? branches.map(branch => ({ id: branch.id, label: branch.name }))
      : [{ id: 'main', label: '主路径' }],
  };
}

function coverageHits(resolved, executionResult) {
  if (resolved.type === 'rule') return executionResult.fired?.length ? [resolved.item.id] : [];
  if (resolved.type === 'table') {
    return (executionResult.decisionTrace || [])
      .filter(entry => entry.rowIndex !== null)
      .map(entry => `row:${entry.rowIndex}`);
  }
  if (resolved.type === 'event-stream') return (executionResult.detections || []).map(event => event.statement || 'event-stream');
  if (resolved.flow.branches?.length) return executionResult.path?.branchId ? [executionResult.path.branchId] : [];
  return executionResult.error ? [] : ['main'];
}

function coverageReport(definition, hitIds) {
  const hits = new Set(hitIds);
  const items = definition.items.map(item => ({ ...item, hit: hits.has(item.id) }));
  const hit = items.filter(item => item.hit).length;
  return {
    kind: definition.kind,
    hit,
    total: items.length,
    percentage: items.length ? Math.round((hit / items.length) * 1000) / 10 : 100,
    items,
  };
}

async function executeSuiteCases(suite, resolved) {
  const cases = [];
  const hitIds = [];
  for (const testCase of expandTestCases(suite)) {
    const caseStarted = Date.now();
    const identity = {
      id: testCase.id, name: testCase.name,
      parentCaseId: testCase.parentCaseId,
      parameterId: testCase.parameterId,
      parameterName: testCase.parameterName,
    };
    const executed = await executeResolvedTarget(resolved, testCase.facts);
    if (executed.error || executed.result?.error) {
      cases.push({ ...identity, passed: false, durationMs: Date.now() - caseStarted, error: executed.error || executed.result.error });
      continue;
    }
    hitIds.push(...coverageHits(resolved, executed.result));
    const actual = resolved.type === 'event-stream' ? evaluateCepTestCase(testCase, executed.result) : evaluateTestCase(testCase, executed.result, resolved.bom);
    const normalizedFacts = executed.normalizedFacts || {};
    const omittedFields = resolved.type === 'event-stream' ? [] : inputFields(resolved.bom).filter(field => normalizedFacts[field.key] === undefined).map(field => field.key);
    cases.push({ ...identity, durationMs: Date.now() - caseStarted, inputFacts: normalizedFacts, omittedFields, ...actual });
  }
  return { cases, coverage: coverageReport(coverageDefinition(resolved), hitIds) };
}

async function runTestSuite(suite, projectId = 'default', versionNumber = null) {
  const started = Date.now();
  const target = await publishedTarget(suite.target, projectId, versionNumber);
  const report = {
    id: crypto.randomUUID(), suiteId: suite.id, suiteName: suite.name,
    target: structuredClone(suite.target), targetVersion: target.version || null,
    passed: false, total: 0, passedCount: 0, failedCount: 0,
    runAt: new Date().toISOString(), durationMs: 0, cases: [],
  };
  if (target.error) {
    report.error = target.error;
    report.durationMs = Date.now() - started;
    return report;
  }
  const validation = validateTestSuite(suite, target.bom);
  if (validation) {
    report.error = validation;
    report.durationMs = Date.now() - started;
    return report;
  }
  const execution = await executeSuiteCases(suite, target);
  report.cases = execution.cases;
  report.coverage = execution.coverage;
  report.total = report.cases.length;
  report.passedCount = report.cases.filter(testCase => testCase.passed).length;
  report.failedCount = report.total - report.passedCount;
  report.passed = report.total > 0 && report.failedCount === 0;
  report.durationMs = Date.now() - started;
  return report;
}

function comparableCase(testCase) {
  return {
    outputs: testCase.outputs || {},
    fired: testCase.fired || [],
    path: testCase.path ?? null,
    passed: testCase.passed,
    error: testCase.error || null,
  };
}

function sameBehavior(left, right) {
  return JSON.stringify(comparableCase(left)) === JSON.stringify(comparableCase(right));
}

async function compareTestSuite(suite, baseVersion, candidateVersion, projectId = 'default') {
  const started = Date.now();
  const [baseTarget, candidateTarget] = await Promise.all([
    publishedTarget(suite.target, projectId, baseVersion),
    publishedTarget(suite.target, projectId, candidateVersion),
  ]);
  if (baseTarget.error) return { status: baseTarget.status, error: baseTarget.error };
  if (candidateTarget.error) return { status: candidateTarget.status, error: candidateTarget.error };
  const baseValidation = validateTestSuite(suite, baseTarget.bom);
  const candidateValidation = validateTestSuite(suite, candidateTarget.bom);
  if (baseValidation || candidateValidation) return { status: 400, error: baseValidation || candidateValidation };
  const [baseRun, candidateRun] = await Promise.all([
    executeSuiteCases(suite, baseTarget),
    executeSuiteCases(suite, candidateTarget),
  ]);
  const baseById = new Map(baseRun.cases.map(testCase => [testCase.id, testCase]));
  const cases = candidateRun.cases.map(candidate => {
    const base = baseById.get(candidate.id);
    let classification = 'changed';
    if (base && sameBehavior(base, candidate)) classification = 'unchanged';
    else if (base && !base.passed && candidate.passed) classification = 'improved';
    else if (base && base.passed && !candidate.passed) classification = 'regressed';
    return {
      id: candidate.id,
      name: candidate.name,
      parentCaseId: candidate.parentCaseId,
      parameterId: candidate.parameterId,
      parameterName: candidate.parameterName,
      classification,
      base: base ? comparableCase(base) : null,
      candidate: comparableCase(candidate),
    };
  });
  const summary = {
    total: cases.length,
    unchanged: cases.filter(testCase => testCase.classification === 'unchanged').length,
    changed: cases.filter(testCase => testCase.classification === 'changed').length,
    improved: cases.filter(testCase => testCase.classification === 'improved').length,
    regressed: cases.filter(testCase => testCase.classification === 'regressed').length,
    reviewRequired: cases.filter(testCase => testCase.classification !== 'unchanged').length,
  };
  return { status: 200, report: {
    id: crypto.randomUUID(), kind: 'comparison', suiteId: suite.id, suiteName: suite.name,
    target: structuredClone(suite.target), baseVersion, candidateVersion,
    passed: cases.every(testCase => testCase.candidate.passed),
    runAt: new Date().toISOString(), durationMs: Date.now() - started,
    summary, cases, coverage: { base: baseRun.coverage, candidate: candidateRun.coverage },
  } };
}

function recordSuiteRun(suite, report) {
  suite.lastRun = report;
  suite.runs = [report, ...(suite.runs || [])].slice(0, 20);
  suite.revision = (suite.revision || 1) + 1;
  suite.updatedAt = new Date().toISOString();
}

async function runAllTestSuites(req, projectId = 'default') {
  const result = await mutateTestSuites(async suites => {
    const reports = [];
    for (const suite of suites.filter(entry => !entry.archived)) {
      const report = await runTestSuite(suite, projectId);
      recordSuiteRun(suite, report);
      reports.push(report);
    }
    return { reports, changed: reports.length > 0 };
  }, projectId);
  await appendAuditEvent('test-suite.run-all', 'project', projectId, '运行全量回归测试', {
    total: result.reports.length, passed: result.reports.filter(report => report.passed).length,
  }, req);
  return {
    passed: result.reports.every(report => report.passed),
    total: result.reports.length,
    passedCount: result.reports.filter(report => report.passed).length,
    reports: result.reports,
  };
}

async function runSingleTestSuite(id, req, projectId = 'default', versionNumber = null) {
  const result = await mutateTestSuites(async suites => {
    const suite = suites.find(entry => entry.id === id && !entry.archived);
    if (!suite) return { status: 404, error: '测试套件不存在' };
    const report = await runTestSuite(suite, projectId, versionNumber);
    recordSuiteRun(suite, report);
    return { item: suite, report, changed: true };
  }, projectId);
  if (!result.error) {
    await appendAuditEvent('test-suite.run', 'test-suite', id, `运行测试套件：${result.item.name}`, {
      revision: result.item.revision, passed: result.report.passed, runId: result.report.id,
    }, req);
  }
  return result;
}

async function runTestSuiteComparison(id, input, req, projectId = 'default') {
  const result = await mutateTestSuites(async suites => {
    const suite = suites.find(entry => entry.id === id && !entry.archived);
    if (!suite) return { status: 404, error: '测试套件不存在' };
    const target = await publishedTarget(suite.target, projectId);
    if (target.error) return target;
    const versions = target.item.versions.map(version => version.number).sort((left, right) => left - right);
    if (versions.length < 2) return { status: 400, error: '测试目标至少需要两个已发布版本才能对比' };
    const candidateVersion = input.candidateVersion ?? versions.at(-1);
    const candidateIndex = versions.indexOf(candidateVersion);
    const baseVersion = input.baseVersion ?? versions[candidateIndex - 1];
    if (!Number.isInteger(baseVersion) || !Number.isInteger(candidateVersion)) return { status: 400, error: '对比版本必须是整数' };
    if (baseVersion === candidateVersion) return { status: 400, error: '基线版本和候选版本不能相同' };
    const compared = await compareTestSuite(suite, baseVersion, candidateVersion, projectId);
    if (compared.error) return compared;
    suite.runs = [compared.report, ...(suite.runs || [])].slice(0, 20);
    suite.revision = (suite.revision || 1) + 1;
    suite.updatedAt = new Date().toISOString();
    return { item: suite, report: compared.report, changed: true };
  }, projectId);
  if (!result.error) {
    await appendAuditEvent('test-suite.compare', 'test-suite', id, `对比测试套件版本：${result.item.name}`, {
      revision: result.item.revision, baseVersion: result.report.baseVersion,
      candidateVersion: result.report.candidateVersion, reviewRequired: result.report.summary.reviewRequired,
    }, req);
  }
  return result;
}

async function currentConflictResource(resource, projectId = 'default') {
  const separator = resource.indexOf(':');
  const type = resource.slice(0, separator);
  const id = resource.slice(separator + 1);
  if (type === 'bom') return postgresStore?.getBom(projectId);
  if (type === 'test-suite') return (await readAssets('testSuites', projectId)).find(item => item.id === id) || null;
  if (type === 'change-set') return (await readChangeSets(projectId)).find(item => item.id === id) || null;
  if (['rule', 'table', 'flow', 'event-stream'].includes(type)) {
    const items = type === 'rule' ? await readRules(projectId) : await readAssets(type === 'event-stream' ? 'eventStreams' : `${type}s`, projectId);
    return items.find(item => item.id === id) || null;
  }
  return null;
}

async function validateSuiteTarget(suite, projectId = 'default') {
  if (!suite?.target || !['rule', 'table', 'flow', 'event-stream'].includes(suite.target.type)
    || typeof suite.target.id !== 'string' || !suite.target.id) return { status: 400, error: '测试目标无效' };
  const project = await readProjectRecord(projectId);
  const collection = suite.target?.type === 'rule'
    ? await readRules(projectId)
    : await readAssets(suite.target?.type === 'event-stream' ? 'eventStreams' : `${suite.target?.type}s`, projectId);
  const item = collection.find(asset => asset.id === suite.target?.id && !asset.archived);
  if (!item) return { status: 404, error: '测试目标不存在' };
  const target = item.published && item.versions?.length
    ? await publishedTarget(suite.target, projectId)
    : {
        type: suite.target.type,
        item,
        version: null,
        project,
        bom: await readBom(projectId),
        ...(suite.target.type === 'flow' ? { flow: item.draft } : {}),
      };
  if (target.error) return target;
  const error = validateTestSuite(suite, target.bom);
  if (error) return { status: 400, error };
  if (suite.target.type === 'flow') {
    const branchIds = new Set((target.flow.branches || []).map(branch => branch.id));
    for (const testCase of suite.cases) {
      const path = testCase.expected.path;
      if (path !== undefined && path !== null && !branchIds.has(path)) return { status: 400, error: `${testCase.name}的期望路径不在已发布流程中` };
    }
  }
  return target;
}



async function handleAsset(req, res, segments) {
  const kind = segments[1];
  const isTable = kind === 'tables';
  function validateTableSafe(draft) { const v = validateTable(draft, currentBom); return v.error ? v.error : null; }
  const validate = isTable ? validateTableSafe : validateFlow;
  if (segments.length === 2) {
    if (req.method === 'GET') return reply(res, 200, await readAssets(kind));
    if (req.method === 'POST') {
      const result = await mutateAssets(kind, assets => {
        const now = new Date().toISOString();
        const item = initializeAssetRevision({ id: crypto.randomUUID(), draft: isTable ? newTable() : newFlow(), published: null, versions: [], archived: false, updatedAt: now });
        assets.unshift(item);
        return { item };
      });
      await appendAuditEvent('asset.created', isTable ? 'table' : 'flow', result.item.id, `创建${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, result.item);
    }
  }
  if (segments.length < 3 || segments.length > 4) return reply(res, 404, { error: '未找到资源' });
  const id = segments[2];
  if (segments.length === 3 && req.method === 'PUT') {
    const payload = await bodyOf(req);
    const expected = expectedRevision(req, payload);
    if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
    const draft = normalizePackageReferences(structuredClone(payload?.draft && payload.revision != null ? payload.draft : payload));
    const rules = isTable ? null : await readRules();
    const tables = isTable ? null : await readAssets('tables');
    const packageRecords = isTable ? [] : await readPackageRecords('default', { rules, tables });
    const error = isTable ? validate(draft) : validate(draft, rules, tables, currentBom, packageRecords, { allowEmptyRuleGroups: true });
    if (error) return reply(res, 400, { error });
    const result = await mutateAssets(kind, assets => {
      const item = assets.find(asset => asset.id === id && !asset.archived);
      if (!item) return { status: 404, error: '资产不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      item.draft = draft;
      advanceAssetRevision(item, 'saved', true);
      return { item };
    });
    if (result.error) return reply(res, result.status, operationError(result));
    await appendAuditEvent('asset.saved', isTable ? 'table' : 'flow', id, `保存${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`, { revision: result.item.revision }, req);
    return reply(res, 200, result.item);
  }
  if (segments.length !== 4 || req.method !== 'POST') return reply(res, 404, { error: '未找到操作' });
  const action = segments[3];
  if (action === 'test') {
    const payload = await bodyOf(req);
    const item = (await readAssets(kind)).find(asset => asset.id === id && !asset.archived);
    if (!item) return reply(res, 404, { error: '资产不存在' });
    const facts = parseFacts(payload.facts);
    if (!facts) return reply(res, 400, { error: '测试输入字段或类型无效' });
    if (isTable) {
      const table = payload.draft || item.draft;
      const v = validateTable(table, currentBom);
      if (v.error) return reply(res, 400, { error: v.error });
      const checked = await engine('/test', { drl: tableDrl(table, currentBom, item.id), facts });
      if (checked.error) return reply(res, checked.status, { error: checked.error });
      return reply(res, 200, {
        ...checked.result,
        hitPolicy: table.hitPolicy || 'ALL',
        validationWarnings: v.warnings,
        decisionTrace: tableExecutionTrace(table, checked.result.fired, currentBom),
        decisionHits: Array.isArray(checked.result.decisionHits) && checked.result.decisionHits.length ? checked.result.decisionHits : tableCollectedHits(table, checked.result.fired, currentBom),
      });
    }
    const rules = await readRules();
    const tables = await readAssets('tables');
    let flow;
    try {
      const packageRecords = await readPackageRecords('default', { rules, tables });
      flow = payload.published ? item.published : flowSnapshot(payload.draft || item.draft, rules, tables, currentBom, packageRecords);
    }
    catch (error) { return reply(res, 400, { error: error.message }); }
    if (!flow) return reply(res, 400, { error: '规则流尚未发布' });
    const options = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'stopAfter')) options.stopAfter = payload.stopAfter;
    if (Object.prototype.hasOwnProperty.call(payload, 'expectedPath')) options.expectedPath = payload.expectedPath;
    const executed = await executeFlow(flow, facts, options);
    return reply(res, executed.status, executed.result || { error: executed.error });
  }
  if (!['publish', 'restore', 'archive'].includes(action)) return reply(res, 404, { error: '未找到操作' });
  const params = await bodyOf(req);
  const expected = expectedRevision(req, params);
  if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
  const result = await mutateAssets(kind, async assets => {
    const item = assets.find(asset => asset.id === id && !asset.archived);
    if (!item) return { status: 404, error: '资产不存在' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    if (action === 'archive') {
      item.archived = true;
      advanceAssetRevision(item, 'saved');
    }
    else if (action === 'restore') {
      const version = item.versions.find(entry => entry.number === params.version);
      if (!version) return { status: 404, error: '版本不存在' };
      item.draft = structuredClone(version.draft);
      advanceAssetRevision(item, 'restored', true);
    } else if (isTable) {
      const v = validateTable(item.draft, currentBom);
      if (v.error) return { status: 400, error: v.error };
      const drl = tableDrl(item.draft, currentBom, item.id);
      const checked = await engine('/compile', { drl });
      if (checked.error) return { status: checked.status, error: checked.error };
      const version = {
        number: (item.versions.at(-1)?.number || 0) + 1,
        createdAt: new Date().toISOString(),
        draft: structuredClone(item.draft),
        bomVersion: currentBom.version,
        bom: structuredClone(currentBom),
        drl,
        engineVersion: checked.result.version,
      };
      item.versions.push(version);
      item.published = structuredClone(item.draft);
      advanceAssetRevision(item, 'saved');
    } else {
      const rules = await readRules();
      const tables = await readAssets('tables');
      let snapshot;
      try {
        const packageRecords = await readPackageRecords('default', { rules, tables });
        snapshot = flowSnapshot(item.draft, rules, tables, currentBom, packageRecords);
      }
      catch (error) { return { status: 400, error: error.message }; }
      const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
      for (const step of steps) {
        const checked = await engine('/compile', { drl: step.drl });
        if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
      }
      item.versions.push({
        number: (item.versions.at(-1)?.number || 0) + 1,
        createdAt: new Date().toISOString(),
        draft: structuredClone(item.draft),
        bomVersion: currentBom.version,
        bom: structuredClone(currentBom),
        snapshot,
      });
      item.published = snapshot;
      advanceAssetRevision(item, 'saved');
    }
    return { item };
  });
  if (result.error) return reply(res, result.status, operationError(result));
  const actionLabels = { publish: '发布', restore: '恢复', archive: '归档' };
  await appendAuditEvent(`asset.${action}`, isTable ? 'table' : 'flow', id,
    `${actionLabels[action]}${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`,
    { revision: result.item.revision, version: result.item.versions.at(-1)?.number || null }, req);
  return reply(res, 200, result.item);
}

function assetBomIssue(draft, type, bom) {
  const invalidCondition = draft.conditions?.find(column => {
    if (column.raw || column.pattern) return false;
    const field = findField(bom, column.field);
    return !field || field.kind !== 'input';
  });
  if (invalidCondition) return `条件字段 ${invalidCondition.field || '（空）'} 不存在或不是输入字段`;
  const invalidValueField = draft.conditions?.find(column => {
    if (column.raw || column.pattern || column.valueSource !== 'field') return false;
    const field = findField(bom, column.field);
    const valueField = findField(bom, column.valueField);
    return !field || !valueField || valueField.kind !== 'input' || valueField.key === field.key
      || inferSemanticType(valueField) !== inferSemanticType(field);
  });
  if (invalidValueField) return `比较字段 ${invalidValueField.valueField || '（空）'} 不存在、不是输入字段或类型不匹配`;
  const invalidAction = draft.actions?.find(column => {
    const field = findField(bom, column.field);
    return !field || field.kind !== 'output';
  });
  if (invalidAction) return `动作字段 ${invalidAction.field || '（空）'} 不存在或不是输出字段`;
  if (type === 'table' && (!Array.isArray(draft.conditions) || !Array.isArray(draft.actions))) return '决策表列定义无效';
  return null;
}

function assetWorkflowStatus(item, changeSets) {
  for (const changeSet of changeSets) {
    const pinned = changeSet.items?.find(entry => entry.assetId === item.id);
    if (!pinned) continue;
    if (changeSet.status === 'SUBMITTED') return 'in-review';
    if (changeSet.status === 'REJECTED' && pinned.assetRevision === (item.revision || 1)) return 'rejected';
  }
  const publishedRevision = item.versions.at(-1)?.assetRevision;
  return item.published && (publishedRevision == null || publishedRevision === (item.revision || 1)) ? 'published' : 'draft';
}

function submittedChangeSetForAsset(changeSets, assetId) {
  return changeSets.find(changeSet => changeSet.status === 'SUBMITTED'
    && changeSet.items?.some(entry => entry.assetId === assetId));
}

function reviewLock(changeSets, assetId) {
  const changeSet = submittedChangeSetForAsset(changeSets, assetId);
  return changeSet ? {
    status: 409,
    error: `资产正在变更集“${changeSet.name}”中审核，审核完成后才能修改`,
    changeSetId: changeSet.id,
  } : null;
}

function projectAssetSummaryWithReview(item, type, bom = currentBom, changeSets = []) {
  const bomIssue = assetBomIssue(item.draft, type, bom);
  return {
    id: item.id,
    name: item.draft.name,
    type: type === 'table' ? 'decision-table' : 'rule',
    modifiedBy: 'Team Server',
    status: assetWorkflowStatus(item, changeSets),
    version: String(item.versions.at(-1)?.number || item.revision || 1),
    priority: item.draft.priority ?? 0,
    bomInvalid: Boolean(bomIssue),
    bomIssue: bomIssue || undefined,
  };
}

async function projectData(projectId = 'default') {
  const [rules, tables, flows, eventStreams, releases, bom, changeSets, testSuites] = await Promise.all([
    readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId), readAssets('eventStreams', projectId), readReleases(projectId), readBom(projectId), readChangeSets(projectId), readAssets('testSuites', projectId),
  ]);
  return {
    rules: rules.filter(item => !item.archived),
    tables: tables.filter(item => !item.archived),
    flows: flows.filter(item => !item.archived),
    eventStreams: eventStreams.filter(item => !item.archived),
    releases, bom, changeSets, testSuites: testSuites.filter(item => !item.archived),
  };
}

function projectSummary(project, { rules, tables, flows, eventStreams = [], releases }, packages = []) {
  const assets = normalizeProjectEngine(project.engine) === 'cep' ? eventStreams : [...rules, ...tables];
  const categories = new Set(assets.map(item => item.draft.category || '未分类'));
  const latestRelease = releases.reduce((latest, release) => Math.max(latest, Number(release.version) || 0), 0);
  const environments = new Set(releases.flatMap(release => (release.deployments || []).map(deployment => deployment.environment)));
  const updatedAt = [...assets, ...flows].map(item => item.updatedAt).filter(Boolean).sort().at(-1) || new Date(0).toISOString();
  return {
    ...project,
    packageCount: packages.length || categories.size,
    assetCount: assets.length,
    version: `v${latestRelease || 1}.0.0`,
    environmentCount: environments.size,
    updatedAt: updatedAt === new Date(0).toISOString() ? project.updatedAt : updatedAt,
    source: 'server',
  };
}

function projectPackages(rules, tables, packageRecords = [], bom = currentBom, changeSets = []) {
  const packages = new Map(packageRecords.map(pkg => [pkg.name, { id: pkg.name, name: pkg.name, label: pkg.label, parentId: pkg.parentId || null, assets: [] }]));
  for (const [items, type] of [[rules, 'rule'], [tables, 'table']]) {
    for (const item of items) {
      const category = item.draft.category || '未分类';
      if (!packages.has(category)) packages.set(category, { id: category, name: category, label: category, assets: [] });
      packages.get(category).assets.push(projectAssetSummaryWithReview(item, type, bom, changeSets));
    }
  }
  return [...packages.values()];
}

function visibleProjectPackages(principal, rules, tables, packageRecords = [], bom = currentBom, changeSets = []) {
  return projectPackages(rules, tables, packageRecords, bom, changeSets)
    .map(pkg => ({ ...pkg, assets: pkg.assets.filter(asset => canAccessAsset(principal, asset.id)) }));
}

function projectAssetDetail(item, type, bom = currentBom, changeSets = []) {
  const summary = projectAssetSummaryWithReview(item, type, bom, changeSets);
  const draft = item.draft;
  const reviewedAt = item.published ? item.versions.at(-1)?.createdAt || item.updatedAt : '尚未审核';
  const tableHitPolicy = draft.hitPolicy === 'FIRST' ? 'FIRST' : draft.hitPolicy === 'PRIORITY' ? 'PRIORITY' : 'COLLECT';
  const detail = {
    ...summary,
    packageId: draft.category || '未分类',
    packageName: draft.category || '未分类',
    updatedAt: item.updatedAt,
    revision: item.revision || 1,
    // 产物信息：已发布版本号，以及该版本冻结的 BOM 版本。
    // 依赖 BOM 的资产在 BOM 升版后必须重新发布（flowSnapshot 会拒绝旧 BOM 的产物），
    // 调用方需要能读到这个值来判断是否需要重发。
    versions: (item.versions || []).map(version => ({
      number: version.number,
      createdAt: version.createdAt,
      bomVersion: version.bomVersion ?? null,
      engineVersion: version.engineVersion ?? null,
    })),
    publishedBomVersion: item.versions?.at(-1)?.bomVersion ?? null,
    draft: structuredClone(draft),
    attributes: {
      priority: draft.priority || 0,
      hitPolicy: type === 'table' ? tableHitPolicy : 'FIRST',
      effectiveDate: '始终',
      createdBy: 'Team Server',
      reviewedAt,
    },
  };
  if (type === 'rule') {
    try { detail.content = generateDrl([draft], bom); }
    catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
    return detail;
  }
  const validation = validateTable(draft, bom);
  detail.validationWarnings = validation.warnings;
  try { detail.content = tableDrl(draft, bom, item.id); }
  catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
  const conditionColumns = draft.conditions.map((column, index) => ({
    id: `condition-${index}`,
    label: findField(bom, column.field)?.label || column.field,
    kind: 'condition',
  }));
  const actionColumns = draft.actions.map((column, index) => ({
    id: `action-${index}`,
    label: findField(bom, column.field)?.label || column.field,
    kind: 'action',
  }));
  detail.decisionTable = {
    hitPolicy: tableHitPolicy,
    columns: [...conditionColumns, ...actionColumns],
    rows: draft.rows.map(row => Object.fromEntries([
      ...conditionColumns.map((column, index) => [column.id, row.conditions[index] || '任意']),
      ...actionColumns.map((column, index) => [column.id, row.actions[index] || '']),
    ])),
  };
  return detail;
}

function projectBomModel({ rules, tables, flows }, bom = currentBom) {
  const references = new Map(bom.fields.map(field => [field.key, 0]));
  const count = key => {
    if (references.has(key)) references.set(key, references.get(key) + 1);
  };
  const scanRule = rule => {
    for (const condition of rule?.conditions || []) {
      if (!condition.pattern && !condition.raw) {
        count(condition.field);
        if (condition.valueSource === 'field') count(condition.valueField);
      }
    }
    for (const action of rule?.actions || []) count(action.field);
  };
  const scanTable = table => {
    for (const condition of table?.conditions || []) count(condition.field);
    for (const action of table?.actions || []) count(action.field);
  };
  const scanFlowSteps = steps => {
    for (const step of steps || []) {
      for (const mapping of step.inputMappings || []) { count(mapping.source); count(mapping.target); }
      for (const mapping of step.outputMappings || []) { count(mapping.source); count(mapping.target); }
    }
  };
  const scanFlow = flow => {
    scanFlowSteps(flow?.steps);
    for (const branch of flow?.branches || []) {
      if (!branch.default) count(branch.condition?.field);
      scanFlowSteps(branch.steps);
    }
  };
  for (const item of rules) scanRule(item.draft);
  for (const item of tables) scanTable(item.draft);
  for (const item of flows) scanFlow(item.draft);

  const fields = bom.fields.map(field => ({
    key: field.key,
    label: field.label,
    type: inferSemanticType(field),
    runtimeType: field.type,
    direction: field.kind,
    references: references.get(field.key) || 0,
    enum: field.enum || null,
    unit: field.unit || null,
    min: field.min ?? null,
    max: field.max ?? null,
    control: field.control || null,
    factType: field.factType || null,
    factTypeLabel: field.factTypeLabel || null,
  }));
  const facts = new Map();
  for (const field of fields) {
    const name = field.factType || 'RuleInput';
    const fact = facts.get(name) || { name, label: field.factTypeLabel || (name === 'RuleInput' ? '规则输入与决策结果' : name), direction: field.direction, fields: [] };
    fact.fields.push({ ...field, factName: name, factLabel: fact.label });
    if (fact.direction !== field.direction) fact.direction = 'mixed';
    facts.set(name, fact);
  }
  const factTypes = [...facts.values()];
  return {
    version: bom.version,
    updatedAt: bom.updatedAt,
    updatedBy: 'Team Server',
    eventTypes: bom.eventTypes || [],
    factTypes,
    vocabulary: fields.map(field => ({
      property: `${field.factType || 'RuleInput'}.${field.key}`,
      label: field.label,
      type: field.type,
      references: field.references,
    })),
    relationships: factTypes.map(fact => `调用请求 1 -> 1 ${fact.label}`),
    drl: bom.fields.length ? generateDrl([], bom) : '// 空白 BOM：请先创建输入和输出事实类型',
  };
}

function projectTestSuite(suite, { rules, tables, flows, eventStreams = [] }) {
  const collections = { rule: rules, table: tables, flow: flows, 'event-stream': eventStreams };
  const target = collections[suite.target.type]?.find(item => item.id === suite.target.id);
  return {
    ...suite,
    targetName: target?.draft?.name || suite.target.id,
    targetVersions: (target?.versions || []).map(version => version.number),
  };
}

function projectFlowAssets({ rules, tables }) {
  return [
    ...rules.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'rule', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      outputFields: [...new Set((item.published.actions || []).map(action => action.field))],
    })),
    ...tables.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'table', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      outputFields: [...new Set((item.published.actions || []).map(action => action.field))],
    })),
  ];
}

function allFlowSteps(flow) {
  return [...(flow?.steps || []), ...(flow?.branches || []).flatMap(branch => branch.steps || [])];
}

function flowPackageSelectors(flow) {
  return allFlowSteps(flow).filter(step => step.type === 'rule-group' && step.selector?.packageName).map(step => step.selector);
}

function flowReferencesPackage(flow, packageName) {
  return flowPackageSelectors(flow).some(selector => selector.packageName === packageName || selector.packageName.startsWith(`${packageName}.`));
}

function projectFlowPackages(data) {
  const records = data.packageRecords || [];
  const names = new Set([
    ...records.map(pkg => pkg.name),
    ...data.rules.map(item => canonicalPackageName(item.draft.category)),
    ...data.tables.map(item => canonicalPackageName(item.draft.category)),
  ].filter(Boolean));
  return [...names].sort().map(name => {
    const record = records.find(pkg => pkg.name === name);
    const directRules = data.rules.filter(item => canonicalPackageName(item.draft.category) === name);
    const directTables = data.tables.filter(item => canonicalPackageName(item.draft.category) === name);
    const publishedRules = directRules.filter(item => item.published && !item.archived);
    const publishedTables = directTables.filter(item => item.published && !item.archived);
    const members = [
      ...publishedRules.map(item => ({ id: item.id, name: item.published.name, type: 'rule', version: item.versions.at(-1)?.number || 0 })),
      ...publishedTables.map(item => ({ id: item.id, name: item.published.name, type: 'table', version: item.versions.at(-1)?.number || 0 })),
    ];
    return {
      name,
      label: record?.label || packageLabel(name),
      parentId: record?.parentId || null,
      publishedRuleCount: publishedRules.length,
      publishedTableCount: publishedTables.length,
      excludedDraftCount: directRules.length + directTables.length - members.length,
      outputFields: [...new Set([
        ...publishedRules.flatMap(item => (item.published.actions || []).map(action => action.field)),
        ...publishedTables.flatMap(item => (item.published.actions || []).map(action => action.field)),
      ])],
      members,
    };
  });
}

function projectRuleset(item, data) {
  const assetMap = new Map(projectFlowAssets(data).map(asset => [asset.id, asset]));
  const source = item.published && typeof item.published === 'object' ? item.published : (item.draft || {});
  const steps = [
    ...(source.steps || []),
    ...(source.branches || []).flatMap(branch => branch.steps || []),
  ];
  const packages = [...new Set(steps.map(step => step.type === 'rule-group' ? step.packageName || step.selector?.packageName : assetMap.get(step.id)?.category).filter(Boolean))];
  const outdatedDependencies = steps.flatMap(step => {
    if (step.type === 'rule-group') {
      if (!step.memberFingerprint) return [];
      try {
        const selector = step.selector || { packageName: step.packageName, includeChildren: step.includeChildren === true };
        if (source.bomVersion != null && source.bomVersion !== data.bom.version) return [{
          kind: 'rule-group', nodeId: step.nodeId, packageName: selector.packageName, reason: 'bom-changed',
        }];
        const members = resolveRuleGroupMembers(selector, data.rules, data.tables, data.packageRecords || []);
        return ruleGroupFingerprint(members) === step.memberFingerprint ? [] : [{
          kind: 'rule-group', nodeId: step.nodeId, packageName: selector.packageName, reason: 'members-changed',
        }];
      } catch {
        return [{ kind: 'rule-group', nodeId: step.nodeId, packageName: step.packageName || step.selector?.packageName, reason: 'members-changed' }];
      }
    }
    const current = assetMap.get(step.id);
    return current && step.version && step.version < current.version
      ? [{ id: step.id, name: step.name || current.name, publishedVersion: step.version, latestVersion: current.version }]
      : [];
  }).filter((dependency, index, all) => all.findIndex(item => (item.kind || 'asset') === (dependency.kind || 'asset') && (item.id || item.nodeId) === (dependency.id || dependency.nodeId)) === index);
  const flowSteps = [
    ...(source.steps || []).map((step, index) => ({
      order: index + 1, type: step.type, id: step.id,
      name: step.name || assetMap.get(step.id)?.name || step.selector?.packageName || step.id,
      version: step.version || assetMap.get(step.id)?.version || 0, branchName: null,
    })),
    ...(source.branches || []).flatMap(branch => (branch.steps || []).map((step, index) => ({
      order: index + 1, type: step.type, id: step.id,
      name: step.name || assetMap.get(step.id)?.name || step.selector?.packageName || step.id,
      version: step.version || assetMap.get(step.id)?.version || 0, branchName: branch.name,
    }))),
  ];
  return {
    id: item.id,
    name: source.name || item.draft.name,
    flowId: item.id,
    flowName: source.name || item.draft.name,
    hitPolicy: 'COLLECT',
    maxFirings: 100,
    inputs: ['RuleInput'],
    outputs: ['RuleInput'],
    packages,
    branchCount: (source.branches || []).length,
    stepCount: flowSteps.length,
    steps: flowSteps,
    sequential: true,
    revision: item.revision || 1,
    status: assetWorkflowStatus(item, data.changeSets || []),
    version: item.versions.at(-1)?.number || 0,
    needsRepublish: outdatedDependencies.length > 0,
    outdatedDependencies,
    updatedAt: item.updatedAt,
  };
}

function projectFlowDetail(item, data) {
  return {
    ...projectRuleset(item, data),
    description: item.draft.description || '',
    category: item.draft.category || '未分类',
    draft: structuredClone(item.draft),
    availableAssets: projectFlowAssets(data),
    availablePackages: projectFlowPackages(data),
  };
}

function eventStreamStatus(item) {
  if (item.archived) return 'archived';
  return item.published ? 'published' : 'draft';
}

function projectEventStreamSummary(item) {
  const statementLabels = (item.draft.statements || []).flatMap(statement => [statement.label, statement.name, statement.description]).filter(Boolean);
  return {
    id: item.id,
    name: item.draft.name,
    description: item.draft.description || '',
    type: 'event-stream',
    status: eventStreamStatus(item),
    package: item.draft.category || 'default',
    version: item.versions.at(-1)?.number || 0,
    bomVersion: item.versions.at(-1)?.bomVersion || null,
    revision: item.revision || 1,
    statementCount: item.draft.statements?.length || 0,
    statementLabels,
    updatedAt: item.updatedAt,
    modifiedBy: item.updatedBy || 'Team Server',
  };
}

function projectEventStreamDetail(item, data) {
  const compiled = compileEventStreamDraft(item.draft, data.bom);
  return {
    ...projectEventStreamSummary(item),
    description: item.draft.description || '',
    draft: structuredClone(item.draft),
    published: item.published || null,
    versions: item.versions || [],
    schemas: compiled.result?.schemas || [],
    validationError: compiled.error || null,
  };
}

function eventStreamAuthoring(statements = []) {
  return statements.map(statement => ({
    name: statement.name,
    ...(statement.label ? { label: statement.label } : {}),
    ...(statement.description ? { description: statement.description } : {}),
    ...(statement.mode ? { mode: statement.mode } : {}),
    ...(statement.template ? { template: statement.template } : {}),
    ...(statement.params ? { params: structuredClone(statement.params) } : {}),
  }));
}

async function compileProjectEventStream(item, payload, data) {
  const expected = payload?.revision;
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  const conflict = revisionConflict(item, expected);
  if (conflict) return conflict;
  const compiled = compileEventStreamDraft(payload?.draft || item.draft, data.bom || currentBom);
  if (compiled.error) return compiled;
  const checked = await engine('/compile', { module: compiled.result.module }, data.project || 'cep');
  if (checked.error) return checked;
  return { status: 200, result: { ...compiled.result, engine: checked.result.engine || 'Esper', version: checked.result.version || compiled.result.version, epl: checked.result.epl } };
}

async function publishProjectEventStream(id, expected, projectId, data, createdBy = 'Team Server') {
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  return mutateAssets('eventStreams', async assets => {
    const item = assets.find(asset => asset.id === id && !asset.archived);
    if (!item) return { status: 404, error: '事件流不存在' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    const compiled = compileEventStreamDraft(item.draft, data.bom || currentBom);
    if (compiled.error) return compiled;
    const checked = await engine('/compile', { module: compiled.result.module }, data.project || 'cep');
    if (checked.error) return checked;
    const version = {
      number: (item.versions.at(-1)?.number || 0) + 1,
      assetRevision: (item.revision || 1) + 1,
      createdAt: new Date().toISOString(),
      draft: structuredClone(item.draft),
      statements: structuredClone(compiled.result.module.statements),
      authoring: eventStreamAuthoring(item.draft.statements || []),
      schemas: structuredClone(compiled.result.schemas),
      bomVersion: (data.bom || currentBom).version,
      bom: structuredClone(data.bom || currentBom),
      checksum: compiled.result.checksum,
      createdBy,
      engineVersion: checked.result.version || compiled.result.version,
      module: structuredClone(compiled.result.module),
    };
    item.versions.push(version);
    item.published = structuredClone(version);
    advanceAssetRevision(item, 'saved');
    return { item };
  }, projectId);
}

async function compileProjectFlow(item, payload, data) {
  const expected = payload?.revision;
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  const conflict = revisionConflict(item, expected);
  if (conflict) return conflict;
  let snapshot;
  try { snapshot = flowSnapshot(payload?.draft || item.draft, data.rules, data.tables, data.bom || currentBom, data.packageRecords || []); }
  catch (error) { return { status: 400, error: error.message }; }
  const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
  let engineVersion = null;
  for (const step of steps) {
    const checked = await engine('/compile', { drl: step.drl }, data.project);
    if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
    engineVersion = checked.result.version;
  }
  return {
    status: 200,
    result: {
      ok: true,
      engineVersion,
      stepCount: steps.length,
      branchCount: snapshot.branches.length,
      bomVersion: snapshot.bomVersion,
    },
  };
}

async function publishProjectFlow(id, expected, data, projectId = 'default') {
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  return mutateAssets('flows', async flows => {
    const item = flows.find(asset => asset.id === id && !asset.archived);
    if (!item) return { status: 404, error: '规则流不存在' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    let snapshot;
    try { snapshot = flowSnapshot(item.draft, data.rules, data.tables, data.bom || currentBom, data.packageRecords || []); }
    catch (error) { return { status: 400, error: error.message }; }
    const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
    let engineVersion = null;
    for (const step of steps) {
      const checked = await engine('/compile', { drl: step.drl }, data.project);
      if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
      engineVersion = checked.result.version;
    }
    item.versions.push({
      number: (item.versions.at(-1)?.number || 0) + 1,
      assetRevision: (item.revision || 1) + 1,
      createdAt: new Date().toISOString(),
      draft: structuredClone(item.draft),
      bomVersion: (data.bom || currentBom).version,
      bom: structuredClone(data.bom || currentBom),
      engineVersion,
      snapshot,
    });
    item.published = snapshot;
    advanceAssetRevision(item, 'saved');
    return { item };
  }, projectId);
}

async function saveProjectAsset(id, type, payload, projectId = 'default', bom = currentBom) {
  const expected = payload?.revision;
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  const draft = normalizePackageReferences(structuredClone(payload?.draft));
  const validation = type === 'rule' ? validateRule(draft, bom) : validateTable(draft, bom).error;
  if (validation) return { status: 400, error: validation };
  const operation = assets => {
    const item = assets.find(asset => asset.id === id && !asset.archived);
    if (!item) return { status: 404, error: '资产不存在' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    item.draft = structuredClone(draft);
    advanceAssetRevision(item, 'saved', true);
    return { item };
  };
  return type === 'rule' ? mutate(operation, projectId) : mutateAssets('tables', operation, projectId);
}

async function compileProjectAsset(item, type, payload, bom = currentBom, projectOrEngine = 'rules') {
  const expected = payload?.revision;
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  const conflict = revisionConflict(item, expected);
  if (conflict) return conflict;
  const draft = normalizePackageReferences(structuredClone(payload?.draft || item.draft));
  const validation = type === 'rule' ? validateRule(draft, bom) : validateTable(draft, bom).error;
  if (validation) return { status: 400, error: validation };
  const drl = type === 'rule' ? generateDrl([draft], bom) : tableDrl(draft, bom, item.id);
  const checked = await engine('/compile', { drl }, projectOrEngine);
  if (checked.error) return { status: checked.status, error: checked.error };
  return { status: 200, result: { ok: true, engineVersion: checked.result.version, drl } };
}

async function publishProjectAsset(id, type, expected, projectId = 'default', bom = currentBom, projectOrEngine = 'rules') {
  if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
  const operation = async assets => {
    const item = assets.find(asset => asset.id === id && !asset.archived);
    if (!item) return { status: 404, error: '资产不存在' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    const validation = type === 'rule' ? validateRule(item.draft, bom) : validateTable(item.draft, bom).error;
    if (validation) return { status: 400, error: validation };
    const drl = type === 'rule' ? generateDrl([item.draft], bom) : tableDrl(item.draft, bom, item.id);
    const checked = await engine('/compile', { drl }, projectOrEngine);
    if (checked.error) return { status: checked.status, error: checked.error };
    const version = {
      number: (item.versions.at(-1)?.number || 0) + 1,
      assetRevision: (item.revision || 1) + 1,
      createdAt: new Date().toISOString(),
      ...(type === 'rule' ? { rule: structuredClone(item.draft) } : { draft: structuredClone(item.draft) }),
      bomVersion: bom.version,
      bom: structuredClone(bom),
      drl,
      engineVersion: checked.result.version,
    };
    item.versions.push(version);
    item.published = structuredClone(item.draft);
    advanceAssetRevision(item, 'saved');
    return { item };
  };
  return type === 'rule' ? mutate(operation, projectId) : mutateAssets('tables', operation, projectId);
}

async function handleProjects(req, res, segments, url) {
  if (segments.length === 2 && req.method === 'POST') {
    const result = await createProjectRecord(await bodyOf(req), actorOf(req));
    if (result.error) return reply(res, result.status, { error: result.error });
    await appendAuditEvent('project.created', 'project', result.item.id, `创建项目：${result.item.name}`, {}, req);
    return reply(res, 201, result.item);
  }
  if (segments.length === 2 && req.method === 'GET') {
    const includeArchived = url.searchParams.get('archived') === 'true';
    const records = (await readProjectRecords(includeArchived)).filter(project => canAccessProject(req.principal, project));
    const summaries = await Promise.all(records.map(async project => {
      if (postgresStore && project.assetCount != null) return { ...project, source: 'server' };
      const data = await projectData(project.id);
      const packages = await readPackageRecords(project.id, data);
      return projectSummary(project, data, packages);
    }));
    return reply(res, 200, summaries);
  }
  const projectId = segments[2];
  const projects = await readProjectRecords(true);
  const project = projects.find(item => item.id === projectId);
  if (!project) return reply(res, 404, { error: '项目不存在' });
  authorizeProject(req.principal, project);
  if (segments.length === 3 && req.method === 'PUT') {
    const payload = await bodyOf(req);
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
    if (!name || name.length > 80 || description.length > 500) return reply(res, 400, { error: '项目名称或描述无效' });
    if (payload?.engine != null && payload.engine !== normalizeProjectEngine(project.engine)) return reply(res, 400, { error: '项目引擎创建后不可修改' });
    const updates = { ...project, name, description, icon: ['loan', 'warehouse', 'shield'].includes(payload.icon) ? payload.icon : project.icon, defaultEnvironment: payload.defaultEnvironment || project.defaultEnvironment || 'local', updatedAt: new Date().toISOString(), updatedBy: actorOf(req) };
    const saved = postgresStore ? await postgresStore.updateProject(projectId, updates) : (await writeProjectRecords(projects.map(item => item.id === projectId ? updates : item)), updates);
    return reply(res, 200, { ...saved, source: 'server' });
  }
  if (segments.length === 4 && segments[3] === 'archive' && req.method === 'POST') {
    const saved = postgresStore ? await postgresStore.archiveProject(projectId) : (await writeProjectRecords(projects.map(item => item.id === projectId ? { ...item, archived: true, updatedAt: new Date().toISOString() } : item)), { ...project, archived: true });
    return reply(res, 200, { ...saved, source: 'server' });
  }
  if (segments.length === 3 && req.method === 'DELETE') {
    if (projectId === 'default') return reply(res, 400, { error: '默认项目不能删除' });
    const data = await projectData(projectId);
    const production = data.releases.some(release => (release.deployments || []).some(deployment => deployment.environment === 'production'));
    if (production) return reply(res, 409, { error: '项目已发布到 production，只能归档' });
    if (postgresStore) {
      const result = await postgresStore.deleteProject(projectId);
      if (result.blocked) return reply(res, 409, { error: '项目已发布到 production，只能归档' });
    } else {
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
    return reply(res, 204, '');
  }
  if (segments[3] === 'change-sets') {
    return handleChangeSets(req, res, ['api', 'change-sets', ...segments.slice(4)], projectId, true);
  }
  if (segments.length === 4 && segments[3] === 'audit-events' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const events = postgresStore
      ? await postgresStore.listAuditEvents(limit, projectId)
      : (await readAuditEvents(projectId)).slice(0, limit);
    return reply(res, 200, events);
  }
  const data = await projectData(projectId);
  data.project = project;
  let packageRecords = await readPackageRecords(projectId, data);
  data.packageRecords = packageRecords;
  const projectEngine = normalizeProjectEngine(project.engine);
  if (projectEngine === 'cep' && ['rules', 'tables', 'flows', 'rulesets'].includes(segments[3])) {
    const message = 'CEP 项目不支持规则资产、决策表或规则流';
    return reply(res, req.method === 'GET' ? 404 : 403, { error: message });
  }
  if (projectEngine === 'rules' && segments[3] === 'event-streams') {
    return reply(res, req.method === 'GET' ? 404 : 403, { error: '规则项目不支持事件流资产' });
  }
  if (segments.length === 4 && segments[3] === 'report' && req.method === 'GET') {
    const packages = visibleProjectPackages(req.principal, data.rules, data.tables, packageRecords, data.bom, data.changeSets);
    const html = renderProjectReport(project, data, packages, actorOf(req));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${project.name}-资产报告.html`)}` });
    return res.end(html);
  }
  if (segments.length === 3 && req.method === 'GET') return reply(res, 200, projectSummary(project, data, packageRecords));
  if (segments[3] === 'packages') {
    return handleProjectPackages(req, res, segments, projectId, data, packageRecords);
  }
  if (segments.length === 4 && segments[3] === 'bom' && req.method === 'GET') return reply(res, 200, projectBomModel(data, data.bom));
  if (segments.length === 4 && segments[3] === 'bom' && req.method === 'PUT') return updateProjectBom(req, res, projectId, data.bom);
  if (segments.length === 5 && segments[3] === 'bom' && segments[4] === 'references' && req.method === 'GET') {
    const fieldKey = url.searchParams.get('field');
    if (!fieldKey) return reply(res, 400, { error: '缺少字段 key' });
    return reply(res, 200, await bomFieldReferences(fieldKey, projectId));
  }
  if (segments[3] === 'event-streams') {
    return handleProjectEventStreams(req, res, segments, projectId, data);
  }
  if (segments[3] === 'rulesets' || segments[3] === 'flows') {
    return handleProjectFlows(req, res, segments, projectId, data, packageRecords);
  }
  if (segments[3] === 'tests' || segments[3] === 'test-suites') {
    return handleTestSuites(req, res, ['api', 'test-suites', ...segments.slice(4)], projectId, data);
  }
  if (segments.length === 4 && segments[3] === 'releases') {
    return handleReleases(req, res, ['api', 'releases'], projectId);
  }
  if (segments.length === 6 && segments[3] === 'releases' && ['deploy', 'execute', 'events', 'webhook'].includes(segments[5])) {
    return handleReleases(req, res, ['api', 'releases', segments[4], segments[5]], projectId);
  }
  if (segments[3] === 'rules') {
    return handleProjectRules(req, res, segments, url, projectId, data, packageRecords);
  }
  return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
}

export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api') return reply(res, 404, { error: '未找到资源' });
    if (segments[1] === 'auth') {
      const handled = await handleAuthRequest(req, res, url);
      if (!handled) return reply(res, 404, { error: '未找到资源' });
      if (handled.location) { res.statusCode = handled.status; res.setHeader('location', handled.location); return res.end(); }
      return reply(res, handled.status, handled.body ?? '');
    }
    req.principal = await authenticateRequest(req);
    authorizeRequest(req.principal, req, url);
    if (req.method === 'GET' && url.pathname === '/api/session') return reply(res, 200, publicPrincipal(req.principal));
    if (req.method === 'GET' && url.pathname === '/api/system/storage') return reply(res, 200, {
      mode: postgresStore ? 'postgresql' : 'json', optimisticLocking: true, authMode: req.principal.mode,
    });
    if (req.method === 'GET' && url.pathname === '/api/activity') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
      return reply(res, 200, await recentActivity(req.principal, limit));
    }
    if (postgresStore) currentBom = await readBom();
    if (segments[1] === 'admin') return handleAdmin(req, res, segments);
    if (segments[1] === 'projects') return await handleProjects(req, res, segments, url);
    if (segments[1] === 'change-sets') return handleChangeSets(req, res, segments);
    if (req.method === 'GET' && segments[1] === 'audit-events' && segments.length === 2) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
      const events = postgresStore ? await postgresStore.listAuditEvents(limit) : (await readAuditEvents()).slice(0, limit);
      return reply(res, 200, events);
    }
    if (segments[1] === 'bom') return handleBom(req, res, segments, url);
    if (segments[1] === 'test-suites') return handleTestSuites(req, res, segments);
    if (segments[1] === 'releases') return handleReleases(req, res, segments);
    if (['tables', 'flows'].includes(segments[1])) return handleAsset(req, res, segments);
    if (req.method === 'GET' && url.pathname === '/api/rules') return reply(res, 200, await readRules());
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const rules = (await readRules()).filter(r => !r.archived && r.published).map(r => r.published);
      const tables = (await readAssets('tables')).filter(asset => !asset.archived && asset.published).flatMap(asset => tableRules(asset.published, currentBom, asset.id));
      const drl = generateDrl([...rules, ...tables], currentBom);
      res.setHeader('content-disposition', 'attachment; filename="published-rules.drl"');
      return reply(res, 200, drl, 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const item = await mutate(rules => {
        const now = new Date().toISOString();
        const created = initializeAssetRevision({ id: crypto.randomUUID(), draft: newRule(), published: null, versions: [], archived: false, updatedAt: now });
        rules.unshift(created);
        return created;
      });
      await appendAuditEvent('asset.created', 'rule', item.id, `创建规则：${item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, item);
    }
    if (segments.length === 3 && segments[1] === 'rules') {
      const id = segments[2];
      if (req.method === 'PUT') {
        const payload = await bodyOf(req);
        const expected = expectedRevision(req, payload);
        if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
        const draft = normalizePackageReferences(structuredClone(payload?.draft && payload.revision != null ? payload.draft : payload));
        const error = validateRule(draft, currentBom);
        if (error) return reply(res, 400, { error });
        const item = await mutate(rules => {
          const found = rules.find(r => r.id === id && !r.archived);
          if (!found) return null;
          const conflict = revisionConflict(found, expected);
          if (conflict) return conflict;
          found.draft = draft;
          advanceAssetRevision(found, 'saved', true);
          return { item: found };
        });
        if (!item) return reply(res, 404, { error: '规则不存在' });
        if (item.error) return reply(res, item.status, operationError(item));
        await appendAuditEvent('asset.saved', 'rule', id, `保存规则：${item.item.draft.name}`, { revision: item.item.revision }, req);
        return reply(res, 200, item.item);
      }
    }
    if (segments.length === 4 && segments[1] === 'rules' && segments[3] === 'test' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const current = (await readRules()).find(r => r.id === segments[2] && !r.archived);
      if (!current) return reply(res, 404, { error: '规则不存在' });
      const rule = payload.rule || current.draft;
      const error = validateRule(rule, currentBom);
      if (error) return reply(res, 400, { error });
      const facts = parseFacts(payload.facts);
      if (!facts) return reply(res, 400, { error: '测试输入字段或类型无效' });
      const checked = await engine('/test', { drl: generateDrl([rule], currentBom), facts });
      return reply(res, checked.status || 200, checked.result || { error: checked.error });
    }
    if (segments.length === 4 && segments[1] === 'rules' && req.method === 'POST') {
      const [,, id, action] = segments;
      if (!['publish', 'restore', 'archive'].includes(action)) return reply(res, 404, { error: '未找到操作' });
      const params = await bodyOf(req);
      const expected = expectedRevision(req, params);
      if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
      const result = await mutate(async rules => {
        const found = rules.find(r => r.id === id && !r.archived);
        if (!found) return { error: '规则不存在', status: 404 };
        const conflict = revisionConflict(found, expected);
        if (conflict) return conflict;
        if (action === 'archive') { found.archived = true; advanceAssetRevision(found, 'saved'); return { item: found }; }
        if (action === 'restore') {
          const version = found.versions.find(v => v.number === params.version);
          if (!version) return { error: '版本不存在', status: 404 };
          found.draft = structuredClone(version.rule);
          advanceAssetRevision(found, 'restored', true);
        } else {
          const error = validateRule(found.draft, currentBom);
          if (error) return { error, status: 400 };
          const drl = generateDrl([found.draft], currentBom);
          const checked = await engine('/compile', { drl });
          if (checked.error) return { error: checked.error, status: checked.status };
          // Publishing uses the persisted draft, never unsaved browser state.
          const version = {
            number: (found.versions.at(-1)?.number || 0) + 1,
            createdAt: new Date().toISOString(),
            rule: structuredClone(found.draft),
            bomVersion: currentBom.version,
            bom: structuredClone(currentBom),
            drl,
            engineVersion: checked.result.version,
          };
          found.versions.push(version);
          found.published = structuredClone(version.rule);
          advanceAssetRevision(found, 'saved');
        }
        return { item: found };
      });
      if (result.error) return reply(res, result.status, operationError(result));
      const actionLabels = { publish: '发布', restore: '恢复', archive: '归档' };
      await appendAuditEvent(`asset.${action}`, 'rule', id, `${actionLabels[action]}规则：${result.item.draft.name}`, {
        revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
      }, req);
      return reply(res, 200, result.item);
    }
    return reply(res, 404, { error: '未找到资源' });
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) res.setHeader('www-authenticate', 'Bearer');
      return reply(res, error.status, { error: error.message });
    }
    if (error instanceof SyntaxError) return reply(res, 400, { error: 'JSON 格式无效' });
    if (error.message === '请求内容过大') return reply(res, 413, { error: error.message });
    if (error instanceof StorageConflictError) {
      const requestSegments = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
      const projectId = requestSegments[1] === 'projects' && requestSegments[2]
        ? decodeURIComponent(requestSegments[2])
        : 'default';
      const current = await currentConflictResource(error.resource, projectId).catch(() => null);
      return reply(res, 409, {
        error: error.message, currentRevision: error.currentRevision, ...(current ? { current } : {}),
      });
    }
    console.error(error);
    return reply(res, 500, { error: '服务器处理失败' });
  }
}

export async function initializeStorage() {
  if (process.env.DATABASE_URL) {
    postgresStore = new PostgresStore(process.env.DATABASE_URL);
    await postgresStore.initialize();
  }
  currentBom = await readBom();
  return { mode: postgresStore ? 'postgresql' : 'json', bom: currentBom };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initializeStorage().then(({ mode, bom }) => {
    http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`Rules API: http://127.0.0.1:${port} (${mode}, BOM v${bom.version}, ${bom.fields.length} fields)`));
  }).catch(error => {
    console.error(`Rules API startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
