#!/usr/bin/env node
/**
 * 粮库自动充氮控制 —— 测试套件种子脚本
 * ------------------------------------------------------------
 * 为规则集「自动充氮控制规则集」建立发布门禁套件，覆盖 docs 的 T1–T16。
 *
 * 断言方式：`expected.outputs`（规则集两个公共步骤的最终 facts）。
 * 因为规则集会依次执行「表 A → 表 B」，端到端结果就是最终设备态，
 * 所以用 outputs 断言即可同时覆盖迁移与设备指令。
 *
 * 用法：
 *   node seed-nitrogen-suite.mjs
 *   node seed-nitrogen-suite.mjs --project project-63dbe140
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const DEFAULT_PROJECT = 'project-63dbe140';
const argProject = (() => {
  const i = process.argv.indexOf('--project');
  return i >= 0 ? process.argv[i + 1] : DEFAULT_PROJECT;
})();

const SUITE_NAME = '自动充氮状态机回归（发布门禁）';

async function call(method, path, body) {
  const response = await fetch(`${RTS_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${parsed?.error || parsed?.raw || text}`);
  return parsed;
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);

const log = (...a) => console.log(...a);

// 基准 facts：只给"未到结束时间、未暂停、浓度区间外"的中性值，各案例按需覆盖
// 基准 facts：给真实浓度与阈值 —— 阈值比较由**规则**完成，测试直接喂数值。
// 刻意不传 pctAtLeastMax / pctBelowMin：它们由规则计算，驱动器传了反而会让判定失效。
const base = {
  warehouseId: 'W-01',
  phase: 'PENDING',
  circElapsed: false,
  endReached: false,
  paused: false,
  nitrogenPct: 92,
  maxPct: 95,
  minPct: 90,
};

/** 期望设备态的简写：[gen, fill, circ, fan] */
const DEV = {
  filling: ['ON', 'OPEN', 'CLOSED', 'ON'],
  circulation: ['OFF', 'CLOSED', 'OPEN', 'ON'],
  holding: ['OFF', 'CLOSED', 'CLOSED', 'OFF'],
  replenishing: ['ON', 'OPEN', 'CLOSED', 'OFF'],
};
const devices = ([gen, fill, circ, fan]) => ({
  genCmd: gen, fillValveCmd: fill, circValveCmd: circ, fanCmd: fan,
});

const CASES = [
  // ---- 阈值即参数：同一批用例里混用不同阈值，证明"改参数即改行为" ----
  ['T1', '启动：PENDING → 充氮', { phase: 'PENDING', nitrogenPct: 88 },
    'FILLING', DEV.filling, '开始充氮，进入充氮期'],
  ['T2', '充氮达标 → 环流（阈值 95）', { phase: 'FILLING', nitrogenPct: 95 },
    'CIRCULATION', DEV.circulation, '浓度达最大，停止充氮转环流'],
  ['T3', '充氮达标（等号边界）', { phase: 'FILLING', nitrogenPct: 95, maxPct: 95 },
    'CIRCULATION', DEV.circulation, '浓度达最大，停止充氮转环流'],
  ['T4', '充氮未达标 → 保持充氮', { phase: 'FILLING', nitrogenPct: 94.9 },
    'FILLING', DEV.filling, '充氮未达标，保持充氮'],
  ['T5', '环流期满 → 保氮', { phase: 'CIRCULATION', circElapsed: true, nitrogenPct: 93 },
    'HOLDING', DEV.holding, '环流期满，进入保氮期'],
  ['T6', '环流未满 → 保持环流', { phase: 'CIRCULATION', circElapsed: false, nitrogenPct: 93 },
    'CIRCULATION', DEV.circulation, '环流中，通风循环'],
  ['T7', '保氮浓度过低 → 补氮（阈值 90）', { phase: 'HOLDING', nitrogenPct: 89.9 },
    'REPLENISHING', DEV.replenishing, '浓度低于最小，开充氮补氮'],
  ['T8', '保氮浓度正常 → 保持保氮', { phase: 'HOLDING', nitrogenPct: 90 },
    'HOLDING', DEV.holding, '保氮中，设备全关'],
  ['T9', '补氮达标 → 环流', { phase: 'REPLENISHING', nitrogenPct: 95 },
    'CIRCULATION', DEV.circulation, '补氮达标，停止充氮转环流'],
  ['T10', '补氮未达标 → 保持补氮', { phase: 'REPLENISHING', nitrogenPct: 94.9 },
    'REPLENISHING', DEV.replenishing, '补氮未达标，保持补氮'],
  // ---- 动态阈值：同一条规则，只改参数 ----
  ['T11', '动态阈值 [85,93]：94% 应转环流', { phase: 'FILLING', nitrogenPct: 94, maxPct: 93, minPct: 85 },
    'CIRCULATION', DEV.circulation, '浓度达最大，停止充氮转环流'],
  ['T12', '动态阈值 [85,93]：87% 不应补氮', { phase: 'HOLDING', nitrogenPct: 87, maxPct: 93, minPct: 85 },
    'HOLDING', DEV.holding, '保氮中，设备全关'],
  ['T13', '动态阈值 [85,93]：84.9% 应补氮', { phase: 'HOLDING', nitrogenPct: 84.9, maxPct: 93, minPct: 85 },
    'REPLENISHING', DEV.replenishing, '浓度低于最小，开充氮补氮'],
  ['T14', '动态阈值 [98,99]：95% 不应转环流', { phase: 'FILLING', nitrogenPct: 95, maxPct: 99, minPct: 98 },
    'FILLING', DEV.filling, '充氮未达标，保持充氮'],
  // ---- 暂停与结束优先级 ----
  ['T15', '补氮中暂停 → PAUSED 全关', { phase: 'REPLENISHING', nitrogenPct: 96, paused: true },
    'PAUSED', DEV.holding, '暂停中，设备全关'],
  ['T16', '环流中暂停 → PAUSED 全关', { phase: 'CIRCULATION', nitrogenPct: 93, paused: true },
    'PAUSED', DEV.holding, '暂停中，设备全关'],
  ['T17', '结束优先于迁移', { phase: 'FILLING', nitrogenPct: 96, endReached: true },
    'COMPLETED', DEV.holding, '到达结束时间，充氮结束'],
  ['T18', '结束优先于暂停', { phase: 'HOLDING', nitrogenPct: 80, paused: true, endReached: true },
    'COMPLETED', DEV.holding, '到达结束时间，充氮结束'],
  ['T19', '结束优先于启动', { phase: 'PENDING', nitrogenPct: 88, endReached: true },
    'COMPLETED', DEV.holding, '到达结束时间，充氮结束'],
];

