#!/usr/bin/env node
/**
 * 充氮控制 —— BAL 规则版种子脚本（阈值判定回归规则）
 * ============================================================
 * 背景（为什么把决策表换成 BAL 规则）：
 *   客户要求"最大/最小氮气浓度这几个判断参数会动态调整，应该在规则中实现"。
 *   而平台**决策表条件单元格只接受字面量**（`shared/assets.js:64 parseConditionCell`
 *   → `formatDrlValue` → `parseValue` 要求 Number.isFinite），无法写 `nitrogenPct >= maxPct`。
 *
 *   两种错法：
 *     · 阈值留在驱动代码里     → 改阈值要改代码重启（现状）
 *     · 阈值写进决策表字面量   → 阈值随 Release 冻结，改一次要重新发布+部署
 *   正确做法：阈值作为 facts 传入，由规则做跨字段比较（BAL 的 raw 条件直通 DRL）。
 *   已实测：同一份规则，阈值 [90,95] → [85,93] 行为立刻跟着变，规则内无任何数字。
 *
 * 另一个实测约束：未赋值的 Boolean 字段会被引擎默认成 false，
 *   因此 `pctAtLeastMax == null` 这类守卫**永远不成立**，必须用纯跨字段比较写阈值规则。
 *
 * 用法：
 *   node seed-nitrogen-bal.mjs                # 创建/更新 12 条规则并编译
 *   node seed-nitrogen-bal.mjs --project <id>
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const DEFAULT_PROJECT = 'project-63dbe140';
const argv = process.argv.slice(2);
const argProject = (() => { const i = argv.indexOf('--project'); return i >= 0 ? argv[i + 1] : DEFAULT_PROJECT; })();

const PACKAGE = 'nitrogen';
const log = (...a) => console.log(...a);

async function call(method, path, body) {
  const response = await fetch(`${RTS_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
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

// ---------------------------------------------------------------- 规则定义

const DEV = {
  filling: { genCmd: 'ON', fillValveCmd: 'OPEN', circValveCmd: 'CLOSED', fanCmd: 'ON' },
  circulation: { genCmd: 'OFF', fillValveCmd: 'CLOSED', circValveCmd: 'OPEN', fanCmd: 'ON' },
  holding: { genCmd: 'OFF', fillValveCmd: 'CLOSED', circValveCmd: 'CLOSED', fanCmd: 'OFF' },
  replenishing: { genCmd: 'ON', fillValveCmd: 'OPEN', circValveCmd: 'CLOSED', fanCmd: 'OFF' },
};

/**
 * salience 从高到低：结束 > 暂停 > 阈值判定 > 状态迁移。
 * 阈值规则必须排在迁移规则之前，让 pctAtLeastMax / pctBelowMin 先算出来。
 */
/** 条件构造：raw 直通 DRL 片段（阈值比较就在这里），field/operator/value 走平台校验 */
const F = (field, operator, value) => ({ field, operator, value });
const RAW = expr => ({ raw: expr });
const GUARDS = [RAW('paused == false'), RAW('endReached == false')];
const devActions = (phase, reason, dev) => [
  { field: 'nextPhase', value: phase },
  { field: 'reason', value: reason },
  ...Object.entries(dev).map(([field, value]) => ({ field, value })),
];

/**
 * 12 条规则，salience 从高到低：结束 > 暂停 > 状态迁移。
 *
 * 关键设计（已实测）：
 *   · 阈值比较写在条件里（`nitrogenPct >= maxPct`），阈值是 facts 而非字面量
 *     → 改 maxPct/minPct 参数立即生效，**无需重新发布规则**
 *   · 不引入中间布尔字段：BAL 动作只能写 output，无法把比较结果写进 input
 *   · 不能用 `pctAtLeastMax == null` 之类的空值守卫：未赋值的 Boolean 会被引擎默认成 false
 */
