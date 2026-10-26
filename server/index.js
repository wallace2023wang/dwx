import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { defaultBom } from '../shared/bom.js';
import { DomainError, domainErrorResult } from '../shared/errors.js';
import { renderProjectReport } from '../shared/report.js';
import { PostgresStore, StorageConflictError } from './postgres-store.js';
import { AuthError, authenticateRequest, authorizeRequest, publicPrincipal, handleAuthRequest, authorizeAsset, canAccessProject, canAccessAsset } from './auth.js';
import { bodyOf, operationError, reply } from './http-utils.js';
import { advanceAssetRevision, initializeAssetRevision } from './domain-utils.js';
import { createAdminHandler } from './routes/admin.js';
import { createEngineClients } from './engine-client.js';
import { createBomHandlers } from './routes/bom.js';
import { createReleaseHandler } from './routes/releases.js';
import { createDeploymentHandler } from './routes/deployments.js';
import { createApplicationPackageHandler } from './routes/application-packages.js';
import { createActivationGenerationHandler, createTargetHandler } from './routes/targets.js';
import { createTestSuiteHandler } from './routes/test-suites.js';
import { createChangeSetHandler } from './routes/change-sets.js';
import { createProjectPackageHandler } from './routes/project-packages.js';
import { createProjectEventStreamHandler } from './routes/project-event-streams.js';
import { createProjectFlowHandler } from './routes/project-flows.js';
import { createProjectRuleHandler } from './routes/project-rules.js';
import { createProjectAssetHandler } from './routes/project-assets.js';
import { createProjectImportHandler } from './routes/project-imports.js';
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
import { createCollaborationService } from './collaboration-service.js';
import { canManageAssetDraft } from './asset-ownership.js';
import { migrateJsonDeploymentDomain } from './json-deployment-migration.js';
import { createDeploymentOperations } from './deployment-operations.js';
import { createActivationGenerationService } from './activation-generation-service.js';

const {
  storage,
  port,
  rulesBuildUrl,
  rulesResUrl,
  rulesResManagementUrl,
  rulesResManagementApiKey,
  rulesResExecutionApiKey,
  cepBuildUrl,
  cepResUrl,
  cepApiKey,
  dataDir,
  assetFiles,
} = createServerConfig();

const { engine, executionServer } = createEngineClients({
  rulesBuildUrl,
  rulesResUrl,
  rulesResManagementUrl,
  rulesResManagementApiKey,
  rulesResExecutionApiKey,
  cepBuildUrl,
  cepResUrl,
  cepApiKey,
});

// 当前生效的 BOM。启动时从 data/bom.json 加载，缺失则写入默认 BOM。
let currentBom = defaultBom();
let postgresStore = null;

const parseFacts = createFactParser({ getCurrentBom: () => currentBom });
const collaboration = createCollaborationService();
const PLATFORM_SCOPE = 'default';

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
  readApplicationPackages,
  writeApplicationPackages,
  readTargets,
  writeTargets,
  readActivationGenerations,
  writeActivationGenerations,
  readDeployments,
  writeDeployments,
  readEnvironments,
  writeEnvironments,
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
  mutateProjectAssets,
  mutateRuleProjectImport,
  mutateReleases,
  mutateDeployments,
  mutateApplicationPackages,
  mutateTargets,
  mutateActivationGenerations,
  mutateTestSuites,
  mutateChangeSets,
} = createMutationService({
  readRules,
  writeRules,
  readAssets,
  writeAssets,
  readReleases,
  writeReleases,
  readApplicationPackages,
  writeApplicationPackages,
  readTargets,
  writeTargets,
  readActivationGenerations,
  writeActivationGenerations,
  readDeployments,
  writeDeployments,
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
  readBom,
  collectUsedKeys,
  writeBom,
  appendAuditEvent,
});

const handleReleases = createReleaseHandler({
  readProjectRecord,
  readReleases,
  mutateReleases,
  readDeployments,
  mutateDeployments,
  readRules,
  readAssets,
  writeAssets,
  readBom,
  readPackageRecords,
  actorOf,
  appendAuditEvent,
  engine,
  executionServer,
  runTestSuite,
  recordSuiteRun,
  parseFacts,
});

const readPlatformTargets = () => readTargets(PLATFORM_SCOPE);
const mutatePlatformTargets = operation => mutateTargets(operation, PLATFORM_SCOPE);
const readPlatformEnvironments = () => readEnvironments(PLATFORM_SCOPE);
const readAllActivationGenerations = async () => (await Promise.all(
  (await readProjectRecords(true)).map(project => readActivationGenerations(project.id)),
)).flat();

const handleDeployments = createDeploymentHandler({ readDeployments, readEnvironments: readPlatformEnvironments });

const deploymentOperations = createDeploymentOperations({
  readDeployments,
  mutateDeployments,
  actorOf,
  executionServer,
});

const activationGenerationService = createActivationGenerationService({
  readTargets: readPlatformTargets,
  readActivationGenerations,
  mutateActivationGenerations,
  deploymentOperations,
  actorOf,
  rulesResManagementUrl,
  rulesResManagementApiKey,
  cepResUrl,
  cepApiKey,
});

const handleTargets = createTargetHandler({
  readTargets: readPlatformTargets,
  mutateTargets: mutatePlatformTargets,
  readActivationGenerations: readAllActivationGenerations,
  readEnvironments: readPlatformEnvironments,
  actorOf,
  appendAuditEvent,
  rulesResManagementUrl,
  rulesResManagementApiKey,
  cepResUrl,
  cepApiKey,
});

const handleActivationGenerations = createActivationGenerationHandler({ readActivationGenerations });

