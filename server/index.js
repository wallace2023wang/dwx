import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDrl, newRule, validateRule } from '../shared/rules.js';
import { applyFlowMappings, flowSnapshot, newFlow, newTable, selectFlowBranch, tableCollectedHits, tableDrl, tableExecutionTrace, tableRules, validateFlow, validateTable } from '../shared/assets.js';
import { defaultBom, inputFields, outputFields } from '../shared/bom.js';
import { evaluateCepTestCase, evaluateTestCase, expandTestCases, validateTestSuite } from '../shared/test-suites.js';
import { renderProjectReport } from '../shared/report.js';
import { validateEventPayloads } from '../shared/event-streams.js';
import { PostgresStore, StorageConflictError } from './postgres-store.js';
import { AuthError, authenticateRequest, authorizeRequest, publicPrincipal, handleAuthRequest, authorizeProject, authorizeAsset, canAccessProject, canAccessAsset } from './auth.js';
import { bodyOf, expectedRevision, operationError, reply, revisionConflict } from './http-utils.js';
import { advanceAssetRevision, initializeAssetRevision, normalizePackageReferences } from './domain-utils.js';
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

function visibleProjectPackages(principal, rules, tables, packageRecords = [], bom = currentBom, changeSets = []) {
  return projectPackages(rules, tables, packageRecords, bom, changeSets)
    .map(pkg => ({ ...pkg, assets: pkg.assets.filter(asset => canAccessAsset(principal, asset.id)) }));
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
