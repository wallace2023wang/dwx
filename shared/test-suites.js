import { findField, inferSemanticType, inputFields, outputFields } from './bom.js';
import { validateEventPayloads } from './event-streams.js';

const TARGET_TYPES = new Set(['rule', 'table', 'flow', 'event-stream']);

function validValue(field, value) {
  if (field.type === 'Integer') return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
    && (field.min == null || value >= field.min) && (field.max == null || value <= field.max);
  if (field.type === 'Double') return typeof value === 'number' && Number.isFinite(value)
    && (field.min == null || value >= field.min) && (field.max == null || value <= field.max);
  if (field.type === 'Boolean') return typeof value === 'boolean';
  if (field.type === 'String') {
    const semanticType = inferSemanticType(field);
    if (typeof value !== 'string' || value.length > 200 || (field.enum && !field.enum.includes(value))) return false;
    if (semanticType === 'Date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
    return true;
  }
  return false;
}

export function validateTestSuite(suite, bom) {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return '测试套件无效';
  if (typeof suite.name !== 'string' || !suite.name.trim() || suite.name.length > 80) return '测试套件名称需为 1-80 个字符';
  if (typeof (suite.description ?? '') !== 'string' || (suite.description ?? '').length > 500) return '测试套件说明不能超过 500 个字符';
  if (!suite.target || !TARGET_TYPES.has(suite.target.type) || typeof suite.target.id !== 'string' || !suite.target.id) return '测试目标无效';
  if (typeof suite.required !== 'boolean') return '必须明确是否作为发布门禁';
  if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 200) return '测试案例数量需为 1-200 个';

  const ids = new Set();
  let enabledCases = 0;
  let expandedCases = 0;
  const inputs = inputFields(bom);
  const outputs = outputFields(bom);
  for (const [index, testCase] of suite.cases.entries()) {
    const label = `第 ${index + 1} 个测试案例`;
    if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) return `${label}无效`;
    if (typeof testCase.id !== 'string' || !testCase.id || ids.has(testCase.id)) return `${label} ID 无效或重复`;
    ids.add(testCase.id);
    if (typeof testCase.name !== 'string' || !testCase.name.trim() || testCase.name.length > 80) return `${label}名称需为 1-80 个字符`;
    if (typeof testCase.enabled !== 'boolean') return `${label}必须明确是否启用`;
    if (testCase.enabled) enabledCases++;
    if (suite.target.type === 'event-stream') {
      if (testCase.waitMs != null && (!Number.isInteger(testCase.waitMs) || testCase.waitMs < 0 || testCase.waitMs > 300000)) return `${label}等待时间需为 0-300000 毫秒`;
      if (!Array.isArray(testCase.events) || testCase.events.length > 1000) return `${label}事件输入需为 0-1000 条`;
      if (testCase.events.length < 1 && !(Number.isInteger(testCase.waitMs) && testCase.waitMs > 0)) return `${label}纯时间驱动案例需设置等待时间`;
      for (const [eventIndex, event] of testCase.events.entries()) {
        const eventLabel = `${label}的第 ${eventIndex + 1} 个事件`;
        if (!event || typeof event !== 'object' || Array.isArray(event)) return `${eventLabel}无效`;
        if (typeof event.type !== 'string' || !event.type) return `${eventLabel}类型无效`;
        if (event.timestamp != null && (!Number.isFinite(event.timestamp) || event.timestamp < 0)) return `${eventLabel}时间戳无效`;
        if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return `${eventLabel}数据无效`;
      }
      const eventError = validateEventPayloads(testCase.events, bom);
      if (eventError) return `${label}${eventError}`;
      if (!Array.isArray(testCase.expectedEvents) || testCase.expectedEvents.length < 1 || testCase.expectedEvents.length > 100) return `${label}期望事件无效`;
      for (const expected of testCase.expectedEvents) {
        if (!expected || typeof expected !== 'object' || typeof expected.statement !== 'string' || !expected.statement) return `${label}期望事件语句无效`;
        if (typeof expected.eventType !== 'string' || !expected.eventType) return `${label}期望事件类型无效`;
        if (expected.count != null && (!Number.isInteger(expected.count) || expected.count < 0)) return `${label}期望事件次数无效`;
      }
      if (testCase.enabled) expandedCases += 1;
      continue;
    }
    if (!testCase.facts || typeof testCase.facts !== 'object' || Array.isArray(testCase.facts)) return `${label}输入事实无效`;
    for (const [key, value] of Object.entries(testCase.facts)) {
      const field = inputs.find(entry => entry.key === key);
      if (!field || !validValue(field, value)) return `${label}的输入字段 ${key} 无效`;
    }
    if (testCase.parameters !== undefined) {
      if (!Array.isArray(testCase.parameters) || testCase.parameters.length > 100) return `${label}参数行数量不能超过 100 个`;
      const parameterIds = new Set();
      for (const [parameterIndex, parameter] of testCase.parameters.entries()) {
        const parameterLabel = `${label}的第 ${parameterIndex + 1} 个参数行`;
        if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return `${parameterLabel}无效`;
        if (typeof parameter.id !== 'string' || !parameter.id || parameter.id.length > 80 || parameterIds.has(parameter.id)) return `${parameterLabel} ID 无效或重复`;
        parameterIds.add(parameter.id);
        if (typeof parameter.name !== 'string' || !parameter.name.trim() || parameter.name.length > 80) return `${parameterLabel}名称需为 1-80 个字符`;
        if (!parameter.facts || typeof parameter.facts !== 'object' || Array.isArray(parameter.facts)) return `${parameterLabel}输入事实无效`;
        for (const [key, value] of Object.entries(parameter.facts)) {
          const field = inputs.find(entry => entry.key === key);
          if (!field || !validValue(field, value)) return `${parameterLabel}的输入字段 ${key} 无效`;
        }
      }
    }
    if (testCase.enabled) expandedCases += testCase.parameters?.length || 1;
    const expected = testCase.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return `${label}期望结果无效`;
    if (!expected.outputs || typeof expected.outputs !== 'object' || Array.isArray(expected.outputs)) return `${label}期望输出无效`;
    for (const [key, value] of Object.entries(expected.outputs)) {
      const field = outputs.find(entry => entry.key === key);
      if (!field || !validValue(field, value)) return `${label}的期望输出字段 ${key} 无效`;
    }
    if (!Array.isArray(expected.fired) || expected.fired.some(name => typeof name !== 'string' || !name || name.length > 200)) return `${label}期望命中规则无效`;
    if (Object.prototype.hasOwnProperty.call(expected, 'path') && expected.path !== null
      && (typeof expected.path !== 'string' || !expected.path || expected.path.length > 100)) return `${label}期望路径无效`;
    if (suite.target.type !== 'flow' && Object.prototype.hasOwnProperty.call(expected, 'path')) return `${label}仅规则集可断言路径`;
    if (!Object.keys(expected.outputs).length && !expected.fired.length && !Object.prototype.hasOwnProperty.call(expected, 'path')) return `${label}至少需要一个结果断言`;
  }
  if (!enabledCases) return '测试套件至少需要一个启用的案例';
  if (expandedCases > 1000) return '测试套件展开后不能超过 1000 次执行';
  return null;
}

