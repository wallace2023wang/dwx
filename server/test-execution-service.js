import crypto from 'node:crypto';
import { generateDrl } from '../shared/rules.js';
import { applyFlowMappings, selectFlowBranch, tableCollectedHits, tableDrl, tableExecutionTrace } from '../shared/assets.js';
import { inputFields, outputFields } from '../shared/bom.js';
import { evaluateCepTestCase, evaluateTestCase, expandTestCases, validateTestSuite } from '../shared/test-suites.js';
import { validateEventPayloads } from '../shared/event-streams.js';

export function createTestExecutionService({
  engine,
  readProjectRecord,
  readRules,
  readAssets,
  readBom,
  mutateTestSuites,
  appendAuditEvent,
  parseFacts,
  getCurrentBom,
}) {
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
    const outFields = outputFields(flow.bom || getCurrentBom());
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

  return {
    publishedTarget,
    executeFlow,
    executePublishedTarget,
    runTestSuite,
    recordSuiteRun,
    runAllTestSuites,
    runSingleTestSuite,
    runTestSuiteComparison,
    validateSuiteTarget,
  };
}
