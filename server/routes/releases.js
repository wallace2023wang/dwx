import crypto from 'node:crypto';
import { buildRelease, validateReleaseRequest } from '../../shared/releases.js';
import { validateEventPayloads } from '../../shared/event-streams.js';
import { domainErrorResult } from '../../shared/errors.js';
import { bodyOf, operationError, reply } from '../http-utils.js';

function normalizeProjectEngine(value) {
  return value === 'cep' ? 'cep' : 'rules';
}

const DEFAULT_ENVIRONMENT = 'local';

function deploymentFor(release, environment = DEFAULT_ENVIRONMENT) {
  return [...(release.deployments || [])].reverse().find(item => item.environment === environment);
}

function isLiveDeployment(deployment) {
  return Boolean(deployment && deployment.status !== 'stopped');
}

function compareReleaseVersion(left, right) {
  return (Number(right.version) || 0) - (Number(left.version) || 0)
    || String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
}

function activeReleaseFor(releases, decisionService, environment = DEFAULT_ENVIRONMENT) {
  const deployed = releases
    .filter(release => release.decisionService === decisionService && isLiveDeployment(deploymentFor(release, environment)))
    .sort(compareReleaseVersion);
  const explicit = deployed.filter(release => deploymentFor(release, environment)?.status === 'active');
  return (explicit.length ? explicit : deployed)[0] || null;
}

function presentReleases(releases) {
  const latest = new Map();
  for (const release of releases) {
    const version = Number(release.version) || 0;
    latest.set(release.decisionService, Math.max(latest.get(release.decisionService) || 0, version));
  }
  const activeIds = new Map();
  for (const release of releases) {
    for (const deployment of release.deployments || []) {
      if (!isLiveDeployment(deployment)) continue;
      const key = `${release.decisionService}\u0000${deployment.environment}`;
      if (!activeIds.has(key)) {
        const active = activeReleaseFor(releases, release.decisionService, deployment.environment);
        if (active) activeIds.set(key, active.id);
      }
    }
  }
  return releases.map(release => ({
    ...release,
    deployments: (release.deployments || []).map(deployment => ({
      ...deployment,
      status: deployment.status === 'stopped'
        ? 'stopped'
        : activeIds.get(`${release.decisionService}\u0000${deployment.environment}`) === release.id ? 'active' : 'deployed',
    })),
    latestForDecisionService: (Number(release.version) || 0) === latest.get(release.decisionService),
    rollbackAvailable: activeIds.get(`${release.decisionService}\u0000${DEFAULT_ENVIRONMENT}`) === release.id
      && releases.some(candidate => candidate.decisionService === release.decisionService
        && candidate.id !== release.id
        && isLiveDeployment(deploymentFor(candidate, DEFAULT_ENVIRONMENT))
        && (Number(candidate.version) || 0) < (Number(release.version) || 0)),
  }));
}

function setActiveRelease(releases, release, environment, actor) {
  const now = new Date().toISOString();
  for (const candidate of releases) {
    if (candidate.decisionService !== release.decisionService) continue;
    const deployment = deploymentFor(candidate, environment);
    if (!isLiveDeployment(deployment)) continue;
    deployment.status = candidate.id === release.id ? 'active' : 'deployed';
    if (candidate.id === release.id) {
      deployment.activatedAt = now;
      deployment.activatedBy = actor;
    }
  }
}

async function activateExecutionRelease(executionServer, release, project) {
  if (normalizeProjectEngine(project.engine) !== 'rules') return { result: { ok: true } };
  return executionServer('/activate', { releaseId: release.id, decisionService: release.decisionService }, project);
}

