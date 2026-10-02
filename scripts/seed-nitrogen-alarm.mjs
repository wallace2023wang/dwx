#!/usr/bin/env node
/**
 * Layer C —— 安全告警事件流种子脚本（CEP / Esper）
 * ============================================================
 * 依据 docs/nitrogen-auto-fill-asset-design.md §6：
 *   CEP 只做"看得见、拦得住"，不参与状态迁移判定。
 *
 * 在现有 CEP 项目 project-7c12c971（粮库自动充氮控制）内新增一条独立事件流：
 *
 *   1. N2SafetyInterlock —— 浓度越安全上限 → 强制关充氮设备（联锁告警）
 *   2. N2SensorSilence   —— 采样静默（断流）检测
 *
 * 注意（两套 BOM 独立）：本事件流用的是 CEP 项目的 BOM（NitrogenReading），
 * 与控制链路（project-63dbe140，NitrogenControl）**没有任何共享字段**。
 * CEP 的 EPL 模板只支持数值字面量，因此安全上限在 EPL 里写死。
 *
 * 用法：
 *   node seed-nitrogen-alarm.mjs                        # 创建草稿并编译校验
 *   node seed-nitrogen-alarm.mjs --publish              # 同时发布
 *   node seed-nitrogen-alarm.mjs --project project-7c12c971
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const DEFAULT_PROJECT = 'project-7c12c971';
const argv = process.argv.slice(2);
const argProject = (() => { const i = argv.indexOf('--project'); return i >= 0 ? argv[i + 1] : DEFAULT_PROJECT; })();
const DO_PUBLISH = argv.includes('--publish');

const STREAM_NAME = '充氮安全告警（联锁 + 断流）';
const SAFETY_MAX_PCT = 99;      // 安全联锁上限（EPL 字面量；模板不支持字段引用）
const SILENCE_MINUTES = 2;      // 采样静默判定窗口

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

/** 只保留"安全告警"语句；不碰现有的阶段迁移语句（那属于另一个资产的决策，D4） */
function buildDraft() {
  return {
    name: STREAM_NAME,
    description:
      `充氮安全联锁与传感器断流检测（与控制链路解耦）。`
      + ` ①浓度 ≥ ${SAFETY_MAX_PCT}% 触发联锁告警，中控据此强制关制氮机与充氮阀；`
      + ` ②${SILENCE_MINUTES} 分钟内无采样事件视为断流。`
      + ` 阈值在 EPL 中以字面量给出——CEP 模板不支持字段引用；变更需重新发布。`,
    category: '充氮安全',
    statements: [
      {
        name: 'N2SafetyInterlock',
        label: '安全联锁：浓度越上限',
        description: `氮气浓度 ≥ ${SAFETY_MAX_PCT}% 时输出联锁告警，中控收到后强制关充氮设备`,
        enabled: true,
        mode: 'advanced',
        epl: `insert into N2SafetyInterlockEvent select warehouseId, nitrogenPct, readingTime from NitrogenReading where nitrogenPct >= ${SAFETY_MAX_PCT}`,
        output: ['warehouseId', 'nitrogenPct', 'readingTime'],
      },
      {
        name: 'N2SensorSilence',
        label: '断流检测：采样静默',
        description: `${SILENCE_MINUTES} 分钟内未收到 NitrogenReading 采样，判定断流`,
        enabled: true,
        mode: 'advanced',
        // timer:interval 必须挂在事件上（`timer:...` 不能裸用作 pattern 起点）。
        // 实测：`every (t=timer:interval(...) and not X())` 会报语法错误；
        // 正确形态是 `every (a=<事件> -> (timer:interval(...) and not <后续事件>))`。
        epl: `insert into N2SensorSilenceEvent select a.warehouseId as warehouseId, 'SILENCE' as status from pattern[every (a=NitrogenReading -> (timer:interval(${SILENCE_MINUTES} minutes) and not NitrogenReading(warehouseId = a.warehouseId)))]`,
        output: ['warehouseId', 'status'],
      },
    ],
  };
}

async function main() {
  log(`Team Server: ${RTS_URL}`);
  const projectId = argProject;
  const project = await get(`/api/projects/${projectId}`);
  log(`项目: ${project.name}（engine=${project.engine}）`);
  if (project.engine !== 'cep') throw new Error('目标项目不是 cep 引擎');

  const draft = buildDraft();
  const streams = await get(`/api/projects/${projectId}/event-streams`);
  const existing = streams.find(s => s.name === STREAM_NAME);

  let streamId;
  if (existing) {
    streamId = existing.id;
    log(`事件流已存在（${streamId}，revision ${existing.revision}）→ 覆盖草稿`);
    const detail = await get(`/api/projects/${projectId}/event-streams/${streamId}`);
    await put(`/api/projects/${projectId}/event-streams/${streamId}`, { revision: detail.revision, draft });
    log('  草稿已更新');
  } else {
    const created = await post(`/api/projects/${projectId}/event-streams`, { draft });
    streamId = created.id ?? created.eventStreamId;
    log(`创建事件流：${streamId}`);
  }

  // 真实 Esper 编译校验
  const detail = await get(`/api/projects/${projectId}/event-streams/${streamId}`);
  const compiled = await post(`/api/projects/${projectId}/event-streams/${streamId}/compile`, { revision: detail.revision });
  log(`编译：通过（Esper ${compiled?.version ?? compiled?.engineVersion ?? '8.8.0'}）`);
  for (const statement of compiled?.module?.statements || []) {
    log(`  · ${statement.name} → 输出 ${statement.outputEventType}`);
  }

  if (DO_PUBLISH) {
    const current = await get(`/api/projects/${projectId}/event-streams/${streamId}`);
    const published = await post(`/api/projects/${projectId}/event-streams/${streamId}/publish`, { revision: current.revision });
    log(`已发布：v${published.published?.number ?? published.version ?? '?'}`);
  } else {
    log('\n（未发布。加 --publish 可发布，或到页面操作）');
  }

  log(`\nALARM_RESULT=${JSON.stringify({ projectId, streamId, safetyMaxPct: SAFETY_MAX_PCT, silenceMinutes: SILENCE_MINUTES, published: DO_PUBLISH })}`);
}

main().catch(error => {
  console.error(`\n✗ 安全告警事件流种子失败：${error.message}`);
  process.exit(1);
});
