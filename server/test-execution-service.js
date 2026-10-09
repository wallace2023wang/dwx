import crypto from 'node:crypto';
import { generateDrl } from '../shared/rules.js';
import { applyFlowMappings, flowBranches, flowGateways, isFlowGraph, selectFlowBranch, tableCollectedHits, tableDrl, tableExecutionTrace } from '../shared/assets.js';
import { decisionTreeDrl, decisionTreeExecutionTrace, decisionTreeLeaves, isDecisionTree } from '../shared/decision-trees.js';
import { isScorecard, scorecardDrl, scorecardExecutionTrace } from '../shared/scorecards.js';
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
        drl: version.drl || generateDrl([version.rule || item.published], bom, (version.rule || item.published).variables),
      };
    }
    if (target.type === 'table') {
      const bom = version.bom || await readBom(projectId);
      const table = version.draft || item.published;
      return {
        type: target.type, item, version: version.number, bom, table, project,
        drl: version.drl || (isScorecard(table)
          ? scorecardDrl(table, bom, item.id, project.variables || [])
          : isDecisionTree(table)
          ? decisionTreeDrl(table, bom, item.id, project.variables || [])
          : tableDrl(table, bom, item.id, project.variables || [])),
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
    const gateways = flowGateways(flow).sort((left, right) => left.afterStep - right.afterStep);
    const nodeIds = new Set();
    const nodeAddress = (step, legacyNodeId) => ({ nodeId: step.nodeId || legacyNodeId, legacyNodeId });
    if (isFlowGraph(flow)) for (const node of flow.graph.nodes) nodeIds.add(node.id);
    else flow.steps.forEach((step, index) => {
      const address = nodeAddress(step, `common:${index}`);
      nodeIds.add(address.nodeId);
      nodeIds.add(address.legacyNodeId);
    });
    for (const gateway of isFlowGraph(flow) ? [] : gateways) {
      nodeIds.add(gateway.id);
      if (gateways.length === 1) nodeIds.add('gateway');
      for (const branch of gateway.branches) branch.steps.forEach((step, index) => {
        const address = nodeAddress(step, `branch:${branch.id}:${index}`);
        nodeIds.add(address.nodeId);
        nodeIds.add(address.legacyNodeId);
      });
    }
    const stopAfter = options.stopAfter == null || options.stopAfter === '' ? null : options.stopAfter;
    if (stopAfter != null && (typeof stopAfter !== 'string' || !nodeIds.has(stopAfter))) return { status: 400, error: '调试停止节点无效' };
    const expectsPath = Object.prototype.hasOwnProperty.call(options, 'expectedPath');
    const expectedPath = options.expectedPath;
    if (expectsPath && expectedPath !== null && (typeof expectedPath !== 'string' || !flowBranches(flow).some(branch => branch.id === expectedPath))) {
      return { status: 400, error: '期望流程路径无效' };
    }

    const trace = [];
    const outFields = outputFields(flow.bom || getCurrentBom());
    let limitReached = false;
    let stoppedAt = null;
    const selectedPaths = [];
    const runSteps = async (steps, scope, targetFacts = facts, targetTrace = trace) => {
      for (const [index, step] of steps.entries()) {
        const legacyNodeId = scope.nodeId || (scope.kind === 'common' ? `common:${scope.offset + index}` : `branch:${scope.branch.id}:${index}`);
        const nodeId = scope.nodeId || step.nodeId || legacyNodeId;
        const inputMappings = applyFlowMappings(step.inputMappings, targetFacts);
        const checked = await engine('/test', { drl: step.drl, facts: targetFacts });
        if (checked.error) {
          return {
            error: `${step.name}：${checked.error}`,
            status: checked.status,
            failedStep: {
              nodeId, legacyNodeId, name: step.name, type: step.type, version: step.version,
              gatewayId: scope.gateway?.id || null, branchId: scope.branch?.id || null, branchName: scope.branch?.name || null,
            },
          };
        }
        for (const field of outFields) {
          const value = checked.result.facts[field.key];
          if (value !== undefined && value !== null) targetFacts[field.key] = value;
        }
        const outputMappings = applyFlowMappings(step.outputMappings, targetFacts);
        targetTrace.push({
          nodeId, legacyNodeId, name: step.name, type: step.type, version: step.version, fired: checked.result.fired,
          gatewayId: scope.gateway?.id || null, branchId: scope.branch?.id || null, branchName: scope.branch?.name || null,
          decisionHits: checked.result.decisionHits || [],
          parallelId: scope.parallel?.id || null, parallelBranchId: scope.parallelBranch?.id || null,
          count: checked.result.count, facts: { ...targetFacts }, mappings: { inputs: inputMappings, outputs: outputMappings },
        });
        if (checked.result.limitReached) { limitReached = true; break; }
        if (stopAfter === nodeId || stopAfter === legacyNodeId) { stoppedAt = nodeId; break; }
      }
      return null;
    };
    const failure = async failed => ({ status: failed.status, result: {
      error: failed.error, failedStep: failed.failedStep, facts, trace,
      path: selectedPaths.length === 1 ? selectedPaths[0] : null, paths: selectedPaths,
      debug: { requestedStop: stopAfter, stoppedAt },
    } });

    if (isFlowGraph(flow)) {
      const nodes = new Map(flow.graph.nodes.map(node => [node.id, node]));
      const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const walkGraph = async (startId, targetFacts = facts, targetTrace = trace, stopId = 'end', parallel = null, parallelBranch = null) => {
        let currentId = startId;
        while (currentId !== stopId && currentId !== 'end' && !limitReached && !stoppedAt) {
          const node = nodes.get(currentId);
          if (!node) return { error: `图节点 ${currentId} 不存在`, status: 500, failedStep: { nodeId: currentId, name: currentId, type: 'flow-node' } };
        if (node.type === 'step') {
            const stepError = await runSteps([node.step], { kind: 'common', offset: 0, nodeId: node.id, parallel, parallelBranch }, targetFacts, targetTrace);
            if (stepError) return stepError;
          currentId = node.next;
          continue;
        }
          if (node.type === 'gateway') {
            const selectedBranch = selectFlowBranch(node.branches, targetFacts);
            const path = {
              gatewayId: node.id, gatewayName: node.name || '排他网关',
              branchId: selectedBranch?.id || null, branchName: selectedBranch?.name || null, default: selectedBranch?.default === true,
            };
            selectedPaths.push(path);
            targetTrace.push({
              nodeId: node.id, name: node.name || '排他网关', type: 'gateway', count: 0, facts: { ...targetFacts },
              branchId: path.branchId, branchName: path.branchName, default: path.default,
              parallelId: parallel?.id || null, parallelBranchId: parallelBranch?.id || null,
            });
            if (stopAfter === node.id) stoppedAt = node.id;
            currentId = selectedBranch?.next || 'end';
            continue;
          }
          if (node.type === 'parallel') {
            const join = nodes.get(node.join);
            const baseFacts = structuredClone(targetFacts);
            const branchResults = [];
            targetTrace.push({ nodeId: node.id, name: node.name || '并行网关', type: 'parallel', count: 0, facts: { ...targetFacts }, branches: node.branches.map(branch => ({ id: branch.id, name: branch.name })) });
            for (const branch of node.branches) {
              const branchFacts = structuredClone(baseFacts);
              const branchTrace = [];
              const branchError = await walkGraph(branch.next, branchFacts, branchTrace, node.join, node, branch);
              targetTrace.push(...branchTrace);
              if (branchError) return branchError;
              branchResults.push({ branch, facts: branchFacts });
            }
            const changes = new Map();
            for (const { branch, facts: branchFacts } of branchResults) {
              for (const [key, value] of Object.entries(branchFacts)) {
                if (sameValue(value, baseFacts[key])) continue;
                changes.set(key, [...(changes.get(key) || []), { branchId: branch.id, branchName: branch.name, value }]);
              }
            }
            const conflicts = [...changes].flatMap(([field, values]) => values.some(item => !sameValue(item.value, values[0].value)) ? [{ field, values }] : []);
            if (conflicts.length) return {
              error: `聚合节点“${join?.name || node.join}”存在并行输出冲突：${conflicts.map(item => item.field).join('、')}`,
              status: 409,
              failedStep: { nodeId: node.join, name: join?.name || '聚合节点', type: 'join', conflicts },
            };
            for (const [key, values] of changes) targetFacts[key] = values[0].value;
            targetTrace.push({ nodeId: node.join, name: join?.name || '聚合节点', type: 'join', count: 0, facts: { ...targetFacts }, mergedFields: [...changes.keys()] });
            if (stopAfter === node.id || stopAfter === node.join) stoppedAt = stopAfter;
            currentId = join?.next || 'end';
            continue;
          }
          if (node.type === 'join') return { error: `聚合节点 ${node.id} 不能脱离并行网关执行`, status: 500, failedStep: { nodeId: node.id, name: node.name, type: 'join' } };
        }
        return null;
      };
      const graphError = await walkGraph(flow.graph.entry);
      if (graphError) return failure(graphError);
      const assertions = [];
      if (expectsPath) {
        const matchedPath = selectedPaths.find(path => path.branchId === expectedPath);
        const expectedBranch = flowBranches(flow).find(branch => branch.id === expectedPath);
        const actual = matchedPath?.branchId ?? (selectedPaths.length === 1 ? selectedPaths[0].branchId : null);
        assertions.push({
          type: 'path', expected: expectedPath, actual,
          expectedName: expectedBranch?.name || (expectedPath === null ? '无匹配分支' : null),
          actualName: matchedPath?.branchName || (selectedPaths.length === 1 ? selectedPaths[0].branchName : null),
          evaluated: selectedPaths.length > 0, passed: expectedPath === null ? selectedPaths.some(path => path.branchId === null) : Boolean(matchedPath),
        });
      }
      return { status: 200, result: {
        ok: true, facts, trace, limitReached,
        path: selectedPaths.length === 1 ? selectedPaths[0] : null, paths: selectedPaths,
        debug: { requestedStop: stopAfter, stoppedAt }, assertions,
        passed: assertions.every(assertion => assertion.passed),
        count: trace.reduce((total, step) => total + step.count, 0),
      } };
    }

    const gatewaysByPosition = new Map(gateways.map(gateway => [gateway.afterStep, gateway]));
    for (let position = 0; position <= flow.steps.length && !limitReached && !stoppedAt; position++) {
      const gateway = gatewaysByPosition.get(position);
      if (gateway) {
        const selectedBranch = selectFlowBranch(gateway.branches, facts);
        const path = {
          gatewayId: gateway.id, gatewayName: gateway.name || '排他网关',
          branchId: selectedBranch?.id || null, branchName: selectedBranch?.name || null, default: selectedBranch?.default === true,
        };
        selectedPaths.push(path);
        trace.push({
          nodeId: gateway.id, name: gateway.name || '排他网关', type: 'gateway', count: 0, facts: { ...facts },
          branchId: path.branchId, branchName: path.branchName, default: path.default,
        });
        if (stopAfter === gateway.id || (gateways.length === 1 && stopAfter === 'gateway')) stoppedAt = gateway.id;
        if (selectedBranch && !stoppedAt) {
          const branchError = await runSteps(selectedBranch.steps, { kind: 'branch', gateway, branch: selectedBranch, offset: 0 });
          if (branchError) return failure(branchError);
        }
      }
      if (position < flow.steps.length && !limitReached && !stoppedAt) {
        const commonError = await runSteps([flow.steps[position]], { kind: 'common', offset: position });
        if (commonError) return failure(commonError);
      }
    }
    const assertions = [];
    if (expectsPath) {
      const matchedPath = selectedPaths.find(path => path.branchId === expectedPath);
      const expectedBranch = flowBranches(flow).find(branch => branch.id === expectedPath);
      const actual = matchedPath?.branchId ?? (selectedPaths.length === 1 ? selectedPaths[0].branchId : null);
      assertions.push({
        type: 'path', expected: expectedPath, actual,
        expectedName: expectedBranch?.name || (expectedPath === null ? '无匹配分支' : null),
        actualName: matchedPath?.branchName || (selectedPaths.length === 1 ? selectedPaths[0].branchName : null),
        evaluated: selectedPaths.length > 0, passed: expectedPath === null ? selectedPaths.some(path => path.branchId === null) : Boolean(matchedPath),
      });
    }
    return { status: 200, result: {
      ok: true, facts, trace, limitReached,
      path: selectedPaths.length === 1 ? selectedPaths[0] : null, paths: selectedPaths,
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
    const result = resolved.type === 'table' && isScorecard(resolved.table) ? {
      ...checked.result,
      scorecardTrace: scorecardExecutionTrace(resolved.table, checked.result.fired, facts, resolved.bom),
    } : resolved.type === 'table' && isDecisionTree(resolved.table) ? {
      ...checked.result,
      decisionTreeTrace: decisionTreeExecutionTrace(resolved.table, checked.result.fired, resolved.bom, resolved.project?.variables || []),
    } : resolved.type === 'table' ? {
      ...checked.result,
      hitPolicy: resolved.table.hitPolicy || 'ALL',
      decisionTrace: tableExecutionTrace(resolved.table, checked.result.fired, resolved.bom, resolved.project?.variables || []),
      decisionHits: Array.isArray(checked.result.decisionHits) && checked.result.decisionHits.length ? checked.result.decisionHits : tableCollectedHits(resolved.table, checked.result.fired, resolved.bom, resolved.project?.variables || []),
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
      if (isScorecard(resolved.table)) return {
        kind: 'scorecard-band',
        items: resolved.table.bands.map(band => ({ id: `band:${band.id}`, label: band.label })),
      };
      if (isDecisionTree(resolved.table)) return {
        kind: 'tree-leaf',
        items: decisionTreeLeaves(resolved.table).map(leaf => ({ id: `leaf:${leaf.id}`, label: leaf.label })),
      };
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
    const branches = flowBranches(resolved.flow);
    return {
      kind: 'flow-path',
      items: branches.length
        ? branches.map(branch => ({ id: branch.id, label: branch.name }))
        : [{ id: 'main', label: '主路径' }],
    };
  }

  function eventStatementIds(resolved, statementName) {
    const statements = resolved.module?.statements || [];
    const statement = statements.find(item => item.name === statementName
      || item.epl?.match(/@Name\s*\(\s*['"]([^'"]+)['"]\s*\)/)?.[1] === statementName);
    return statement ? [statement.name] : [statementName];
  }

  function coverageHits(resolved, executionResult) {
    if (resolved.type === 'rule') return executionResult.fired?.length ? [resolved.item.id] : [];
    if (resolved.type === 'table') {
      if (isScorecard(resolved.table)) return executionResult.scorecardTrace?.firedBandId ? [`band:${executionResult.scorecardTrace.firedBandId}`] : [];
      if (isDecisionTree(resolved.table)) return (executionResult.decisionTreeTrace || [])
        .filter(entry => entry.leafId)
        .map(entry => `leaf:${entry.leafId}`);
      return (executionResult.decisionTrace || [])
        .filter(entry => entry.rowIndex !== null)
        .map(entry => `row:${entry.rowIndex}`);
    }
    if (resolved.type === 'event-stream') return (executionResult.detections || []).flatMap(event => eventStatementIds(resolved, event.statement || 'event-stream'));
    if (flowGateways(resolved.flow).length) return (executionResult.paths || (executionResult.path ? [executionResult.path] : [])).flatMap(path => path.branchId ? [path.branchId] : []);
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
      const branchIds = new Set(flowBranches(target.flow).map(branch => branch.id));
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