function failedGateCases(reports) {
  return reports.flatMap(report => (report.cases || [])
    .filter(testCase => !testCase.passed)
    .map(testCase => ({
      suiteId: report.suiteId,
      suiteName: report.suiteName,
      targetVersion: report.targetVersion,
      caseId: testCase.id,
      name: testCase.name,
      error: testCase.error || null,
      assertions: (testCase.assertions || []).filter(assertion => !assertion.passed).map(assertion => ({
        type: assertion.type,
        field: assertion.field || null,
        label: assertion.label || null,
        expected: assertion.expected,
        actual: assertion.actual,
      })),
    })));
}

export function createReleaseHandler({
  readProjectRecord,
  readReleases,
  mutateReleases,
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
}) {
  return async function handleReleases(req, res, segments, projectId = 'default', projectScoped = false) {
    const project = await readProjectRecord(projectId);
    if (segments.length === 2) {
      if (req.method === 'GET') return reply(res, 200, presentReleases(await readReleases(projectId)));
      if (req.method === 'POST') {
        const rawRequest = await bodyOf(req);
        const request = rawRequest && typeof rawRequest === 'object' ? { ...rawRequest } : rawRequest;
        if (projectId !== 'default' && typeof request?.decisionService === 'string') {
          if (!request.decisionService.includes('/')) request.decisionService = `${projectId}/${request.decisionService}`;
          else if (!request.decisionService.startsWith(`${projectId}/`)) {
            return reply(res, 400, { error: `决策服务标识必须属于当前项目，例如 ${projectId}/grain-alarm` });
          }
        }
        if (projectScoped) {
          const requiredTargetType = normalizeProjectEngine(project.engine) === 'cep' ? 'event-stream' : 'flow';
          if (request?.target?.type && request.target.type !== requiredTargetType) {
            return reply(res, 400, {
              error: requiredTargetType === 'flow'
                ? '项目业务 Release 必须以规则集为发布目标。单条规则发布只更新规则库；请重新发布引用它的规则集，再构建 Release。'
                : 'CEP 项目 Release 必须以事件流为发布目标。',
            });
          }
        }
        const error = validateReleaseRequest(request);
        if (error) return reply(res, 400, { error });
        const result = await mutateReleases(async releases => {
          let release;
          try {
            release = buildRelease({
              id: crypto.randomUUID(), request, releases,
              rules: await readRules(projectId), tables: await readAssets('tables', projectId), flows: await readAssets('flows', projectId), eventStreams: await readAssets('eventStreams', projectId),
              bom: await readBom(projectId),
              packageRecords: await readPackageRecords(projectId),
              enforceCurrentFlowDependencies: true,
              projectVariables: project.variables || [],
              createdBy: actorOf(req),
            });
          } catch (buildError) { return domainErrorResult(buildError); }
          for (const step of release.steps || []) {
            const checked = await engine('/compile', { drl: step.drl }, project);
            if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
          }
          if (release.target?.type === 'event-stream') {
            const checked = await engine('/compile', { module: release.module || { schemas: release.schemas || [], statements: release.statements || [] } }, project);
            if (checked.error) return { status: checked.status, error: `事件流编译失败：${checked.error}` };
          }
          const suites = await readAssets('testSuites', projectId);
          const required = suites.filter(suite => !suite.archived && suite.required
            && suite.target.type === request.target.type && suite.target.id === request.target.id);
          const reports = [];
          for (const suite of required) {
            const report = await runTestSuite(suite, projectId);
            recordSuiteRun(suite, report);
            reports.push(report);
          }
          if (reports.length) await writeAssets('testSuites', suites, projectId);
          const gate = {
            passed: reports.every(report => report.passed),
            checkedAt: new Date().toISOString(),
            suites: reports.map(report => ({
              id: report.suiteId, name: report.suiteName, runId: report.id,
              targetVersion: report.targetVersion, passed: report.passed,
              total: report.total, passedCount: report.passedCount, failedCount: report.failedCount,
            })),
          };
          if (!gate.passed) return { status: 409, error: '发布门禁未通过', gate, reports, failedCases: failedGateCases(reports) };
          const stored = { ...release, deployments: [], qualityGate: gate };
          releases.unshift(stored);
          return { item: stored, changed: true };
        }, projectId);
        if (result.error) return reply(res, result.status, { error: result.error, code: result.code, details: result.details, gate: result.gate, reports: result.reports, failedCases: result.failedCases });
        await appendAuditEvent('release.created', 'release', result.item.id, `创建 Release：${result.item.name}`, {
          decisionService: result.item.decisionService, version: result.item.version, checksum: result.item.checksum,
        }, req);
        return reply(res, 201, { ...result.item, latestForDecisionService: true, rollbackAvailable: false });
      }
    }
    if (segments[1] === 'services' && segments.length === 4 && segments[3] === 'execute' && req.method === 'POST') {
      const serviceKey = decodeURIComponent(segments[2]);
      const decisionService = serviceKey.includes('/') ? serviceKey : `${projectId}/${serviceKey}`;
      const releases = await readReleases(projectId);
      const release = activeReleaseFor(releases, decisionService, DEFAULT_ENVIRONMENT);
      if (!release) return reply(res, 409, { error: `决策服务 ${decisionService} 在 local 环境没有当前生效版本` });
      return executeRelease(req, res, release, project);
    }
    if (segments.length !== 4 || req.method !== 'POST') return reply(res, 404, { error: '未找到资源' });
    const [, , id, action] = segments;
    if (action === 'deploy') {
      const params = await bodyOf(req);
      if ((params.environment || 'local') !== 'local') return reply(res, 400, { error: '当前版本只支持 local 环境' });
      const result = await mutateReleases(async releases => {
        const release = releases.find(item => item.id === id);
        if (!release) return { status: 404, error: '发布包不存在' };
        const deployed = await executionServer('/deploy', release, project);
        if (deployed.error) return deployed;
        const receipt = {
          id: deployed.result.deploymentId,
          environment: 'local',
          deployedAt: deployed.result.deployedAt,
          checksum: deployed.result.checksum,
          modelVersion: deployed.result.modelVersion ?? release.model?.version ?? null,
          engine: deployed.result.engine || release.engine?.type,
          engineVersion: deployed.result.engineVersion || release.engine?.esper || release.engine?.drools,
        };
        const existing = release.deployments.find(item => item.id === receipt.id);
        const currentActive = activeReleaseFor(releases, release.decisionService, receipt.environment);
        receipt.status = currentActive && currentActive.id !== release.id ? 'deployed' : 'active';
        if (receipt.status === 'active') {
          receipt.activatedAt = receipt.deployedAt;
          receipt.activatedBy = actorOf(req);
        }
        if (existing) {
          Object.assign(existing, receipt);
          delete existing.stoppedAt;
          delete existing.stoppedBy;
        } else release.deployments.push(receipt);
        if (receipt.status === 'active') setActiveRelease(releases, release, receipt.environment, actorOf(req));
        return { item: release, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('release.deployed', 'release', id, `部署 Release：${result.item.name}`, {
        environment: 'local', deploymentId: result.item.deployments.at(-1)?.id,
      }, req);
      return reply(res, 200, presentReleases(await readReleases(projectId)).find(release => release.id === result.item.id));
    }
    if (action === 'activate') {
      const params = await bodyOf(req);
      const environment = params.environment || DEFAULT_ENVIRONMENT;
      if (environment !== DEFAULT_ENVIRONMENT) return reply(res, 400, { error: '当前版本只支持 local 环境' });
      const result = await mutateReleases(async releases => {
        const release = releases.find(item => item.id === id);
        if (!release) return { status: 404, error: '发布包不存在' };
        if (!isLiveDeployment(deploymentFor(release, environment))) return { status: 409, error: '发布包尚未部署或已停用' };
        const activated = await activateExecutionRelease(executionServer, release, project);
        if (activated.error) return activated;
        setActiveRelease(releases, release, environment, actorOf(req));
        return { item: release, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      await appendAuditEvent('release.activated', 'release', id, `激活 Release：${result.item.name}`, { environment }, req);
      return reply(res, 200, presentReleases(await readReleases(projectId)).find(release => release.id === id));
    }
    if (action === 'rollback') {
      const params = await bodyOf(req);
      const environment = params.environment || DEFAULT_ENVIRONMENT;
      if (environment !== DEFAULT_ENVIRONMENT) return reply(res, 400, { error: '当前版本只支持 local 环境' });
      const result = await mutateReleases(async releases => {
        const release = releases.find(item => item.id === id);
        if (!release) return { status: 404, error: '发布包不存在' };
        const active = activeReleaseFor(releases, release.decisionService, environment);
        if (!active || active.id !== release.id) return { status: 409, error: '只有当前生效版本可以执行回退' };
        const target = releases
          .filter(candidate => candidate.decisionService === release.decisionService
            && candidate.id !== release.id
            && isLiveDeployment(deploymentFor(candidate, environment))
            && (Number(candidate.version) || 0) < (Number(release.version) || 0))
          .sort(compareReleaseVersion)[0];
        if (!target) return { status: 409, error: '没有可回退的已部署历史版本' };
        const activated = await activateExecutionRelease(executionServer, target, project);
        if (activated.error) return activated;
        setActiveRelease(releases, target, environment, actorOf(req));
        return { item: target, previous: release, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      await appendAuditEvent('release.rolled-back', 'release', result.item.id, `回退至 Release：${result.item.name}`, {
        environment, fromReleaseId: result.previous.id,
      }, req);
      return reply(res, 200, presentReleases(await readReleases(projectId)).find(release => release.id === result.item.id));
    }
    if (action === 'undeploy') {
      const params = await bodyOf(req);
      const environment = params.environment || DEFAULT_ENVIRONMENT;
      if (environment !== DEFAULT_ENVIRONMENT) return reply(res, 400, { error: '当前版本只支持 local 环境' });
      const result = await mutateReleases(async releases => {
        const release = releases.find(item => item.id === id);
        if (!release) return { status: 404, error: '发布包不存在' };
        const deployment = deploymentFor(release, environment);
        if (!isLiveDeployment(deployment)) return { status: 409, error: '发布包尚未部署或已经停用' };
        if (activeReleaseFor(releases, release.decisionService, environment)?.id === release.id) {
          return { status: 409, error: '当前生效版本不能直接卸载，请先激活其他版本或执行回退' };
        }
        const stopped = await executionServer('/undeploy', { releaseId: release.id }, project);
        if (stopped.error) return stopped;
        deployment.status = 'stopped';
        deployment.stoppedAt = stopped.result.stoppedAt || new Date().toISOString();
        deployment.stoppedBy = actorOf(req);
        return { item: release, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('release.undeployed', 'release', id, `卸载 Release：${result.item.name}`, { environment }, req);
      return reply(res, 200, presentReleases(await readReleases(projectId)).find(release => release.id === id));
    }
    if (action === 'execute') {
      const release = (await readReleases(projectId)).find(item => item.id === id);
      if (!release) return reply(res, 404, { error: '发布包不存在' });
      if (!isLiveDeployment(deploymentFor(release))) return reply(res, 409, { error: '发布包尚未部署到 local 环境或已经停用' });
      return executeRelease(req, res, release, project);
    }

    async function executeRelease(req, res, release, project) {
      const payload = await bodyOf(req);
      if (normalizeProjectEngine(project.engine) === 'cep') {
        const events = Array.isArray(payload.events) ? payload.events : Array.isArray(payload.facts?.events) ? payload.facts.events : [];
        const validation = validateEventPayloads(events, release.model);
        if (validation) return reply(res, 400, { error: validation });
        const waitMs = Number.isInteger(payload.waitMs) ? payload.waitMs : Number.isInteger(payload.facts?.waitMs) ? payload.facts.waitMs : 0;
        const executed = await executionServer('/execute', { releaseId: release.id, requestId: payload.requestId, events, ...(waitMs ? { waitMs } : {}) }, project);
        return reply(res, executed.status || 200, executed.result || { error: executed.error });
      }
      const facts = parseFacts(payload.facts, release.model || await readBom(projectId));
      if (!facts) return reply(res, 400, { error: '测试输入字段或类型无效' });
      const settle = payload.settle === true;
      const executed = await executionServer('/execute', {
        releaseId: release.id, requestId: payload.requestId, facts,
        ...(settle ? {
          settle: true,
          maxRounds: Number.isInteger(payload.maxRounds) ? payload.maxRounds : 8,
          feedbackMappings: Array.isArray(payload.feedbackMappings) ? payload.feedbackMappings : [],
        } : {}),
      }, project);
      return reply(res, executed.status || 200, executed.result || { error: executed.error });
    }
    if (action === 'events') {
      const release = (await readReleases(projectId)).find(item => item.id === id);
      if (!release) return reply(res, 404, { error: '发布包不存在' });
      if (normalizeProjectEngine(project.engine) !== 'cep') return reply(res, 400, { error: '仅 CEP Release 支持事件上报端点' });
      if (!isLiveDeployment(deploymentFor(release))) return reply(res, 409, { error: '发布包尚未部署到 local 环境或已经停用' });
      const payload = await bodyOf(req);
      const events = Array.isArray(payload.events) ? payload.events : Array.isArray(payload.facts?.events) ? payload.facts.events : [];
      const validation = validateEventPayloads(events, release.model);
      if (validation) return reply(res, 400, { error: validation });
      const waitMs = Number.isInteger(payload.waitMs) ? payload.waitMs : Number.isInteger(payload.facts?.waitMs) ? payload.facts.waitMs : 0;
      const posted = await executionServer(`/events/${encodeURIComponent(release.id)}`, { events, ...(waitMs ? { waitMs } : {}) }, project);
      return reply(res, posted.status || 202, posted.result || { error: posted.error });
    }
    if (action === 'webhook') {
      if (normalizeProjectEngine(project.engine) !== 'cep') return reply(res, 400, { error: '仅 CEP Release 支持告警回调' });
      const payload = await bodyOf(req);
      const webhook = payload?.webhook || payload;
      if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) return reply(res, 400, { error: 'webhook 配置无效' });
      const result = await mutateReleases(async releases => {
        const release = releases.find(item => item.id === id);
        if (!release) return { status: 404, error: '发布包不存在' };
        release.webhook = {
          enabled: webhook.enabled !== false,
          callbackUrl: String(webhook.callbackUrl || '').trim(),
          secret: typeof webhook.secret === 'string' ? webhook.secret : '',
          clearedAfterMs: Number.isInteger(webhook.clearedAfterMs) ? webhook.clearedAfterMs : 0,
          maxRetries: Number.isInteger(webhook.maxRetries) ? webhook.maxRetries : 0,
          minIntervalMs: Number.isInteger(webhook.minIntervalMs) ? webhook.minIntervalMs : 0,
        };
        if (release.webhook.enabled && !/^https?:\/\//.test(release.webhook.callbackUrl)) return { status: 400, error: 'callbackUrl 必须是 http(s) 地址' };
        return { item: release, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      if (isLiveDeployment(deploymentFor(result.item))) {
        const configured = await executionServer('/webhook', { releaseId: result.item.id, webhook: result.item.webhook }, project);
        if (configured.error) return reply(res, configured.status || 502, operationError(configured));
      }
      await appendAuditEvent('release.webhook', 'release', id, `配置 Release 告警回调：${result.item.name}`, { enabled: result.item.webhook.enabled }, req);
      return reply(res, 200, presentReleases(await readReleases(projectId)).find(release => release.id === result.item.id));
    }
    return reply(res, 404, { error: '未找到操作' });
  };
}