export function normalizeTestSuite(input) {
  const eventStream = input.target?.type === 'event-stream';
  return {
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    target: { type: input.target.type, id: input.target.id },
    required: input.required,
    cases: input.cases.map(testCase => eventStream ? ({
      id: testCase.id,
      name: testCase.name.trim(),
      enabled: testCase.enabled,
      events: structuredClone(testCase.events),
      ...(testCase.waitMs ? { waitMs: testCase.waitMs } : {}),
      expectedEvents: structuredClone(testCase.expectedEvents),
      ...(Array.isArray(testCase.assertions) ? { assertions: structuredClone(testCase.assertions) } : {}),
    }) : ({
      id: testCase.id,
      name: testCase.name.trim(),
      enabled: testCase.enabled,
      facts: structuredClone(testCase.facts),
      ...(testCase.parameters?.length ? { parameters: testCase.parameters.map(parameter => ({
        id: parameter.id,
        name: parameter.name.trim(),
        facts: structuredClone(parameter.facts),
      })) } : {}),
      expected: {
        outputs: structuredClone(testCase.expected.outputs),
        fired: [...testCase.expected.fired],
        ...(Object.prototype.hasOwnProperty.call(testCase.expected, 'path') ? { path: testCase.expected.path } : {}),
      },
    })),
  };
}

