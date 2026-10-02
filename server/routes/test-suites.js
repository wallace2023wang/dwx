import crypto from 'node:crypto';
import { normalizeTestSuite } from '../../shared/test-suites.js';
import { bodyOf, expectedRevision, operationError, reply, revisionConflict } from '../http-utils.js';

export function createTestSuiteHandler({
  readAssets,
  mutateTestSuites,
  appendAuditEvent,
  validateSuiteTarget,
  runAllTestSuites,
  runSingleTestSuite,
  runTestSuiteComparison,
  presentTestSuite,
}) {
  return async function handleTestSuites(req, res, segments, projectId = 'default', project = null) {
    const present = suite => presentTestSuite ? presentTestSuite(suite, project) : suite;
    if (segments.length === 2) {
      if (req.method === 'GET') return reply(res, 200, (await readAssets('testSuites', projectId)).filter(suite => !suite.archived).map(present));
      if (req.method === 'POST') {
        const input = await bodyOf(req);
        const checked = await validateSuiteTarget(input, projectId);
        if (checked.error) return reply(res, checked.status, { error: checked.error });
        const result = await mutateTestSuites(suites => {
          const now = new Date().toISOString();
          const item = {
            id: crypto.randomUUID(), ...normalizeTestSuite(input), archived: false,
            revision: 1, createdAt: now, updatedAt: now, lastRun: null, runs: [],
          };
          suites.unshift(item);
          return { item, changed: true };
        }, projectId);
        await appendAuditEvent('test-suite.created', 'test-suite', result.item.id, `创建测试套件：${result.item.name}`, { revision: 1 }, req);
        return reply(res, 201, present(result.item));
      }
    }
    if (segments.length === 3 && segments[2] === 'run' && req.method === 'POST') {
      return reply(res, 200, await runAllTestSuites(req, projectId));
    }
    if (segments.length === 3 && req.method === 'PUT') {
      const id = segments[2];
      const input = await bodyOf(req);
      const expected = expectedRevision(req, input);
      if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
      const checked = await validateSuiteTarget(input, projectId);
      if (checked.error) return reply(res, checked.status, { error: checked.error });
      const result = await mutateTestSuites(suites => {
        const item = suites.find(suite => suite.id === id && !suite.archived);
        if (!item) return { status: 404, error: '测试套件不存在' };
        const conflict = revisionConflict(item, expected);
        if (conflict) return conflict;
        const normalized = normalizeTestSuite(input);
        const targetChanged = item.target.type !== normalized.target.type || item.target.id !== normalized.target.id;
        Object.assign(item, normalized, { revision: (item.revision || 1) + 1, updatedAt: new Date().toISOString() });
        if (targetChanged) { item.lastRun = null; item.runs = []; }
        return { item, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('test-suite.updated', 'test-suite', id, `更新测试套件：${result.item.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, present(result.item));
    }
    if (segments.length !== 4 || req.method !== 'POST') return reply(res, 404, { error: '未找到资源' });
    const [, , id, action] = segments;
    if (!['run', 'compare', 'archive'].includes(action)) return reply(res, 404, { error: '未找到操作' });
    if (action === 'run') {
      const input = await bodyOf(req);
      const versionNumber = input?.targetVersion ?? null;
      if (versionNumber != null && (!Number.isInteger(versionNumber) || versionNumber < 1)) {
        return reply(res, 400, { error: 'targetVersion 必须是正整数' });
      }
      const result = await runSingleTestSuite(id, req, projectId, versionNumber);
      return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, { suite: present(result.item), report: result.report });
    }
    if (action === 'compare') {
      const input = await bodyOf(req);
      const result = await runTestSuiteComparison(id, input, req, projectId);
      return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, { suite: present(result.item), report: result.report });
    }
    const params = action === 'archive' ? await bodyOf(req) : {};
    const expected = expectedRevision(req, params);
    if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
    const result = await mutateTestSuites(async suites => {
      const suite = suites.find(entry => entry.id === id && !entry.archived);
      if (!suite) return { status: 404, error: '测试套件不存在' };
      if (action === 'archive') {
        const conflict = revisionConflict(suite, expected);
        if (conflict) return conflict;
        suite.archived = true;
        suite.revision = (suite.revision || 1) + 1;
        suite.updatedAt = new Date().toISOString();
        return { item: suite, changed: true };
      }
      return { item: suite, changed: true };
    }, projectId);
    if (result.error) return reply(res, result.status, operationError(result));
    await appendAuditEvent('test-suite.archive', 'test-suite', id, `归档测试套件：${result.item.name}`, { revision: result.item.revision }, req);
    return reply(res, 200, present(result.item));
  };
}
