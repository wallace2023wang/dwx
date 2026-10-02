#!/usr/bin/env node
/**
 * 粮库自动充氮控制 —— 资产种子脚本（路线 A′ + C）
 * ------------------------------------------------------------
 * 依据：docs/nitrogen-auto-fill-asset-design.md（已定稿）
 *
 * 职责边界（决策 D5）：
 *   本脚本用 Team Server API **一次性种子化**：
 *     项目 → BOM → 决策表 A/B → 规则流草稿 → 测试套件
 *   并调用真实 Drools Build Service 做编译校验。
 *
 *   本脚本**不做**：创建 Release、部署到 RES。
 *   这两步必须由人在 Decision Workbench 页面完成（治理动作 + 演示动作）。
 *
 * 用法：
 *   node seed-nitrogen-control.mjs                # 完整种子（幂等：已存在则跳过创建，只做校验）
 *   node seed-nitrogen-control.mjs --dry-run      # 只打印将要提交的 payload
 *   node seed-nitrogen-control.mjs --project <id> # 复用已有项目
 *
 * 环境变量：
 *   RTS_URL   默认 http://127.0.0.1:8789   ← 注意：README 写 8787，实际运行在 8789
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const DRY_RUN = process.argv.includes('--dry-run');
const argProject = (() => {
  const i = process.argv.indexOf('--project');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const PACKAGE = 'nitrogen';
const PROJECT_NAME = '粮库自动充氮控制（决策表状态机）';

// ---------------------------------------------------------------- HTTP 封装

async function call(method, path, body) {
  const url = `${RTS_URL}${path}`;
  if (DRY_RUN && method !== 'GET') {
    console.log(`\n[DRY-RUN] ${method} ${path}`);
    console.log(JSON.stringify(body, null, 2).slice(0, 1600));
    return { dryRun: true };
  }
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) {
    const detail = parsed?.error || parsed?.raw || text;
    throw new Error(`${method} ${path} → ${response.status}: ${detail}`);
  }
  return parsed;
}

const get = path => call('GET', path);
const post = (path, body) => call('POST', path, body);
const put = (path, body) => call('PUT', path, body);

// ---------------------------------------------------------------- BOM 定义

const ENUM_PHASE = ['PENDING', 'FILLING', 'CIRCULATION', 'HOLDING', 'REPLENISHING', 'PAUSED', 'COMPLETED'];

function field(key, label, type, kind, extra = {}) {
  return {
    key,
    label,
    type,
    runtimeType: type,
    semanticType: extra.semanticType ?? (type === 'Boolean' ? 'Boolean' : type === 'Double' ? 'Decimal' : type),
    kind,
    factType: kind === 'input' ? 'NitrogenControl' : 'NitrogenCommand',
    factTypeLabel: kind === 'input' ? '充氮控制输入' : '充氮设备指令',
    group: extra.group ?? (kind === 'input' ? '控制输入' : '设备指令'),
    unit: extra.unit ?? null,
    min: extra.min ?? null,
    max: extra.max ?? null,
    enum: extra.enum ?? null,
    control: extra.control ?? (type === 'Boolean' ? 'boolean' : type === 'Double' ? 'number' : 'text'),
    description: extra.description ?? '',
    ...(extra.required != null ? { required: extra.required } : {}),
  };
}

const BOM = {
  version: null, // 由服务器维护，PUT 时填当前值
  fields: [
    // ---- 入参（kind=input），10 个 ----
    field('warehouseId', '仓号', 'String', 'input', { required: true, description: '不参与规则条件，仅用于执行报告与审计留痕' }),
    field('phase', '当前阶段', 'String', 'input', { semanticType: 'Enum', enum: ENUM_PHASE, required: true, description: '由仓端中控持有并在每轮传入' }),
    field('pctAtLeastMax', '浓度已达最大', 'Boolean', 'input', { required: false, description: '【已废弃】早期由中控预处理；现阈值比较在规则内完成，本字段仅为兼容历史 Release 保留' }),
    field('pctBelowMin', '浓度低于最小', 'Boolean', 'input', { required: false, description: '【已废弃】同上，规则内完成 nitrogenPct < minPct' }),
    field('circElapsed', '环流期满', 'Boolean', 'input', { required: true, description: '中控预处理：环流累计运行时长 >= 配置时长（暂停期间冻结）' }),
    field('endReached', '已到结束时间', 'Boolean', 'input', { required: true, description: '中控预处理：now >= endAt' }),
    field('paused', '暂停中', 'Boolean', 'input', { required: true, description: '暂停标志。中控侧暂停时直接短路（不调用 RES），此字段同时作为规则侧兜底（决策记录 D3）' }),
    field('nitrogenPct', '氮气浓度(%)', 'Double', 'input', { required: true, unit: '%', min: 0, max: 100, description: '实测浓度。**规则用它做阈值比较**（nitrogenPct >= maxPct）' }),
    field('maxPct', '最大氮气浓度(%)', 'Double', 'input', { required: true, unit: '%', min: 0, max: 100, description: '浓度上限参数。按仓传入，**调整它即改变规则行为，无需重新发布规则**' }),
    field('minPct', '最小氮气浓度(%)', 'Double', 'input', { required: true, unit: '%', min: 0, max: 100, description: '浓度下限参数。同上，可动态调整' }),
    // ---- 出参（kind=output），6 个 ----
    field('nextPhase', '迁移目标阶段', 'String', 'output', { semanticType: 'Enum', enum: ENUM_PHASE }),
    field('genCmd', '制氮机指令', 'String', 'output', { semanticType: 'Enum', enum: ['ON', 'OFF'] }),
    field('fillValveCmd', '充氮阀指令', 'String', 'output', { semanticType: 'Enum', enum: ['OPEN', 'CLOSED'] }),
    field('circValveCmd', '环流阀指令', 'String', 'output', { semanticType: 'Enum', enum: ['OPEN', 'CLOSED'] }),
    field('fanCmd', '环流风机指令', 'String', 'output', { semanticType: 'Enum', enum: ['ON', 'OFF'] }),
    field('reason', '迁移原因', 'String', 'output', { control: 'text' }),
  ],
  eventTypes: [],
};

// ---------------------------------------------------------------- 决策表定义

// 表 A：主状态迁移 + 设备指令。
//
// 为什么设备指令放在本表，而不是拆到"按 phase 选设备态"的第二张表？
//   已实测（V1）：平台不允许 output 回填 input，步骤间传递的是 nextPhase，
//   而后续步骤若按 phase 选行，读到的是**迁移前**的阶段 → 会开出错误阀门
//   （FILLING→CIRCULATION 却给出"充氮阀 OPEN"）。所以设备态必须由产生迁移的同一行给出。
//
// 行序 = 优先级（首行优先）。具体迁移在前，宽条件（暂停）在后。
// 空单元格 = 不限制（通配）。
const TABLE_A = {
  name: '充氮状态迁移表',
  description: '充氮状态机主表：每行给出「迁移目标阶段 + 迁移原因 + 4 路设备指令」完整状态。行序即优先级，首行优先；具体迁移在前，暂停兜底在后。本表覆盖所有暂停/迁移场景，覆盖不足时由「充氮结束处理表」在 endReached=true 分支兜底。注意：设备态必须与迁移同行给出，因为 phase 不能回填（后续步骤按 phase 选行会读到迁移前的值）。',
  category: PACKAGE,
  priority: 30,
  hitPolicy: 'FIRST',
  conditions: [
    { field: 'phase', operator: '==' },
    { field: 'pctAtLeastMax', operator: '==' },
    { field: 'pctBelowMin', operator: '==' },
    { field: 'circElapsed', operator: '==' },
    { field: 'paused', operator: '==' },
  ],
  actions: [
    { field: 'nextPhase' }, { field: 'reason' },
    { field: 'genCmd' }, { field: 'fillValveCmd' }, { field: 'circValveCmd' }, { field: 'fanCmd' },
  ],
  rows: [
    // 1 启动（PENDING）→ 充氮
    { enabled: true, priority: 10,
      conditions: ['PENDING', '', '', '', 'false'],
      actions: ['FILLING', '开始充氮，进入充氮期', 'ON', 'OPEN', 'CLOSED', 'ON'] },
    // 2 充氮中未达标 → 保持充氮
    { enabled: true, priority: 20,
      conditions: ['FILLING', 'false', '', '', 'false'],
      actions: ['FILLING', '充氮未达标，保持充氮', 'ON', 'OPEN', 'CLOSED', 'ON'] },
    // 3 充氮达标 → 环流
    { enabled: true, priority: 30,
      conditions: ['FILLING', 'true', '', '', 'false'],
      actions: ['CIRCULATION', '浓度达最大，停止充氮转环流', 'OFF', 'CLOSED', 'OPEN', 'ON'] },
    // 4 环流未满 → 保持环流
    { enabled: true, priority: 40,
      conditions: ['CIRCULATION', '', '', 'false', 'false'],
      actions: ['CIRCULATION', '环流中，通风循环', 'OFF', 'CLOSED', 'OPEN', 'ON'] },
    // 5 环流期满 → 保氮
    { enabled: true, priority: 50,
      conditions: ['CIRCULATION', '', '', 'true', 'false'],
      actions: ['HOLDING', '环流期满，进入保氮期', 'OFF', 'CLOSED', 'CLOSED', 'OFF'] },
    // 6 保氮中浓度正常 → 保持保氮
    { enabled: true, priority: 60,
      conditions: ['HOLDING', '', 'false', '', 'false'],
      actions: ['HOLDING', '保氮中，设备全关', 'OFF', 'CLOSED', 'CLOSED', 'OFF'] },
    // 7 保氮浓度过低 → 补氮
    { enabled: true, priority: 70,
      conditions: ['HOLDING', '', 'true', '', 'false'],
      actions: ['REPLENISHING', '浓度低于最小，开充氮补氮', 'ON', 'OPEN', 'CLOSED', 'OFF'] },
    // 8 补氮中未达标 → 保持补氮
    { enabled: true, priority: 80,
      conditions: ['REPLENISHING', 'false', '', '', 'false'],
      actions: ['REPLENISHING', '补氮未达标，保持补氮', 'ON', 'OPEN', 'CLOSED', 'OFF'] },
    // 9 补氮达标 → 环流
    { enabled: true, priority: 90,
      conditions: ['REPLENISHING', 'true', '', '', 'false'],
      actions: ['CIRCULATION', '补氮达标，停止充氮转环流', 'OFF', 'CLOSED', 'OPEN', 'ON'] },
    // 10 暂停兜底（任意阶段）
    { enabled: true, priority: 100,
      conditions: ['', '', '', '', 'true'],
      actions: ['PAUSED', '暂停中，设备全关', 'OFF', 'CLOSED', 'CLOSED', 'OFF'] },
  ],
};

// 表 B：结束兜底（endReached == true）。由规则流的 endReached 网关调用。
// 必须补写 nextPhase=COMPLETED：进入该分支时表 A 不会执行。
const TABLE_B = {
  name: '充氮结束处理表',
  description: '到达结束时间时统一收口：写 COMPLETED 并关闭全部设备。由规则流 endReached 网关的 true 分支调用；因为该分支不执行主状态迁移表，所以本表必须自己写 nextPhase。',
  category: PACKAGE,
  priority: 60,
  hitPolicy: 'FIRST',
  conditions: [{ field: 'endReached', operator: '==' }],
  actions: [
    { field: 'nextPhase' }, { field: 'reason' },
    { field: 'genCmd' }, { field: 'fillValveCmd' }, { field: 'circValveCmd' }, { field: 'fanCmd' },
  ],
  rows: [
    { enabled: true, priority: 10, conditions: ['true'],
      actions: ['COMPLETED', '到达结束时间，充氮结束', 'OFF', 'CLOSED', 'CLOSED', 'OFF'] },
  ],
};

// ---------------------------------------------------------------- 工具

const log = (...args) => console.log(...args);
const step = title => log(`\n=== ${title} ===`);

async function findProjectByName(name) {
  const projects = await get('/api/projects');
  const list = Array.isArray(projects) ? projects : projects?.items || [];
  return list.find(p => p.name === name) || null;
}

async function ensureProject() {
  step('1. 项目');
  if (argProject) {
    const project = await get(`/api/projects/${argProject}`);
    log(`复用项目 ${project.id}（${project.name}），engine=${project.engine}`);
    if (project.engine !== 'rules') throw new Error('目标项目不是 rules 引擎，本方案要求 engine=rules');
    return project;
  }
  const existing = await findProjectByName(PROJECT_NAME);
  if (existing) {
    log(`已存在同名项目，复用：${existing.id}`);
    return existing;
  }
  const created = await post('/api/projects', {
    name: PROJECT_NAME,
    description: '自动充氮控制状态机（路线 A′）：决策表 A/B + 规则流；阈值比较由仓端中控预处理为布尔信号；运行时由业务应用直连 RES 执行。BOM 独立，与 CEP 告警项目无共享。',
    icon: 'warehouse',
    engine: 'rules',
  });
  log(`创建项目：${created.id}`);
  return created;
}

/**
 * GET /api/projects/:id/bom 返回的是**投影**（factTypes[]），不是持久化形态。
 * 持久化形态是 flat fields[]（kind/enum/required...），投影用 direction/runtimeType。
 * 这里把两边都归一到同一组 key 再比较，避免"看起来一样"导致的反复重写（版本号狂涨）。
 */