const RULES = [
  {
    name: '到达结束时间完成',
    description: 'endReached（now >= endAt，由中控折算）时收口：写 COMPLETED 并关闭全部设备。优先级最高，覆盖任何阶段与暂停。',
    // 平台实测：salience 高的**先**执行、低的**后**执行，而后写覆盖 → 要胜出须给更低 salience。
    // 因此"结束"用 55、低于"暂停"的 60，才能在两者同时成立时覆盖暂停。
    priority: 55,
    conditions: [RAW('endReached == true')],
    actions: devActions('COMPLETED', '到达结束时间，充氮结束', DEV.holding),
  },
  {
    name: '暂停全关',
    description: 'paused=true 时设备全关并置 PAUSED。优先级仅次于结束时间（salience 高于结束，先执行、会被结束覆盖）；环流计时由中控冻结。',
    priority: 60,
    conditions: [RAW('paused == true')],
    actions: devActions('PAUSED', '暂停中，设备全关', DEV.holding),
  },
  {
    name: '启动充氮',
    description: 'PENDING → FILLING：开制氮机、充氮阀与风机（环流阀关闭，互斥）。',
    priority: 10,
    conditions: [F('phase', '==', 'PENDING'), ...GUARDS],
    actions: devActions('FILLING', '开始充氮，进入充氮期', DEV.filling),
  },
  {
    name: '充氮未达标保持',
    description: 'FILLING 且 nitrogenPct < maxPct：保持充氮设备态。',
    priority: 9,
    conditions: [F('phase', '==', 'FILLING'), RAW('nitrogenPct < maxPct'), ...GUARDS],
    actions: devActions('FILLING', '充氮未达标，保持充氮', DEV.filling),
  },
  {
    name: '充氮达标转环流',
    description: 'FILLING 且 nitrogenPct >= maxPct：关制氮机与充氮阀、开环流阀与风机。',
    priority: 8,
    conditions: [F('phase', '==', 'FILLING'), RAW('nitrogenPct >= maxPct'), ...GUARDS],
    actions: devActions('CIRCULATION', '浓度达最大，停止充氮转环流', DEV.circulation),
  },
  {
    name: '环流未满保持',
    description: 'CIRCULATION 且环流累计未满（circElapsed=false）：保持环流设备态。',
    priority: 7,
    conditions: [F('phase', '==', 'CIRCULATION'), RAW('circElapsed == false'), ...GUARDS],
    actions: devActions('CIRCULATION', '环流中，通风循环', DEV.circulation),
  },
  {
    name: '环流期满转保氮',
    description: 'CIRCULATION 且 circElapsed：停环流进入保氮。环流时长是参数，暂停期间不计时（由中控累计）。',
    priority: 6,
    conditions: [F('phase', '==', 'CIRCULATION'), RAW('circElapsed == true'), ...GUARDS],
    actions: devActions('HOLDING', '环流期满，进入保氮期', DEV.holding),
  },
  {
    name: '保氮正常保持',
    description: 'HOLDING 且 nitrogenPct >= minPct：设备全关，等待浓度下降。',
    priority: 5,
    conditions: [F('phase', '==', 'HOLDING'), RAW('nitrogenPct >= minPct'), ...GUARDS],
    actions: devActions('HOLDING', '保氮中，设备全关', DEV.holding),
  },
  {
    name: '保氮过低转补氮',
    description: 'HOLDING 且 nitrogenPct < minPct：开制氮机与充氮阀补氮。',
    priority: 4,
    conditions: [F('phase', '==', 'HOLDING'), RAW('nitrogenPct < minPct'), ...GUARDS],
    actions: devActions('REPLENISHING', '浓度低于最小，开充氮补氮', DEV.replenishing),
  },
  {
    name: '补氮未达标保持',
    description: 'REPLENISHING 且 nitrogenPct < maxPct：保持补氮设备态。',
    priority: 3,
    conditions: [F('phase', '==', 'REPLENISHING'), RAW('nitrogenPct < maxPct'), ...GUARDS],
    actions: devActions('REPLENISHING', '补氮未达标，保持补氮', DEV.replenishing),
  },
  {
    name: '补氮达标转环流',
    description: 'REPLENISHING 且 nitrogenPct >= maxPct：停止充氮转环流，环路闭合。',
    priority: 2,
    conditions: [F('phase', '==', 'REPLENISHING'), RAW('nitrogenPct >= maxPct'), ...GUARDS],
    actions: devActions('CIRCULATION', '补氮达标，停止充氮转环流', DEV.circulation),
  },
];

