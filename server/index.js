import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBom, inputFields } from '../shared/bom.js';
import { renderProjectReport } from '../shared/report.js';
import { PostgresStore, StorageConflictError } from './postgres-store.js';
import { AuthError, authenticateRequest, authorizeRequest, publicPrincipal, handleAuthRequest, authorizeProject, authorizeAsset, canAccessProject, canAccessAsset } from './auth.js';
import { reply } from './http-utils.js';
import { advanceAssetRevision, initializeAssetRevision } from './domain-utils.js';
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
import { createProjectHandlers } from './routes/projects.js';
import { flowPackageSelectors, flowReferencesPackage, projectAssetDetail, projectBomModel, projectEventStreamDetail, projectEventStreamSummary, projectFlowDetail, projectPackages, projectRuleset, projectTestSuite } from './project-presenters.js';
import { createProjectBuildService } from './project-build-service.js';
import { createProjectRecordFactory, normalizeProjectEngine } from './project-factory.js';
import { createStorageService } from './storage-service.js';
import { createMutationService } from './mutation-service.js';
import { createProjectQueryService } from './project-query-service.js';
import { createTestExecutionService } from './test-execution-service.js';
import { createLegacyApiHandler } from './routes/legacy-api.js';

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

function actorOf(req) {
  if (req?.principal?.id) return req.principal.id;
  const actorHeader = req?.headers?.['x-actor'];
  return typeof actorHeader === 'string' && actorHeader.trim() ? actorHeader.trim().slice(0, 80) : 'local-user';
}

const {
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
  appendAuditEvent,
} = createStorageService({
  storage,
  dataDir,
  assetFiles,
  getPostgresStore: () => postgresStore,
  actorOf,
});

const {
  serializeReview,
  mutatePackageRecords,
  mutate,
  mutateAssets,
  mutateReleases,
  mutateTestSuites,
  mutateChangeSets,
} = createMutationService({
  readRules,
  writeRules,
  readAssets,
  writeAssets,
  readReleases,
  writeReleases,
  readPackageRecords,
  writePackageRecords,
  readChangeSets,
  writeChangeSets,
});

const { projectData, projectSummary, visibleProjectPackages } = createProjectQueryService({
  readRules,
  readAssets,
  readReleases,
  readBom,
  readChangeSets,
  normalizeProjectEngine,
  projectPackages,
  canAccessAsset,
  getCurrentBom: () => currentBom,
});

const {
  publishedTarget,
  executeFlow,
  executePublishedTarget,
  runTestSuite,
  recordSuiteRun,
  runAllTestSuites,
  runSingleTestSuite,
  runTestSuiteComparison,
  validateSuiteTarget,
} = createTestExecutionService({
  engine,
  readProjectRecord,
  readRules,
  readAssets,
  readBom,
  mutateTestSuites,
  appendAuditEvent,
  parseFacts,
  getCurrentBom: () => currentBom,
});

const handleLegacyApi = createLegacyApiHandler({
  engine,
  readRules,
  readAssets,
  readPackageRecords,
  mutate,
  mutateAssets,
  appendAuditEvent,
  parseFacts,
  executeFlow,
  getCurrentBom: () => currentBom,
});

const ASSET_ACTIVITY_TYPES = new Set(['rule', 'table', 'flow', 'event-stream']);

const createProjectRecord = createProjectRecordFactory({
  readProjectRecords,
  readBom,
  projectData,
  readPackageRecords,
  writeProjectRecords,
  writeBom,
  writePackageRecords,
  getPostgresStore: () => postgresStore,
});

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

const {
  compileProjectEventStream,
  publishProjectEventStream,
  compileProjectFlow,
  publishProjectFlow,
  saveProjectAsset,
  compileProjectAsset,
  publishProjectAsset,
} = createProjectBuildService({
  engine,
  mutate,
  mutateAssets,
  getCurrentBom: () => currentBom,
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

const {
  handleProjectCollection,
  handleProjectLifecycle,
  handleProjectAuditEvents,
  handleProjectReport,
  handleProjectSummary,
} = createProjectHandlers({
  createProjectRecord,
  actorOf,
  appendAuditEvent,
  readProjectRecords,
  canAccessProject,
  getPostgresStore: () => postgresStore,
  projectData,
  readPackageRecords,
  projectSummary,
  normalizeProjectEngine,
  writeProjectRecords,
  deleteProjectData,
  readAuditEvents,
  visibleProjectPackages,
  renderProjectReport,
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


async function handleProjects(req, res, segments, url) {
  if (segments.length === 2) return handleProjectCollection(req, res, url);
  const projectId = segments[2];
  const projects = await readProjectRecords(true);
  const project = projects.find(item => item.id === projectId);
  if (!project) return reply(res, 404, { error: '项目不存在' });
  authorizeProject(req.principal, project);
  const lifecycle = await handleProjectLifecycle(req, res, segments, projectId, project, projects);
  if (lifecycle !== null) return lifecycle;
  if (segments[3] === 'change-sets') {
    return handleChangeSets(req, res, ['api', 'change-sets', ...segments.slice(4)], projectId, true);
  }
  if (segments.length === 4 && segments[3] === 'audit-events' && req.method === 'GET') {
    return handleProjectAuditEvents(req, res, url, projectId);
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
    return handleProjectReport(req, res, project, data, packageRecords);
  }
  if (segments.length === 3 && req.method === 'GET') return handleProjectSummary(res, project, data, packageRecords);
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
    const legacy = await handleLegacyApi(req, res, segments, url);
    if (legacy !== null) return legacy;
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