function canonicalField(f) {
  const enumValues = Array.isArray(f.enum) ? [...f.enum].sort() : null;
  // 投影里的 type 是展示类型（Enum/Decimal），持久化里是运行时类型（String/Double）
  const runtimeType = f.type === 'Enum' ? 'String' : f.type === 'Decimal' ? 'Double' : f.type;
  // 只比较影响规则语义的部分；group/control/factTypeLabel 是展示属性，且投影不返回
  return JSON.stringify({
    key: f.key,
    label: f.label,
    kind: f.kind ?? f.direction,
    runtimeType,
    min: f.min ?? null,
    max: f.max ?? null,
    enum: enumValues,
  });
}

const bomFingerprint = fields => JSON.stringify(
  [...fields].map(canonicalField).sort(),
);

/** 从 BOM 投影（factTypes[]）取出全部字段的平铺形态 */
function fieldsFromProjection(projection) {
  const factTypes = projection?.factTypes;
  if (!Array.isArray(factTypes)) return null;
  return factTypes.flatMap(factType => (factType.fields || []).map(f => ({
    ...f,
    kind: f.direction ?? f.kind,
    factType: f.factType ?? factType.name,
  })));
}

async function ensureBom(projectId) {
  step('2. BOM');
  const projection = await get(`/api/projects/${projectId}/bom`);
  const currentVersion = projection?.version ?? 1;
  const currentFields = fieldsFromProjection(projection) || [];
  if (currentFields.length && bomFingerprint(currentFields) === bomFingerprint(BOM.fields)) {
    log(`BOM 已是目标结构（v${currentVersion}，${currentFields.length} 字段），跳过写入`);
    return { version: currentVersion, changed: false };
  }
  const result = await put(`/api/projects/${projectId}/bom`, {
    version: currentVersion,
    fields: BOM.fields,
    eventTypes: [],
    acknowledgeImpact: true,
  });
  const nextVersion = (result?.bom || result)?.version;
  const warnings = result?.warnings || [];
  log(`BOM 写入完成 → v${nextVersion}（${BOM.fields.filter(f => f.kind === 'input').length} 入参 / ${BOM.fields.filter(f => f.kind === 'output').length} 出参）`);
  if (warnings.length) log(`  影响分析提示 ${warnings.length} 条（已 acknowledgeImpact）`);
  return { version: nextVersion, changed: true };
}