export function expandTestCases(suite) {
  return suite.cases.filter(testCase => testCase.enabled).flatMap(testCase => {
    if (suite.target?.type === 'event-stream') return [{ ...testCase, facts: { events: testCase.events, ...(testCase.waitMs ? { waitMs: testCase.waitMs } : {}) }, parentCaseId: testCase.id, parameterId: null, parameterName: null }];
    if (!testCase.parameters?.length) return [{ ...testCase, parentCaseId: testCase.id, parameterId: null, parameterName: null }];
    return testCase.parameters.map(parameter => ({
      ...testCase,
      id: `${testCase.id}::${parameter.id}`,
      name: `${testCase.name} / ${parameter.name}`,
      facts: { ...testCase.facts, ...parameter.facts },
      parentCaseId: testCase.id,
      parameterId: parameter.id,
      parameterName: parameter.name,
    }));
  });
}

function firedRules(result) {
  if (Array.isArray(result.fired)) return result.fired;
  return (result.trace || []).flatMap(step => Array.isArray(step.fired) ? step.fired : []);
}


export function evaluateCepTestCase(testCase, result) {
  const detections = Array.isArray(result.detections) ? result.detections : [];
  const assertions = (testCase.expectedEvents || []).map(expected => {
    const actualEvents = detections.filter(event => event.statement === expected.statement && event.eventType === expected.eventType);
    const actual = actualEvents.length;
    const count = expected.count ?? 1;
    const fieldsPassed = expected.fields && actualEvents.length
      ? actualEvents.some(event => Object.entries(expected.fields).every(([key, value]) => Object.is(event.data?.[key], value)))
      : true;
    return {
      type: 'event', statement: expected.statement, eventType: expected.eventType,
      expected: { count, fields: expected.fields || null }, actual, passed: actual === count && fieldsPassed,
    };
  });
  return { events: detections, assertions, passed: assertions.every(assertion => assertion.passed) };
}

export function evaluateTestCase(testCase, result, bom) {
  const actualFired = firedRules(result);
  const assertions = [];
  for (const [fieldKey, expected] of Object.entries(testCase.expected.outputs)) {
    const actual = result.facts?.[fieldKey];
    assertions.push({
      type: 'output', field: fieldKey, label: findField(bom, fieldKey)?.label || fieldKey,
      expected, actual: actual ?? null, passed: Object.is(actual, expected),
    });
  }
  for (const expected of testCase.expected.fired) {
    assertions.push({ type: 'fired', expected, actual: actualFired, passed: actualFired.includes(expected) });
  }
  if (Object.prototype.hasOwnProperty.call(testCase.expected, 'path')) {
    const actual = result.path?.branchId ?? null;
    assertions.push({ type: 'path', expected: testCase.expected.path, actual, passed: actual === testCase.expected.path });
  }
  return {
    outputs: Object.fromEntries(outputFields(bom).filter(field => result.facts?.[field.key] !== undefined).map(field => [field.key, result.facts[field.key]])),
    fired: actualFired,
    path: result.path?.branchId ?? null,
    assertions,
    passed: assertions.every(assertion => assertion.passed),
  };
}
