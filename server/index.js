import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { defaultBom } from '../shared/bom.js';
import { DomainError, domainErrorResult } from '../shared/errors.js';
import { renderProjectReport } from '../shared/report.js';
import { PostgresStore, StorageConflictError } from './postgres-store.js';
import { AuthError, authenticateRequest, authorizeRequest, publicPrincipal, handleAuthRequest, authorizeAsset, canAccessProject, canAccessAsset } from './auth.js';
import { operationError, reply } from './http-utils.js';
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
import { createProjectRouter } from './routes/project-router.js';
import { createGovernanceService } from './governance-service.js';
import { createActivityService } from './activity-service.js';
import { createServerConfig } from './config.js';
import { createFactParser } from './fact-parser.js';

const {
  storage,
  port,
  rulesBuildUrl,
  rulesResUrl,
  cepBuildUrl,
  cepResUrl,
  cepApiKey,
  dataDir,
  assetFiles,
} = createServerConfig();

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

const parseFacts = createFactParser({ getCurrentBom: () => currentBom });

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

const { currentConflictResource, submittedChangeSetForAsset, reviewLock } = createGovernanceService({
  getPostgresStore: () => postgresStore,
  readRules,
  readAssets,
  readChangeSets,
});

const { recentActivity } = createActivityService({
  readProjectRecords,
  canAccessProject,
  canAccessAsset,
  readAllAuditEvents,
  normalizeProjectEngine,
  getPostgresStore: () => postgresStore,
});

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

const handleProjects = createProjectRouter({
  handleProjectCollection,
  handleProjectLifecycle,
  handleProjectAuditEvents,
  handleProjectReport,
  handleProjectSummary,
  handleChangeSets,
  handleProjectPackages,
  handleProjectEventStreams,
  handleProjectFlows,
  handleTestSuites,
  handleReleases,
  handleProjectRules,
  readProjectRecords,
  projectData,
  readPackageRecords,
  normalizeProjectEngine,
  updateProjectBom,
  bomFieldReferences,
});

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
    if (segments[1] === 'services' && segments.length === 4 && segments[3] === 'execute') return handleReleases(req, res, segments);
    const legacy = await handleLegacyApi(req, res, segments, url);
    if (legacy !== null) return legacy;
    return reply(res, 404, { error: '未找到资源' });
  } catch (error) {
    if (error instanceof DomainError) {
      const result = domainErrorResult(error);
      return reply(res, result.status, operationError(result));
    }
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