async function listAssets(projectId) {
  return await get(`/api/projects/${projectId}/rules`);
}

/**
 * 已发布资产改内容后需要重新走变更集。把 revision 归 1，保证后续新建的变更集
 * 一定盯住**当前草稿**（否则旧变更集快照会让 diff 变成 0，提交时报"没有实际差异"）。
 * 归 1 通过一次空变更集（提交→驳回）实现：驳回不发布，只推进修订号。
 */
async function resetRevision(projectId, assetId, revision, type, label) {
  let changeSet;
  try {
    changeSet = await post(`/api/projects/${projectId}/change-sets`, {
      name: `修订号复位：${label}`,
      description: '种子脚本内部使用：推进资产修订号，使后续发布变更集盯住最新草稿',
      items: [{ type, id: assetId, revision }],
    });
  } catch (error) {
    log(`    （变更集创建跳过：${error.message}）`);
    return;
  }
  const changeCount = (changeSet.items || []).reduce((sum, item) => sum + (item.changes || []).length, 0);
  if (changeCount === 0) {
    // 内容与已发布版本一致，没有可评审的差异；此时无需复位修订号，
    // 重新发布由 publish 接口直接完成（它会基于当前草稿再写一个新版本）。
    log('    （内容与已发布版本一致，无需复位修订号）');
    return;
  }
  await post(`/api/projects/${projectId}/change-sets/${changeSet.id}/submit`, { revision: changeSet.revision });
  await post(`/api/projects/${projectId}/change-sets/${changeSet.id}/reject`, {
    revision: changeSet.revision + 1,
    comment: '种子脚本：修订号复位（不发布，仅推进修订号）',
  });
}