const buildCase = ([id, name, overrides, nextPhase, dev, reason]) => ({
  id,
  name,
  enabled: true,
  facts: { ...base, ...overrides },
  expected: {
    outputs: { nextPhase, ...devices(dev), reason },
    fired: [],
  },
});

async function main() {
  log(`Team Server: ${RTS_URL}`);
  const flows = await get(`/api/projects/${argProject}/flows`);
  const flow = flows.find(f => (f.flowName || f.name) === '自动充氮控制规则集');
  if (!flow) throw new Error('找不到规则集「自动充氮控制规则集」，请先运行 seed-nitrogen-flow.mjs');
  const flowId = flow.id ?? flow.flowId;
  log(`规则集: ${flowId}（目标可为草稿，门禁运行时要求已发布）\n`);

  const payload = {
    name: SUITE_NAME,
    description: '覆盖 T1–T19：四阶段迁移、保持、暂停、结束时间优先、等号边界，以及**动态阈值**（同一条规则只改 maxPct/minPct 参数）。阈值为参数而非字面量，比较在规则内完成。',
    target: { type: 'flow', id: flowId },
    required: true,
    cases: CASES.map(buildCase),
  };

  const suites = await get(`/api/projects/${argProject}/test-suites`);
  const existing = suites.find(s => s.name === SUITE_NAME);
  if (existing) {
    log(`套件已存在（${existing.id}），覆盖为最新用例（revision ${existing.revision}）`);
    const updated = await put(`/api/projects/${argProject}/test-suites/${existing.id}`, {
      ...payload,
      revision: existing.revision,
    });
    log(`  已更新 → revision ${updated.revision}，用例 ${updated.cases?.length ?? CASES.length} 条`);
  } else {
    const created = await post(`/api/projects/${argProject}/test-suites`, payload);
    log(`创建套件：${created.id}，用例 ${created.cases?.length ?? CASES.length} 条`);
  }

  log(`
▸ 套件已就绪（required=true，参与 Release 门禁）。
▸ 运行需要规则集已发布：发布后在「测试套件」页运行，或创建 Release 时由门禁自动重跑。
`);
  log(`SUITE_RESULT=${JSON.stringify({ projectId: argProject, flowId, suiteName: SUITE_NAME, caseCount: CASES.length })}`);
}

main().catch(error => {
  console.error(`\n✗ 测试套件种子失败：${error.message}`);
  process.exit(1);
});