async function ensureRule(projectId, definition) {
  const assets = await get(`/api/projects/${projectId}/rules`);
  const existing = assets.find(a => a.name === definition.name);
  let assetId;
  if (existing) {
    assetId = existing.id;
  } else {
    const created = await post(`/api/projects/${projectId}/rules`, {
      type: 'rule', name: definition.name, category: PACKAGE,
    });
    assetId = created.id ?? created.asset?.id;
    log(`  创建规则「${definition.name}」：${assetId}`);
  }
  const detail = await get(`/api/projects/${projectId}/rules/${assetId}`);
  const draft = {
    name: definition.name,
    description: definition.description,
    category: PACKAGE,
    priority: definition.priority,
    salience: definition.priority,
    conditions: definition.conditions,
    actions: definition.actions,
  };
  const same = JSON.stringify(detail.draft?.conditions) === JSON.stringify(draft.conditions)
    && JSON.stringify(detail.draft?.actions) === JSON.stringify(draft.actions)
    && detail.draft?.description === draft.description
    && detail.draft?.priority === draft.priority
    && detail.draft?.salience === draft.salience;
  if (same) {
    log(`  「${definition.name}」内容一致，跳过`);
    return { assetId, revision: detail.revision, status: detail.status, changed: false };
  }
  const saved = await put(`/api/projects/${projectId}/rules/${assetId}`, { revision: detail.revision, draft });
  log(`  「${definition.name}」已保存（revision → ${saved.revision}，原状态 ${detail.status}）`);
  return { assetId, revision: saved.revision, status: saved.status, changed: true };
}

async function main() {
  log(`Team Server: ${RTS_URL}`);
  const project = await get(`/api/projects/${argProject}`);
  log(`项目: ${project.name}（engine=${project.engine}）\n`);

  log(`创建/更新 ${RULES.length} 条 BAL 规则（阈值比较内联在条件里）`);
  const created = [];
  for (const definition of RULES) created.push({ definition, ...(await ensureRule(argProject, definition)) });

  // 逐条编译校验：BAL 规则没有 analyze 动作，改用详情返回的生成 DRL 送真实 Build Service
  log('\n编译校验（真实 Drools Build Service）：');
  let failed = 0;
  for (const { definition, assetId } of created) {
    try {
      const detail = await get(`/api/projects/${assetId.split('/').pop() && argProject}/rules/${assetId}`);
      const drl = detail.content;
      if (!drl || drl.startsWith('//')) throw new Error(drl || '未生成 DRL');
      const response = await fetch('http://127.0.0.1:8788/compile', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drl }), signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (result.ok) log(`  ✓ ${definition.name}`);
      else { log(`  ✗ ${definition.name}：${(result.errors || []).join('; ')}`); failed++; }
    } catch (error) {
      log(`  ✗ ${definition.name}：${error.message}`); failed++;
    }
  }

  log(`\nBAL_RESULT=${JSON.stringify({ projectId: argProject, ruleCount: RULES.length, failed })}`);
  if (failed) process.exit(1);
  log(`
▸ 下一步：把规则流「自动充氮控制规则流」的公共步骤改为规则包「${PACKAGE}」，
  然后重新发布 Release —— 这样阈值判定就完全在规则里了。
`);
}

main().catch(error => {
  console.error(`\n✗ BAL 规则种子失败：${error.message}`);
  process.exit(1);
});