/**
 * 修订号复位会把资产状态打回 draft（因为项目级 change-set 的 publishOnApprove 会先标 draft）。
 * 草稿内容与最后一次发布版本一致时不得复位，否则会出现"内容没变却变成草稿"的坏状态。
 */
function draftMatchesLastVersion(detail) {
  const latest = (detail.versions || []).at(-1);
  if (!latest) return false;
  return tableContentKey(latest.draft || {}) === tableContentKey(detail.draft || {});
}

/** 直接发布资产草稿（脚本内部使用；页面上对应「提交审核 → 批准并发布」） */
async function publishAsset(projectId, assetId, revision, label) {
  await post(`/api/projects/${projectId}/rules/${assetId}/publish`, { revision });
  const after = await get(`/api/projects/${projectId}/rules/${assetId}`);
  log(`    「${label}」→ ${after.status} v${after.version}`);
  return after;
}

/**
 * 让资产处于「已发布 + 产物 BOM 与当前 BOM 一致」状态。
 * 三种情况：
 *   a) 未发布 → 直接发布当前草稿
 *   b) 已发布但产物冻结的是旧 BOM → 复位修订号后重新发布（平台要求，否则规则流拒绝编译）
 *   c) 已发布且 BOM 对齐 → 什么都不做（幂等）
 */