const handleApplicationPackages = createApplicationPackageHandler({
  readApplicationPackages,
  mutateApplicationPackages,
  readReleases,
  readDeployments,
  readEnvironments: readPlatformEnvironments,
  deploymentOperations,
  activationGenerationService,
  actorOf,
  appendAuditEvent,
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
  actorOf,
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

const handleProjectAssets = createProjectAssetHandler({
  authorizeAsset,
  mutateProjectAssets,
  appendAuditEvent,
  reviewLock,
  actorOf,
});

const handleProjectImports = createProjectImportHandler({
  mutateRuleProjectImport,
  initializeAssetRevision,
  appendAuditEvent,
  canAccessAsset,
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
  handleDeployments,
  handleApplicationPackages,
  handleTargets,
  handleActivationGenerations,
  handleProjectRules,
  handleProjectAssets,
  handleProjectImports,
  readProjectRecords,
  projectData,
  readPackageRecords,
  normalizeProjectEngine,
  updateProjectBom,
  bomFieldReferences,
  handleCollaboration: async (req, res, projectId, data, url, actionPath) => {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed' });
    if (req.method === 'GET' && actionPath !== 'events') return reply(res, 405, { error: 'Method not allowed' });
    if (req.method !== 'GET' && actionPath) return reply(res, 404, { error: '未找到资源' });
    const payload = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await bodyOf(req);
    const assetType = typeof payload?.assetType === 'string' ? payload.assetType : '';
    const assetId = typeof payload?.assetId === 'string' ? payload.assetId : '';
    const clientId = typeof payload?.clientId === 'string' ? payload.clientId.trim() : '';
    const mode = payload?.mode === 'editing' ? 'editing' : 'viewing';
    const revision = Number(payload?.revision);
    if (!['rule', 'table', 'flow', 'event-stream'].includes(assetType) || !assetId || !clientId || clientId.length > 120) {
      return reply(res, 400, { error: '协作会话参数无效' });
    }
    authorizeAsset(req.principal, assetId);
    const collections = {
      rule: data.allRules || data.rules,
      table: data.allTables || data.tables,
      flow: data.flows,
      'event-stream': data.allEventStreams || data.eventStreams,
    };
    const item = collections[assetType].find(asset => asset.id === assetId);
    if (!item) return reply(res, 404, { error: '协作资产不存在' });
    const input = {
      projectId, assetType, assetId, clientId, principal: req.principal, mode,
      revision: Number.isInteger(revision) && revision > 0 ? revision : null,
      currentRevision: item.revision || 1,
    };
    if (req.method === 'GET') {
      const documentId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const writeEvent = event => res.write(`event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`);
      writeEvent({
        type: 'snapshot',
        ...collaboration.snapshot(input),
        document: documentId ? collaboration.getDocument({ ...input, documentId }) : null,
      });
      const unsubscribe = collaboration.subscribe(input, writeEvent);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 10_000);
      req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
      return;
    }
    if (req.method === 'DELETE') return reply(res, 200, collaboration.leave(input));
    const action = typeof payload.action === 'string' ? payload.action : 'heartbeat';
    if (action === 'cursor') {
      const documentId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
      const selection = payload.selection;
      const positions = selection && ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'].map(key => Number(selection[key]));
      if (!documentId || documentId.length > 200 || !positions?.every(value => Number.isInteger(value) && value > 0)) {
        return reply(res, 400, { error: '协作光标参数无效' });
      }
      const result = collaboration.updateCursor({ ...input, documentId, selection: Object.fromEntries(['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'].map((key, index) => [key, positions[index]])) });
      return result ? reply(res, 200, result) : reply(res, 409, { error: '协作会话已过期，请重新连接' });
    }
    if (action === 'text') {
      if (assetType !== 'event-stream') return reply(res, 400, { error: '当前仅支持高级 EPL 实时共同编辑' });
      if (input.revision !== input.currentRevision) {
        return reply(res, 409, { error: `资产修订冲突：客户端 r${input.revision || '-'}，服务器最新 r${input.currentRevision}`, currentRevision: input.currentRevision });
      }
      if (!canManageAssetDraft(req.principal, item) || !(req.principal.permissions.includes('*') || (req.principal.permissions.includes('author') && req.principal.permissions.includes('advanced-epl')))) {
        return reply(res, 403, { error: '当前用户无权共同编辑高级 EPL' });
      }
      const documentId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
      const value = typeof payload.value === 'string' ? payload.value : null;
      const baseSequence = Number(payload.baseSequence);
      if (!/^statement:\d+:epl$/.test(documentId) || value == null || !Number.isInteger(baseSequence) || baseSequence < 0) {
        return reply(res, 400, { error: '协作文档参数无效' });
      }
      const result = collaboration.updateText({ ...input, documentId, baseSequence, value });
      return reply(res, result.status, result.status === 200 ? result.document : result);
    }
    if (action !== 'heartbeat') return reply(res, 400, { error: '不支持的协作动作' });
    const result = collaboration.heartbeat(input);
    return reply(res, 200, result);
  },
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
    if (segments[1] === 'admin' && segments[2] === 'environments' && segments.length === 3) {
      if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
      return reply(res, 200, await readPlatformEnvironments());
    }
    if (segments[1] === 'admin' && segments[2] === 'targets') {
      return handleTargets(req, res, ['api', 'projects', PLATFORM_SCOPE, 'targets', ...segments.slice(3)], PLATFORM_SCOPE, { engine: 'rules' });
    }
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
  } else {
    await migrateJsonDeploymentDomain({
      releasesFile: assetFiles.releases,
      deploymentsFile: assetFiles.deployments,
      environmentsFile: assetFiles.environments,
      targetsFile: assetFiles.targets,
    });
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
