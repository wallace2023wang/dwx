import crypto from 'node:crypto';
import { buildRelease, validateReleaseRequest } from '../../shared/releases.js';
import { validateEventPayloads } from '../../shared/event-streams.js';
import { bodyOf, operationError, reply } from '../http-utils.js';

function normalizeProjectEngine(value) {
  return value === 'cep' ? 'cep' : 'rules';
}

function markLatestReleases(releases) {
  const latest = new Map();
  for (const release of releases) {
    const version = Number(release.version) || 0;
    latest.set(release.decisionService, Math.max(latest.get(release.decisionService) || 0, version));
  }
  return releases.map(release => ({
    ...release,
    latestForDecisionService: (Number(release.version) || 0) === latest.get(release.decisionService),
  }));
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
  actorOf,
  appendAuditEvent,
  engine,
  executionServer,
  runTestSuite,
  recordSuiteRun,
  parseFacts,
}) {
  return async function handleReleases(req, res, segments, projectId = 'default') {
    const project = await readProjectRecord(projectId);
    if (segments.length === 2) {
      if (req.method === 'GET') return reply(res, 200, markLatestReleases(await readReleases(projectId)));
      if (req.method === 'POST') {
        const rawRequest = await bodyOf(req);
        const request = rawRequest && typeof rawRequest === 'object' ? { ...rawRequest } : rawRequest;
        if (projectId !== 'default' && typeof request?.decisionService === 'string') {
          if (!request.decisionService.includes('/')) request.decisionService = `${projectId}/${request.decisionService}`;
          else if (!request.decisionService.startsWith(`${projectId}/`)) {
            return reply(res, 400, { error: `决策服务标识必须属于当前项目，例如 ${projectId}/grain-alarm` });
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
              createdBy: actorOf(req),
            });
          } catch (buildError) { return { status: 400, error: buildError.message }; }
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
        if (result.error) return reply(res, result.status, { error: result.error, gate: result.gate, reports: result.reports, failedCases: result.failedCases });
        await appendAuditEvent('release.created', 'release', result.item.id, `创建 Release：${result.item.name}`, {
          decisionService: result.item.decisionService, version: result.item.version, checksum: result.item.checksum,
        }, req);
        return reply(res, 201, { ...result.item, latestForDecisionService: true });
      }
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
        if (!existing) release.deployments.push(receipt);
        return { item: release, changed: !existing };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('release.deployed', 'release', id, `部署 Release：${result.item.name}`, {
        environment: 'local', deploymentId: result.item.deployments.at(-1)?.id,
      }, req);
      return reply(res, 200, markLatestReleases(await readReleases(projectId)).find(release => release.id === result.item.id));
    }
    if (action === 'execute') {
      const release = (await readReleases(projectId)).find(item => item.id === id);
      if (!release) return reply(res, 404, { error: '发布包不存在' });
      if (!release.deployments?.some(item => item.environment === 'local')) return reply(res, 409, { error: '发布包尚未部署到 local 环境' });
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
      const executed = await executionServer('/execute', { releaseId: release.id, requestId: payload.requestId, facts }, project);
      return reply(res, executed.status || 200, executed.result || { error: executed.error });
    }
    if (action === 'events') {
      const release = (await readReleases(projectId)).find(item => item.id === id);
      if (!release) return reply(res, 404, { error: '发布包不存在' });
      if (normalizeProjectEngine(project.engine) !== 'cep') return reply(res, 400, { error: '仅 CEP Release 支持事件上报端点' });
      if (!release.deployments?.some(item => item.environment === 'local')) return reply(res, 409, { error: '发布包尚未部署到 local 环境' });
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
      if (result.item.deployments?.some(item => item.environment === 'local')) {
        const configured = await executionServer('/webhook', { releaseId: result.item.id, webhook: result.item.webhook }, project);
        if (configured.error) return reply(res, configured.status || 502, operationError(configured));
      }
      await appendAuditEvent('release.webhook', 'release', id, `配置 Release 告警回调：${result.item.name}`, { enabled: result.item.webhook.enabled }, req);
      return reply(res, 200, markLatestReleases(await readReleases(projectId)).find(release => release.id === result.item.id));
    }
    return reply(res, 404, { error: '未找到操作' });
  };
}