async function ensurePublished(projectId, asset, label) {
  const detail = await get(`/api/projects/${projectId}/rules/${asset.assetId}`);
  const currentBomVersion = (await get(`/api/projects/${projectId}/bom`))?.version;
  const pinned = detail.publishedBomVersion ?? null;

  if (detail.status !== 'published') {
    const published = await publishAsset(projectId, asset.assetId, detail.revision, label);
    return { status: published.status, revision: published.revision };
  }
  if (pinned != null && currentBomVersion != null && pinned !== currentBomVersion) {
    await resetRevision(projectId, asset.assetId, detail.revision, 'table', label);
    const refreshed = await get(`/api/projects/${projectId}/rules/${asset.assetId}`);
    const published = await publishAsset(projectId, asset.assetId, refreshed.revision, label);
    log(`    已重新发布以对齐 BOM v${currentBomVersion}（原冻结 v${pinned}）`);
    return { status: published.status, revision: published.revision };
  }
  log(`  「${label}」已发布且 BOM 对齐，跳过`);
  return { status: detail.status, revision: detail.revision };
}

function tableContentKey(draft) {
  return JSON.stringify({
    name: draft.name,
    description: draft.description ?? '',
    category: draft.category ?? '',
    priority: draft.priority ?? 0,
    hitPolicy: draft.hitPolicy ?? 'FIRST',
    conditions: (draft.conditions || []).map(c => ({ field: c.field, operator: c.operator })),
    actions: (draft.actions || []).map(a => ({ field: a.field })),
    rows: (draft.rows || []).map(r => ({
      enabled: r.enabled !== false,
      isDefault: r.isDefault === true,
      conditions: (r.conditions || []).map(c => String(c ?? '')),
      actions: (r.actions || []).map(a => String(a ?? '')),
    })),
  });
}

function desiredTableContentKey(definition) {
  return tableContentKey({
    name: definition.name,
    description: definition.description,
    category: definition.category ?? PACKAGE,
    priority: definition.priority,
    hitPolicy: definition.hitPolicy,
    conditions: definition.conditions,
    actions: definition.actions,
    rows: definition.rows,
  });
}

async function ensureTable(projectId, definition) {
  const assets = await listAssets(projectId);
  const existing = assets.find(a => a.name === definition.name);
  let assetId;
  if (existing) {
    assetId = existing.id;
    log(`  决策表「${definition.name}」已存在（${assetId}）`);
  } else {
    const created = await post(`/api/projects/${projectId}/rules`, {
      type: 'decision-table',
      name: definition.name,
      category: PACKAGE,
      conditionFields: definition.conditions.map(c => c.field),
      actionFields: definition.actions.map(a => a.field),
      hitPolicy: definition.hitPolicy,
    });
    assetId = created.id ?? created.asset?.id;
    log(`  创建决策表「${definition.name}」：${assetId}`);
  }
  const detail = await get(`/api/projects/${projectId}/rules/${assetId}`);
  let revision = detail.revision ?? 1;
  const desired = desiredTableContentKey(definition);
  const draftMatches = tableContentKey(detail.draft || {}) === desired;
  let status = detail.status;

  if (!draftMatches) {
    // 内容有变化：写草稿 → 校验 → 复位修订号（让后续变更集盯住最新草稿）→ 发布
    const saved = await put(`/api/projects/${projectId}/rules/${assetId}`, {
      revision,
      draft: {
        name: definition.name,
        description: definition.description,
        category: PACKAGE,
        priority: definition.priority,
        hitPolicy: definition.hitPolicy,
        conditions: definition.conditions,
        actions: definition.actions,
        rows: definition.rows,
      },
    });
    revision = saved.revision ?? revision + 1;
    log(`    草稿已保存（revision → ${revision}）`);
    const analyzed = await post(`/api/projects/${projectId}/rules/${assetId}/analyze`, {
      revision,
      draft: saved.draft ?? saved.asset?.draft,
    });
    if (analyzed?.error) throw new Error(`决策表「${definition.name}」校验失败：${analyzed.error}`);
    const warnings = analyzed?.warnings || [];
    log(`    校验通过${warnings.length ? `，${warnings.length} 条提示：` : ''}`);
    for (const w of warnings) log(`      · ${w}`);
    if (status === 'published' && revision > 1) {
      await resetRevision(projectId, assetId, revision, 'table', definition.name);
      revision = 1;
      log('    修订号已复位（已发布资产改内容后需重新走变更集）');
    }
  } else {
    log('    内容与目标一致，跳过保存');
    const analyzed = await post(`/api/projects/${projectId}/rules/${assetId}/analyze`, { revision, draft: detail.draft });
    if (analyzed?.error) throw new Error(`决策表「${definition.name}」校验失败：${analyzed.error}`);
  }

  // 发布动作统一交给 ensurePublished（在 main 的发布阶段执行）
  return { assetId, revision, status, draft: detail.draft };
}

async function main() {
  log(`Team Server: ${RTS_URL}${DRY_RUN ? '（DRY-RUN）' : ''}`);
  const session = DRY_RUN ? null : await get('/api/session');
  if (session) log(`身份：${session.id}（${session.mode}）roles=${(session.roles || []).join(',')}`);

  const project = await ensureProject();
  const projectId = project.id;
  if (DRY_RUN) {
    log('\n[DRY-RUN] 后续 payload 预览（BOM 与三个决策表）：');
    log(`\n--- BOM (${BOM.fields.filter(f => f.kind === 'input').length} 入参 / ${BOM.fields.filter(f => f.kind === 'output').length} 出参) ---`);
    for (const f of BOM.fields) log(`  ${f.kind === 'input' ? '入' : '出'}  ${f.key.padEnd(16)} ${f.type.padEnd(8)} ${f.enum ? `enum=[${f.enum.join('/')}]` : ''}`);
    for (const def of [TABLE_A, TABLE_B, TABLE_B2]) {
      log(`\n--- 决策表：${def.name}（${def.rows.length} 行）---`);
      log(`  条件列: ${def.conditions.map(c => c.field).join(' | ')}`);
      log(`  动作列: ${def.actions.map(a => a.field).join(' | ')}`);
      for (const [i, row] of def.rows.entries()) {
        log(`  行${i + 1}  [${row.conditions.map(c => c || '∅').join(' | ')}]  →  [${row.actions.join(' | ')}]`);
      }
    }
    return;
  }

  await ensureBom(projectId);

  step('3. 决策表');
  const tableA = await ensureTable(projectId, TABLE_A);
  const tableB = await ensureTable(projectId, TABLE_B);
  const tables = [
    { label: '充氮状态迁移表', ...tableA },
    { label: '充氮结束处理表', ...tableB },
  ];

  step('4. 发布决策表（页面等价动作：提交审核 → 批准并发布）');
  for (const table of tables) {
    await ensurePublished(projectId, table, table.label);
  }

  step('5. 结果');
  const finalAssets = await listAssets(projectId);
  for (const asset of finalAssets) {
    log(`  ${String(asset.status).padEnd(10)} v${asset.version}  ${asset.name}  ${asset.id}`);
  }

  const expectedNames = ['充氮状态迁移表', '充氮结束处理表'];
  const allPublished = expectedNames.every(name => finalAssets.some(a => a.name === name && a.status === 'published'));
  const unexpected = finalAssets.filter(a => a.name.startsWith('充氮') && !expectedNames.includes(a.name));

  log(`\nSEED_RESULT=${JSON.stringify({ projectId, projectName: PROJECT_NAME, tables: { a: tableA.assetId, b: tableB.assetId }, allTablesPublished: allPublished })}`);
  if (unexpected.length) {
    log(`\n⚠ 存在本方案已废弃的资产（设备态已并入主表）：`);
    for (const a of unexpected) log(`    ${a.name}  ${a.id}`);
    log('  建议在页面归档，避免与主表产生两个设备态来源。');
  }
  if (allPublished) {
    log(`
  ▸ 下一步：node scripts/seed-nitrogen-flow.mjs
  ▸ 最后仍需人工在页面：发布规则流 → 创建 Release（门禁）→ 部署到 RES
`);
  }
}

/** 已发布且产物冻结的 BOM 版本与当前 BOM 一致 → 无需任何发布动作 */
async function isPublishedAndBomCurrent(projectId, assetId) {
  const detail = await get(`/api/projects/${projectId}/rules/${assetId}`);
  if (detail.status !== 'published') return false;
  const currentBomVersion = (await get(`/api/projects/${projectId}/bom`))?.version;
  const pinned = detail.publishedBomVersion;
  return pinned == null || currentBomVersion == null || pinned === currentBomVersion;
}

/**
 * 通过变更集把资产推过审核并发布（页面路径：提交审核 → 批准并发布）。
 * 目前主流程使用 ensurePublished（直接 publish 接口）；本函数保留给需要走审核链路的场景。
 */
async function publishViaChangeSet(projectId, table, type) {
  const detail = await get(`/api/projects/${projectId}/rules/${table.assetId}`);
  if (await isPublishedAndBomCurrent(projectId, table.assetId)) {
    log(`  「${table.label}」已发布且 BOM 对齐，跳过`);
    return;
  }
  const revision = detail.revision;
  let changeSet;
  try {
    changeSet = await post(`/api/projects/${projectId}/change-sets`, {
      name: `发布：${table.label}`,
      description: '种子脚本经变更集发布决策表（与页面审核流程一致）',
      items: [{ type, id: table.assetId, revision }],
    });
  } catch (error) {
    log(`  「${table.label}」跳过：${error.message}`);
    return;
  }
  const changeCount = (changeSet.items || []).reduce((sum, item) => sum + (item.changes || []).length, 0);
  if (changeCount === 0) {
    log(`  「${table.label}」草稿与已发布版本一致，无需发布（跳过）`);
    return;
  }
  await post(`/api/projects/${projectId}/change-sets/${changeSet.id}/submit`, { revision: changeSet.revision });
  await post(`/api/projects/${projectId}/change-sets/${changeSet.id}/approve`, { revision: changeSet.revision + 1 });
  const after = await get(`/api/projects/${projectId}/rules/${table.assetId}`);
  log(`  「${table.label}」→ ${after.status} v${after.version}`);
}

main().catch(error => {
  console.error(`\n✗ 种子失败：${error.message}`);
  process.exit(1);
});
