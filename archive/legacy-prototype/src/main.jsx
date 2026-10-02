import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Check,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Braces,
  ChevronLeft,
  CircleAlert,
  Clock3,
  CloudUpload,
  Copy,
  FileCode2,
  Filter,
  FlaskConical,
  GitBranch,
  LayoutList,
  PackageCheck,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Table2,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { generateDrl, operators, validateRule } from '../../../shared/rules.js';
import { flowSnapshot, hitPolicies, tableDrl, validateFlow, validateTable } from '../../../shared/assets.js';
import './style.css';

// BOM 在应用启动时从 /api/bom 加载；BOM 管理页保存后会重新赋值并触发重渲染。
let currentBomObj = { version: 0, fields: [] };
let inputFields = [];
let outputFields = [];
function applyBom(bom) {
  currentBomObj = bom;
  inputFields = bom.fields.filter(f => f.kind === 'input');
  outputFields = bom.fields.filter(f => f.kind === 'output');
}
const clone = value => structuredClone(value);
const fmt = iso => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(iso));
const kinds = {
  execute: { label: '设计试运行', one: '', Icon: Play },
  tests: { label: '测试套件', one: '', Icon: FlaskConical },
  releases: { label: '发布中心', one: '', Icon: PackageCheck },
  governance: { label: '变更治理', one: '', Icon: ShieldCheck },
  rules: { label: '规则管理', one: '规则', Icon: LayoutList },
  tables: { label: '决策表', one: '决策表', Icon: Table2 },
  flows: { label: '规则流', one: '规则流', Icon: Workflow },
  bom: { label: '字段模型', one: '字段', Icon: Braces },
};
const initialKind = () => {
  const requested = window.location.hash.slice(1);
  return requested in kinds ? requested : 'rules';
};

async function api(path, options) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.details = data;
    throw error;
  }
  return data;
}

function IconButton({ icon: Icon, label, ...props }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );
}

function ConflictNotice({ conflict, noun, onLoad }) {
  if (!conflict) return null;
  return (
    <div className="conflict-notice" role="alert">
      <CircleAlert size={17} />
      <div><b>{noun}已在服务器更新到 r{conflict.currentRevision}</b><small>当前本地编辑仍保留，载入服务器版本后才会替换。</small></div>
      <button className="secondary" onClick={onLoad}><RotateCcw size={15} />载入服务器版本</button>
    </div>
  );
}

function ValueInput({ field, value, onChange, allowEmpty = false, emptyLabel = '不限制', freeform = false }) {
  if (!field) return <input value={value || ''} onChange={event => onChange(event.target.value)} />;
  if (field.type === 'Boolean') {
    return (
      <select value={value} onChange={event => onChange(event.target.value)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  // 配置了枚举值域的 String 字段：下拉选择（自由填写区间/枚举语法时仍可手动输入）
  if (field.enum && !freeform) {
    return (
      <select value={value} onChange={event => onChange(event.target.value)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {field.enum.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={event => onChange(event.target.value)}
      type={freeform || field.type === 'String' ? 'text' : 'number'}
      step={field.type === 'Integer' ? '1' : 'any'}
      placeholder={allowEmpty ? emptyLabel : field.type === 'String' ? '输入文本' : '输入数值'}
    />
  );
}

function outputFacts(raw, fields = inputFields) {
  const facts = {};
  for (const field of fields) {
    const value = raw[field.key];
    if (value !== undefined && value !== '') {
      facts[field.key] = field.type === 'Boolean'
        ? value === 'true'
        : field.type === 'String'
          ? value
          : Number(value);
    }
  }
  return facts;
}

function FactForm({ facts, setFacts, fields = inputFields }) {
  return (
    <div className="form-grid">
      {fields.map(field => (
        <label key={field.key}>
          {field.label}
          {field.type === 'Boolean' ? (
            <select
              value={facts[field.key] ?? ''}
              onChange={event => setFacts({ ...facts, [field.key]: event.target.value })}
            >
              <option value="">未设置</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <input
              type={field.type === 'String' ? 'text' : 'number'}
              step={field.type === 'Integer' ? '1' : 'any'}
              value={facts[field.key] ?? ''}
              onChange={event => setFacts({ ...facts, [field.key]: event.target.value })}
              placeholder="未设置"
            />
          )}
        </label>
      ))}
    </div>
  );
}

function ExecuteView() {
  const [assets, setAssets] = useState({ rules: [], tables: [], flows: [] });
  const [target, setTarget] = useState(null); // {kind, id, name, version}
  const [facts, setFacts] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all(['rules', 'tables', 'flows'].map(n => api(`/${n}`)))
      .then(([rules, tables, flows]) => setAssets({ rules: rules.filter(a => a.published), tables: tables.filter(a => a.published), flows: flows.filter(a => a.published) }));
  }, []);

  async function run() {
    if (!target) return;
    setBusy(true); setResult(null);
    try {
      const body = { facts: outputFacts(facts), published: true };
      const res = await api(`/${target.kind}/${target.id}/test`, { method: 'POST', body: JSON.stringify(body) });
      setResult(res);
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  }

  return (
    <div className="execute-view">
      <div className="section-heading"><span className="section-index">T</span><div><h3>设计期试运行</h3><p>直接验证 Team Server 中的已发布资产；这里不代表已经部署到 RES。</p></div></div>
      <div className="execute-layout">
        <div className="execute-left">
          <h4>选择规则资产</h4>
          <div className="execute-asset-list">
            {[...assets.flows.map(a => ({ kind: 'flows', id: a.id, name: a.draft.name, v: a.versions.at(-1)?.number, isFlow: true })),
              ...assets.tables.map(a => ({ kind: 'tables', id: a.id, name: a.draft.name, v: a.versions.at(-1)?.number })),
              ...assets.rules.map(a => ({ kind: 'rules', id: a.id, name: a.published.name, v: a.versions.at(-1)?.number }))]
              .map(a => (
              <button key={a.id} className={target?.id === a.id ? 'active' : ''} onClick={() => { setTarget(a); setResult(null); }}>
                <small style={{ color: a.isFlow ? '#8b5cf6' : a.kind === 'tables' ? '#3b82f6' : '#218a79' }}>{a.isFlow ? '规则流' : a.kind === 'tables' ? '决策表' : '规则'}</small> {a.name} <em>v{a.v}</em>
              </button>
            ))}
            {!assets.tables.length && !assets.rules.length && !assets.flows.length && <p style={{color:'#888'}}>暂无已发布资产</p>}
          </div>
        </div>
        <div className="execute-right">
          <h4>输入客户数据</h4>
          <FactForm facts={facts} setFacts={f => { setFacts(f); setResult(null); }} />
          <button className="primary" onClick={run} disabled={!target || busy}>
            <Play size={16} /> {busy ? '执行中...' : '执行规则'}
          </button>
          {result && (
            result.error ? <div className="validation"><CircleAlert size={17} />{result.error}</div>
            : <div className="test-result">
                <h3>{result.count ? `命中 ${result.count} 条规则` : '未命中规则'}</h3>
                {result.fired?.length > 0 && <p>命中：{result.fired.join('、')}</p>}
                {result.trace && result.trace.length > 0 && (
                  <div style={{ margin: '12px 0', padding: '12px', background: '#f6f9f8', borderRadius: 6 }}>
                    <h4 style={{ marginBottom: 8 }}>执行轨迹（{result.trace.length} 步）</h4>
                    {result.trace.map((t, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '6px 8px', borderLeft: '3px solid #218a79', marginBottom: 4, background: '#fff' }}>
                        <b>{t.type === 'gateway' ? '条件网关' : `步骤${i+1}`}</b> · {t.type === 'gateway' ? (t.branchName ? `进入${t.branchName}${t.default ? '（默认）' : ''}` : '无匹配路径') : t.name} <small style={{color:'#888'}}>{t.type === 'gateway' ? '(exclusive)' : `(${t.type} v${t.version})`}</small>
                        {t.type !== 'gateway' && <><br/>命中 {t.count} 条 · 输出：{Object.entries(t.facts).filter(([k,v]) => !inputFields.some(f => f.key === k)).map(([k,v]) => `${k}=${v}`).join(', ')}<MappingTrace mappings={t.mappings} /></>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="execute-output">
                  <h4>决策结果</h4>
                  {outputFields.map(f => (
                    <div key={f.key} className="output-row"><span>{f.label}</span><b>{result.facts[f.key] ?? '—'}</b></div>
                  ))}
                </div>
              </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QualityGateSummary({ gate, reports, failure = false }) {
  if (!gate) return null;
  return <div className={`quality-gate ${gate.passed && !failure ? 'passed' : 'failed'}`}>
    <div className="quality-gate-head"><PackageCheck size={16} /><div><b>{gate.passed && !failure ? '发布门禁通过' : '发布门禁未通过'}</b><small>{gate.suites.length ? `${gate.suites.length} 个必需测试套件` : '没有关联的必需测试套件'}</small></div></div>
    {gate.suites.map(suite => {
      const report = reports?.find(item => item.suiteId === suite.id || item.id === suite.runId);
      return <div className="quality-gate-suite" key={suite.runId || suite.id}><span>{suite.passed ? '通过' : '失败'}</span><div><b>{suite.name}</b><small>资产 v{suite.targetVersion} · {suite.passedCount}/{suite.total} 个案例通过{report?.error ? ` · ${report.error}` : ''}</small></div></div>;
    })}
  </div>;
}

function ReleaseView() {
  const [releases, setReleases] = useState([]);
  const [assets, setAssets] = useState({ rules: [], tables: [], flows: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [target, setTarget] = useState('');
  const [decisionService, setDecisionService] = useState('default/customer-risk');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [facts, setFacts] = useState({});
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState('');
  const [gateFailure, setGateFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  const sources = useMemo(() => [
    ...assets.flows.filter(item => item.published).map(item => ({ type: 'flow', id: item.id, label: '规则流', name: item.published.name, version: item.versions.at(-1)?.number })),
    ...assets.tables.filter(item => item.published).map(item => ({ type: 'table', id: item.id, label: '决策表', name: item.published.name, version: item.versions.at(-1)?.number })),
    ...assets.rules.filter(item => item.published).map(item => ({ type: 'rule', id: item.id, label: '规则', name: item.published.name, version: item.versions.at(-1)?.number })),
  ], [assets]);
  const selected = releases.find(item => item.id === selectedId) || releases[0] || null;
  const selectedInputFields = selected?.model?.fields?.filter(field => field.kind === 'input') || inputFields;
  const selectedOutputFields = selected?.model?.fields?.filter(field => field.kind === 'output') || outputFields;
  const routedSteps = new Map((selected?.routing?.branches || []).flatMap(branch => branch.stepIndexes.map(index => [index, branch])));

  useEffect(() => {
    Promise.all([api('/releases'), ...['rules', 'tables', 'flows'].map(kind => api(`/${kind}`))])
      .then(([loadedReleases, rules, tables, flows]) => {
        setReleases(loadedReleases);
        setAssets({ rules, tables, flows });
        if (loadedReleases.length) setSelectedId(loadedReleases[0].id);
      })
      .catch(error => setNotice(error.message));
  }, []);

  function chooseTarget(value) {
    setTarget(value);
    setGateFailure(null);
    const [type, id] = value.split(':');
    const source = sources.find(item => item.type === type && item.id === id);
    if (source) setName(source.name);
  }

  async function perform(operation) {
    setBusy(true);
    setNotice('');
    try { await operation(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  function createRelease() {
    if (!target || !name.trim()) return;
    perform(async () => {
      const [type, id] = target.split(':');
      let created;
      try {
        created = await api('/releases', {
          method: 'POST',
          body: JSON.stringify({ decisionService, name, description, target: { type, id } }),
        });
      } catch (error) {
        if (error.details?.gate) setGateFailure(error.details);
        throw error;
      }
      setGateFailure(null);
      setReleases(previous => [created, ...previous]);
      setSelectedId(created.id);
      setFacts({});
      setResult(null);
      setDescription('');
      setNotice(`已创建 ${created.decisionService} v${created.version}`);
    });
  }

  function deployRelease() {
    if (!selected) return;
    perform(async () => {
      const updated = await api(`/releases/${selected.id}/deploy`, { method: 'POST', body: JSON.stringify({ environment: 'local' }) });
      setReleases(previous => previous.map(item => item.id === updated.id ? updated : item));
      setNotice(`v${updated.version} 已部署到本地 RES`);
    });
  }

  function executeRelease() {
    if (!selected) return;
    perform(async () => {
      setResult(null);
      const executed = await api(`/releases/${selected.id}/execute`, {
        method: 'POST', body: JSON.stringify({ facts: outputFacts(facts, selectedInputFields) }),
      });
      setResult(executed);
    });
  }

  return (
    <div className="release-view">
      <div className="section-heading release-heading">
        <span className="section-index"><PackageCheck size={16} /></span>
        <div><h3>发布中心</h3><p>不可变 Release · 独立 Drools RES</p></div>
      </div>
      {notice && <div className={`notice ${notice.includes('已') ? 'success' : ''}`}><CircleAlert size={16} />{notice}<IconButton icon={X} label="关闭提示" onClick={() => setNotice('')} /></div>}
      <section className="release-create">
        <div className="release-section-title"><h4>创建发布包</h4><span>发布不会自动改变生产流量</span></div>
        <div className="release-form">
          <label>决策服务标识<input value={decisionService} onChange={event => setDecisionService(event.target.value)} /></label>
          <label>来源资产<select value={target} onChange={event => chooseTarget(event.target.value)}><option value="">选择已发布资产</option>{sources.map(source => <option key={`${source.type}:${source.id}`} value={`${source.type}:${source.id}`}>[{source.label}] {source.name} · v{source.version}</option>)}</select></label>
          <label>发布名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
          <label>发布说明<input value={description} maxLength={500} onChange={event => setDescription(event.target.value)} placeholder="本次策略变化" /></label>
          <button className="primary" onClick={createRelease} disabled={busy || !target || !name.trim()}><PackageCheck size={16} />生成 Release</button>
        </div>
      </section>
      <QualityGateSummary gate={gateFailure?.gate} reports={gateFailure?.reports} failure />
      <div className="release-layout">
        <section className="release-list">
          <div className="release-section-title"><h4>发布记录</h4><span>{releases.length} 个</span></div>
          {releases.map(release => (
            <button key={release.id} className={selected?.id === release.id ? 'selected' : ''} onClick={() => { setSelectedId(release.id); setFacts({}); setResult(null); }}>
              <span className={`status-dot ${release.deployments?.length ? 'live' : ''}`} />
              <span><b>{release.name}</b><small>{release.decisionService} · v{release.version}</small></span>
              <em>{release.deployments?.length ? '已部署' : '未部署'}</em>
            </button>
          ))}
          {!releases.length && <div className="list-empty">尚无发布包</div>}
        </section>
        <section className="release-detail">
          {!selected ? <div className="list-empty">创建或选择一个发布包</div> : <>
            <div className="release-detail-head">
              <div><span className="eyebrow">{selected.decisionService} · v{selected.version}</span><h2>{selected.name}</h2><p>{selected.description || '暂无发布说明'}</p></div>
              <button className="primary" onClick={deployRelease} disabled={busy}><Rocket size={16} />{selected.deployments?.length ? '重新确认部署' : '部署到 RES'}</button>
            </div>
            <dl className="release-meta">
              <div><dt>Release ID</dt><dd>{selected.id}</dd></div>
              <div><dt>内容校验和</dt><dd title={selected.checksum}>{selected.checksum}</dd></div>
              <div><dt>Drools</dt><dd>{selected.engine.drools}</dd></div>
              <div><dt>字段模型</dt><dd>{selected.model?.version ? `BOM v${selected.model.version} · ${selected.model.fields.length} 个字段` : 'Legacy · 未绑定'}</dd></div>
              <div><dt>执行步骤</dt><dd>{selected.steps.length}</dd></div>
              <div><dt>创建时间</dt><dd>{fmt(selected.createdAt)}</dd></div>
              <div><dt>部署状态</dt><dd>{selected.deployments?.length ? `local · ${fmt(selected.deployments.at(-1).deployedAt)}` : '尚未部署'}</dd></div>
            </dl>
            <QualityGateSummary gate={selected.qualityGate} />
            <div className="release-steps">
              <h4>冻结的执行步骤</h4>
              {selected.steps.map((step, index) => {
                const mappingCount = (step.inputMappings?.length || 0) + (step.outputMappings?.length || 0);
                return <div key={`${step.assetId}-${index}`}><span>{index + 1}</span><b>{step.name}</b><small>{step.type === 'table' ? '决策表' : '规则'} · 资产 v{step.assetVersion}{routedSteps.has(index) ? ` · ${routedSteps.get(index).name}${routedSteps.get(index).default ? '（默认）' : ''}` : ''}{mappingCount ? ` · ${mappingCount} 项字段映射` : ''}</small></div>;
              })}
            </div>
            <div className="release-test">
              <div className="release-section-title"><h4>RES 部署验证</h4><span>按 Release ID 执行</span></div>
              <FactForm facts={facts} fields={selectedInputFields} setFacts={next => { setFacts(next); setResult(null); }} />
              <button className="secondary" onClick={executeRelease} disabled={busy || !selected.deployments?.length}><Play size={16} />执行已部署版本</button>
              {result?.error ? <div className="validation"><CircleAlert size={17} />{result.error}</div> : <Result result={result} flow fields={selectedOutputFields} />}
            </div>
          </>}
        </section>
      </div>
    </div>
  );
}

function TestSuitesView() {
  const [suites, setSuites] = useState([]);
  const [assets, setAssets] = useState({ rules: [], tables: [], flows: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [report, setReport] = useState(null);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);

  const sources = useMemo(() => [
    ...assets.flows.filter(item => item.published).map(item => ({ type: 'flow', id: item.id, label: '规则流', name: item.published.name, version: item.versions.at(-1)?.number, bom: item.published.bom || item.versions.at(-1)?.bom, branches: item.published.branches || [] })),
    ...assets.tables.filter(item => item.published).map(item => ({ type: 'table', id: item.id, label: '决策表', name: item.published.name, version: item.versions.at(-1)?.number, bom: item.versions.at(-1)?.bom })),
    ...assets.rules.filter(item => item.published).map(item => ({ type: 'rule', id: item.id, label: '规则', name: item.published.name, version: item.versions.at(-1)?.number, bom: item.versions.at(-1)?.bom })),
  ], [assets]);
  const source = sources.find(item => item.type === draft?.target.type && item.id === draft?.target.id);
  const bom = source?.bom || currentBomObj;
  const suiteInputs = bom.fields?.filter(field => field.kind === 'input') || [];
  const suiteOutputs = bom.fields?.filter(field => field.kind === 'output') || [];

  useEffect(() => {
    Promise.all([api('/test-suites'), ...['rules', 'tables', 'flows'].map(kind => api(`/${kind}`))])
      .then(([loaded, rules, tables, flows]) => {
        setSuites(loaded);
        setAssets({ rules, tables, flows });
        if (loaded.length) {
          setSelectedId(loaded[0].id);
          setDraft(clone(loaded[0]));
          setReport(loaded[0].lastRun);
        }
      })
      .catch(error => setNotice(error.message));
  }, []);

  const selectSuite = suite => {
    setSelectedId(suite.id);
    setDraft(clone(suite));
    setReport(suite.lastRun);
    setNotice('');
    setConflict(null);
  };
  const newCase = targetType => ({
    id: crypto.randomUUID(), name: '未命名案例', enabled: true, facts: {},
    expected: { outputs: {}, fired: [], ...(targetType === 'flow' ? {} : {}) },
  });
  const createSuite = () => {
    if (!sources.length) return setNotice('请先发布至少一个规则资产');
    const first = sources[0];
    setSelectedId(null);
    setDraft({
      name: '未命名测试套件', description: '', target: { type: first.type, id: first.id }, required: true,
      cases: [newCase(first.type)],
    });
    setReport(null);
    setNotice('');
    setConflict(null);
  };
  const updateCase = (index, changes) => setDraft(previous => ({
    ...previous,
    cases: previous.cases.map((testCase, caseIndex) => caseIndex === index ? { ...testCase, ...changes } : testCase),
  }));
  const serialize = value => ({
    revision: value.revision, name: value.name, description: value.description, target: value.target, required: value.required,
    cases: value.cases.map(testCase => ({
      ...testCase,
      facts: outputFacts(testCase.facts, suiteInputs),
      expected: { ...testCase.expected, outputs: outputFacts(testCase.expected.outputs, suiteOutputs) },
    })),
  });
  const replaceSuite = updated => setSuites(previous => [updated, ...previous.filter(item => item.id !== updated.id)]);
  async function perform(operation) {
    setBusy(true);
    setNotice('');
    try { await operation(); } catch (error) {
      if (error.details?.current && error.details?.currentRevision) setConflict(error.details);
      else setNotice(error.message);
    } finally { setBusy(false); }
  }
  const save = () => perform(async () => {
    const saved = await api(selectedId ? `/test-suites/${selectedId}` : '/test-suites', {
      method: selectedId ? 'PUT' : 'POST', body: JSON.stringify(serialize(draft)),
    });
    replaceSuite(saved);
    setSelectedId(saved.id);
    setDraft(clone(saved));
    setReport(saved.lastRun);
    setConflict(null);
    setNotice('测试套件已保存');
  });
  const runSuite = () => {
    if (!selectedId) return setNotice('请先保存测试套件');
    perform(async () => {
      const result = await api(`/test-suites/${selectedId}/run`, { method: 'POST' });
      replaceSuite(result.suite);
      setDraft(clone(result.suite));
      setReport(result.report);
      setNotice(result.report.passed ? '回归测试已通过' : '回归测试未通过');
    });
  };
  const runAll = () => perform(async () => {
    const result = await api('/test-suites/run', { method: 'POST' });
    const loaded = await api('/test-suites');
    setSuites(loaded);
    const selected = loaded.find(item => item.id === selectedId);
    if (selected) { setDraft(clone(selected)); setReport(selected.lastRun); }
    setNotice(`全量回归：${result.passedCount}/${result.total} 个套件通过`);
  });
  const archive = () => {
    if (!selectedId || !window.confirm('确认归档这个测试套件？')) return;
    perform(async () => {
      await api(`/test-suites/${selectedId}/archive`, { method: 'POST', body: JSON.stringify({ revision: draft.revision }) });
      const remaining = suites.filter(item => item.id !== selectedId);
      setSuites(remaining);
      setSelectedId(remaining[0]?.id || null);
      setDraft(remaining[0] ? clone(remaining[0]) : null);
      setReport(remaining[0]?.lastRun || null);
      setNotice('测试套件已归档');
    });
  };

  return (
    <div className="suite-view">
      <div className="section-heading suite-heading">
        <span className="section-index"><FlaskConical size={16} /></span>
        <div><h3>测试套件</h3><p>批量验证已发布资产，并将必需套件作为 Release 发布门禁。</p></div>
        <div className="suite-heading-actions"><button className="secondary" onClick={runAll} disabled={busy || !suites.length}><Play size={15} />全量回归</button><button className="primary" onClick={createSuite} disabled={busy || !sources.length}><Plus size={15} />新建套件</button></div>
      </div>
      {notice && <div className={`notice ${notice.includes('通过') || notice.includes('已保存') ? 'success' : ''}`}><CircleAlert size={16} />{notice}<IconButton icon={X} label="关闭提示" onClick={() => setNotice('')} /></div>}
      <ConflictNotice conflict={conflict} noun="测试套件" onLoad={() => {
        replaceSuite(conflict.current);
        setDraft(clone(conflict.current));
        setReport(conflict.current.lastRun);
        setConflict(null);
        setNotice('已载入服务器版本');
      }} />
      <div className="suite-layout">
        <section className="suite-list">
          <div className="release-section-title"><h4>回归套件</h4><span>{suites.length} 个</span></div>
          {suites.map(suite => {
            const stale = suite.lastRun && sources.find(item => item.type === suite.target.type && item.id === suite.target.id)?.version !== suite.lastRun.targetVersion;
            return <button key={suite.id} className={selectedId === suite.id ? 'selected' : ''} onClick={() => selectSuite(suite)}>
              <span className={`suite-status ${suite.lastRun?.passed && !stale ? 'passed' : suite.lastRun ? 'failed' : ''}`} />
              <span><b>{suite.name}</b><small>{suite.required ? '发布必需' : '普通回归'} · {suite.cases.filter(testCase => testCase.enabled).length} 个案例</small></span>
              <em>{stale ? '待重跑' : suite.lastRun ? suite.lastRun.passed ? '通过' : '失败' : '未运行'}</em>
            </button>;
          })}
          {!suites.length && <div className="list-empty">尚无测试套件</div>}
        </section>
        <section className="suite-editor">
          {!draft ? <div className="list-empty">新建或选择一个测试套件</div> : <>
            <div className="suite-toolbar">
              <div><span className="eyebrow">{selectedId ? '编辑测试套件' : '新建测试套件'}</span><h2>{draft.name}</h2></div>
              <div>{selectedId && <IconButton icon={Archive} label="归档测试套件" onClick={archive} disabled={busy} />}<button className="secondary" onClick={save} disabled={busy}><Save size={15} />保存</button><button className="primary" onClick={runSuite} disabled={busy || !selectedId}><Play size={15} />运行套件</button></div>
            </div>
            <div className="suite-meta form-grid">
              <label>套件名称<input value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              <label>测试目标<select value={`${draft.target.type}:${draft.target.id}`} onChange={event => {
                const [type, id] = event.target.value.split(':');
                setDraft({ ...draft, target: { type, id }, cases: draft.cases.map(testCase => ({ ...testCase, facts: {}, expected: { outputs: {}, fired: [] } })) });
                setReport(null);
              }}>{sources.map(item => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>[{item.label}] {item.name} · v{item.version}</option>)}</select></label>
              <label className="full">说明<textarea rows="2" maxLength={500} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
              <label className="suite-required"><input type="checkbox" checked={draft.required} onChange={event => setDraft({ ...draft, required: event.target.checked })} /><span>作为 Release 发布必需门禁</span></label>
            </div>
            <div className="suite-cases-head"><div><h4>测试案例</h4><small>当前绑定已发布资产 v{source?.version || '-'}</small></div><button className="secondary" onClick={() => setDraft({ ...draft, cases: [...draft.cases, newCase(draft.target.type)] })} disabled={draft.cases.length >= 200}><Plus size={15} />添加案例</button></div>
            <div className="suite-cases">
              {draft.cases.map((testCase, index) => (
                <article className="suite-case" key={testCase.id}>
                  <header><span>{index + 1}</span><input value={testCase.name} maxLength={80} onChange={event => updateCase(index, { name: event.target.value })} /><label><input type="checkbox" checked={testCase.enabled} onChange={event => updateCase(index, { enabled: event.target.checked })} />启用</label><IconButton icon={Trash2} label="删除案例" onClick={() => setDraft({ ...draft, cases: draft.cases.filter((_, caseIndex) => caseIndex !== index) })} disabled={draft.cases.length <= 1} /></header>
                  <div className="suite-case-section"><h5>输入事实</h5><FactForm facts={testCase.facts} fields={suiteInputs} setFacts={facts => updateCase(index, { facts })} /></div>
                  <div className="suite-case-section"><h5>期望输出</h5><div className="suite-output-assertions">{suiteOutputs.map(field => {
                    const enabled = Object.prototype.hasOwnProperty.call(testCase.expected.outputs, field.key);
                    return <label key={field.key}><input type="checkbox" checked={enabled} onChange={event => {
                      const outputs = { ...testCase.expected.outputs };
                      if (event.target.checked) outputs[field.key] = field.type === 'Boolean' ? 'false' : field.enum?.[0] ?? '';
                      else delete outputs[field.key];
                      updateCase(index, { expected: { ...testCase.expected, outputs } });
                    }} /><span>{field.label}</span><ValueInput field={field} value={enabled ? String(testCase.expected.outputs[field.key]) : ''} allowEmpty onChange={value => updateCase(index, { expected: { ...testCase.expected, outputs: { ...testCase.expected.outputs, [field.key]: value } } })} /></label>;
                  })}</div></div>
                  <div className="suite-case-section suite-extra-assertions">
                    <label><span>期望命中规则（每行一个完整名称）</span><textarea rows="2" value={testCase.expected.fired.join('\n')} onChange={event => updateCase(index, { expected: { ...testCase.expected, fired: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) } })} placeholder="例如：高风险客户人工复核 [1]" /></label>
                    {draft.target.type === 'flow' && <label><span>期望流程路径</span><select value={testCase.expected.path === undefined ? '__skip__' : testCase.expected.path === null ? '__none__' : testCase.expected.path} onChange={event => {
                      const expected = { ...testCase.expected };
                      if (event.target.value === '__skip__') delete expected.path;
                      else expected.path = event.target.value === '__none__' ? null : event.target.value;
                      updateCase(index, { expected });
                    }}><option value="__skip__">不校验路径</option>{(source?.branches || []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}{branch.default ? '（默认）' : ''}</option>)}<option value="__none__">无匹配分支</option></select></label>}
                  </div>
                </article>
              ))}
            </div>
            {report && <div className="suite-report">
              <div className="suite-report-head"><div><h4>{report.passed ? '回归通过' : '回归失败'}</h4><small>资产 v{report.targetVersion || '-'} · {fmt(report.runAt)} · {report.durationMs} ms</small></div><strong>{report.passedCount}/{report.total}</strong></div>
              {report.error && <div className="validation"><CircleAlert size={16} />{report.error}</div>}
              {report.cases?.map(result => <div className={`suite-case-result ${result.passed ? 'passed' : 'failed'}`} key={result.id}><span>{result.passed ? '通过' : '失败'}</span><div><b>{result.name}</b><small>{result.error || result.assertions?.filter(assertion => !assertion.passed).map(assertion => assertion.type === 'output' ? `${assertion.label}：期望 ${String(assertion.expected)}，实际 ${String(assertion.actual)}` : assertion.type === 'fired' ? `未命中 ${assertion.expected}` : `期望路径 ${assertion.expected ?? '无'}，实际 ${assertion.actual ?? '无'}`).join('；') || '全部断言通过'}</small></div><em>{result.durationMs} ms</em></div>)}
            </div>}
          </>}
        </section>
      </div>
    </div>
  );
}

function DecisionTrace({ trace, hitPolicy }) {
  if (!trace?.length) return null;
  return (
    <div className="decision-trace">
      <div className="decision-trace-head">
        <b>决策表命中轨迹</b>
        <span>{hitPolicies.find(policy => policy.key === hitPolicy)?.label || hitPolicy}</span>
      </div>
      {trace.map(hit => (
        <div className="decision-trace-row" key={`${hit.order}:${hit.ruleName}`}>
          <span className="trace-order">{hit.order}</span>
          <div>
            <b>{hit.isDefault ? '默认行' : hit.rowIndex == null ? hit.ruleName : `第 ${hit.rowIndex + 1} 行`}</b>
            <small>{hit.actions.length ? hit.actions.map(action => {
              const field = outputFields.find(entry => entry.key === action.field);
              return action.overwritten
                ? `${field?.label || action.field}：${action.previousValue} -> ${action.value}（覆盖第 ${action.previousOrder} 次命中）`
                : `${field?.label || action.field}：设为 ${action.value}`;
            }).join('；') : '未找到该规则对应的决策行'}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function MappingTrace({ mappings }) {
  const entries = [
    ...(mappings?.inputs || []).map(mapping => ({ ...mapping, direction: '输入' })),
    ...(mappings?.outputs || []).map(mapping => ({ ...mapping, direction: '输出' })),
  ];
  if (!entries.length) return null;
  const label = key => [...inputFields, ...outputFields].find(field => field.key === key)?.label || key;
  return (
    <small className="trace-mappings">
      {entries.map(mapping => `${mapping.direction} ${label(mapping.source)} -> ${label(mapping.target)}：${mapping.applied ? String(mapping.value) : '源值为空'}`).join('；')}
    </small>
  );
}

function FlowDebugControls({ draft, assets, value, onChange }) {
  const assetName = step => {
    const collection = step.type === 'table' ? assets.tables : assets.rules;
    return collection.find(asset => asset.id === step.id)?.draft.name || '已失效引用';
  };
  const nodes = (draft.steps || []).map((step, index) => ({ id: `common:${index}`, label: `公共步骤 ${index + 1} · ${assetName(step)}` }));
  if (draft.branches?.length) {
    nodes.push({ id: 'gateway', label: '条件网关' });
    for (const branch of draft.branches) {
      branch.steps.forEach((step, index) => nodes.push({ id: `branch:${branch.id}:${index}`, label: `${branch.name} · 步骤 ${index + 1} · ${assetName(step)}` }));
    }
  }
  return (
    <div className="flow-debug-controls">
      <label><span>运行到节点</span><select value={value.stopAfter} onChange={event => onChange({ ...value, stopAfter: event.target.value })}><option value="">完整运行</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
      <label><span>期望路径</span><select value={value.expectedPath} onChange={event => onChange({ ...value, expectedPath: event.target.value })} disabled={!draft.branches?.length}><option value="">不校验</option>{(draft.branches || []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}{branch.default ? '（默认）' : ''}</option>)}<option value="__none__">无匹配分支</option></select></label>
    </div>
  );
}

function Result({ result, flow, fields = outputFields }) {
  if (!result) return null;
  const stoppedNode = result.debug?.stoppedAt && result.trace?.find(step => step.nodeId === result.debug.stoppedAt);
  return (
    <div className="test-result">
      <h3>
        {result.error
          ? `执行失败：${result.failedStep?.name || result.error}`
          : flow
          ? `完成 ${result.trace?.filter(step => step.type !== 'gateway').length || 0} 个步骤，共命中 ${result.count || 0} 条规则`
          : result.count
            ? `命中 ${result.count} 条规则`
            : '未命中规则'}
      </h3>
      {result.error && <div className="flow-failure"><CircleAlert size={17} /><div><b>{result.error}</b>{result.failedStep && <small>{result.failedStep.nodeId} · {result.failedStep.type === 'table' ? '决策表' : '规则'} · v{result.failedStep.version || result.failedStep.assetVersion || '-'}</small>}</div></div>}
      {result.debug?.stoppedAt && <div className="debug-stopped"><CircleAlert size={15} /><span>已暂停在 {stoppedNode?.name || result.debug.stoppedAt}<small>{result.debug.stoppedAt}</small></span></div>}
      {result.validationWarnings?.length > 0 && (
        <div className="analysis-warnings inline">
          <CircleAlert size={17} />
          <div><b>决策表分析</b>{result.validationWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
        </div>
      )}
      {result.assertions?.length > 0 && <div className="flow-assertions">{result.assertions.map((assertion, index) => <div className={assertion.passed ? 'passed' : 'failed'} key={`${assertion.type}-${index}`}><PackageCheck size={15} /><span>路径断言：期望 {assertion.expectedName || assertion.expected || '无匹配分支'}，实际 {assertion.evaluated ? assertion.actualName || assertion.actual || '无匹配分支' : '尚未执行到网关'}</span><b>{assertion.passed ? '通过' : '失败'}</b></div>)}</div>}
      {result.fired?.length > 0 && <p>命中：{result.fired.join('、')}</p>}
      <DecisionTrace trace={result.decisionTrace} hitPolicy={result.hitPolicy} />
      {flow && (
        <div className="flow-trace">
          {result.trace?.map((step, index) => (
            <div className={`trace-row ${step.type === 'gateway' ? 'gateway-trace' : ''}`} key={step.nodeId || `${step.name}-${index}`}>
              <span>{step.type === 'gateway' ? <GitBranch size={13} /> : index + 1}</span>
              <div>
                <b>{step.name}</b>
                <small>
                  {step.type === 'gateway'
                    ? step.branchName ? `进入 ${step.branchName}${step.default ? '（默认）' : ''}` : '没有匹配分支'
                    : `${step.type === 'table' ? '决策表' : '规则'} · v${step.version || step.assetVersion || '-'}${step.fired?.length > 0 ? ` · ${step.fired.join('、')}` : ''}`}
                </small>
                {step.type !== 'gateway' && <MappingTrace mappings={step.mappings} />}
              </div>
              <strong>{step.type === 'gateway' ? (step.branchName ? '已选择' : '未选择') : step.count ? `命中 ${step.count}` : '未命中'}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="result-grid">
        {fields.map(field => (
          <div key={field.key}>
            <span>{field.label}</span>
            <strong>
              {result.facts?.[field.key] == null
                ? '未赋值'
                : typeof result.facts[field.key] === 'boolean'
                  ? result.facts[field.key] ? '是' : '否'
                  : String(result.facts[field.key])}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metadata({ draft, update }) {
  return (
    <section className="editor-section">
      <div className="section-heading">
        <span className="section-index">01</span>
        <div>
          <h3>基本信息</h3>
          <p>用于识别、分类和安排资产执行顺序</p>
        </div>
      </div>
      <div className="form-grid">
        <label>
          名称
          <input value={draft.name} maxLength={80} onChange={event => update({ name: event.target.value })} />
        </label>
        {'category' in draft && (
          <label>
            业务分类
            <input value={draft.category} maxLength={40} onChange={event => update({ category: event.target.value })} />
          </label>
        )}
        <label className="full">
          说明
          <textarea
            value={draft.description}
            maxLength={500}
            rows="2"
            onChange={event => update({ description: event.target.value })}
            placeholder="简要描述适用的业务场景"
          />
        </label>
        {'priority' in draft && (
          <label>
            执行优先级
            <input
              type="number"
              min="-1000"
              max="1000"
              step="1"
              value={draft.priority}
              onChange={event => update({ priority: Number(event.target.value) })}
            />
            <small>数值越大，优先级越高</small>
          </label>
        )}
      </div>
    </section>
  );
}

function RuleEditor({ draft, update }) {
  const updateRow = (collection, index, changes) => update({
    [collection]: draft[collection].map((row, i) => i === index ? { ...row, ...changes } : row),
  });
  const remove = (collection, index) => update({
    [collection]: draft[collection].filter((_, i) => i !== index),
  });

  return (
    <div className="editor-body">
      <Metadata draft={draft} update={update} />
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-index">02</span>
          <div><h3>匹配条件</h3><p>全部条件同时满足时执行动作（AND）</p></div>
        </div>
        <div className="row-head condition-grid"><span>业务字段</span><span>比较方式</span><span>比较值</span></div>
        {draft.conditions.map((condition, index) => {
          const field = inputFields.find(entry => entry.key === condition.field) || inputFields[0];
          return (
            <div className="condition-grid edit-row" key={index}>
              <select
                value={condition.field}
                onChange={event => {
                  const next = inputFields.find(entry => entry.key === event.target.value);
                  updateRow('conditions', index, {
                    field: next.key,
                    operator: '==',
                    value: next.type === 'Boolean' ? 'true' : '',
                  });
                }}
              >
                {inputFields.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </select>
              <select value={condition.operator} onChange={event => updateRow('conditions', index, { operator: event.target.value })}>
                {operators.filter(operator => field.type !== 'Boolean' || ['==', '!='].includes(operator.key))
                  .map(operator => <option key={operator.key} value={operator.key}>{operator.label}</option>)}
              </select>
              <ValueInput field={field} value={condition.value} onChange={value => updateRow('conditions', index, { value })} />
              <IconButton icon={Trash2} label="删除条件" onClick={() => remove('conditions', index)} disabled={draft.conditions.length === 1} />
            </div>
          );
        })}
        <button className="add-row" onClick={() => update({ conditions: [...draft.conditions, { field: 'customerAge', operator: '>=', value: '18' }] })}>
          <Plus size={16} />添加条件
        </button>
      </section>
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-index">03</span>
          <div><h3>执行动作</h3><p>条件命中后写入结果字段</p></div>
        </div>
        <div className="row-head action-grid"><span>结果字段</span><span>赋值</span></div>
        {draft.actions.map((action, index) => {
          const field = outputFields.find(entry => entry.key === action.field) || outputFields[0];
          return (
            <div className="action-grid edit-row" key={index}>
              <select
                value={action.field}
                onChange={event => {
                  const next = outputFields.find(entry => entry.key === event.target.value);
                  updateRow('actions', index, {
                    field: next.key,
                    value: next.type === 'Boolean' ? 'false' : '',
                  });
                }}
              >
                {outputFields.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </select>
              <ValueInput field={field} value={action.value} onChange={value => updateRow('actions', index, { value })} />
              <IconButton icon={Trash2} label="删除动作" onClick={() => remove('actions', index)} disabled={draft.actions.length === 1} />
            </div>
          );
        })}
        <button
          className="add-row"
          onClick={() => update({
            actions: [
              ...draft.actions,
              {
                field: outputFields.find(field => !draft.actions.some(action => action.field === field.key))?.key || 'riskLevel',
                value: '',
              },
            ],
          })}
        >
          <Plus size={16} />添加动作
        </button>
      </section>
    </div>
  );
}

function TableEditor({ draft, update, warnings = [], trace = [] }) {
  const defaultRowIndex = draft.rows.findIndex(row => row.isDefault);
  const effectiveDefaultRow = defaultRowIndex >= 0 ? defaultRowIndex : draft.defaultRow;
  const markDefaultRow = (rows, index) => rows.map((row, i) => ({ ...row, isDefault: i === index }));
  function updateColumn(kind, index, changes) {
    update({ [kind]: draft[kind].map((column, i) => i === index ? { ...column, ...changes } : column) });
  }
  function changeField(kind, index, key) {
    const source = kind === 'conditions' ? inputFields : outputFields;
    const field = source.find(entry => entry.key === key);
    update({
      [kind]: draft[kind].map((column, i) => i === index
        ? (kind === 'conditions' ? { field: field.key, operator: '==' } : { field: field.key })
        : column),
      rows: draft.rows.map(row => ({
        ...row,
        [kind]: row[kind].map((value, i) => i === index ? '' : value),
      })),
    });
  }
  function removeColumn(kind, index) {
    update({
      [kind]: draft[kind].filter((_, i) => i !== index),
      rows: draft.rows.map(row => ({ ...row, [kind]: row[kind].filter((_, i) => i !== index) })),
    });
  }
  function updateCell(rowIndex, kind, cellIndex, value) {
    update({
      rows: draft.rows.map((row, i) => i === rowIndex
        ? { ...row, [kind]: row[kind].map((cell, j) => j === cellIndex ? value : cell) }
        : row),
    });
  }
  function moveRow(index, direction) {
    const rows = [...draft.rows];
    [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]];
    const movedDefault = effectiveDefaultRow === index
      ? index + direction
      : effectiveDefaultRow === index + direction
        ? index
        : effectiveDefaultRow;
    update({ rows: movedDefault == null ? rows : markDefaultRow(rows, movedDefault), defaultRow: movedDefault ?? null });
  }
  function duplicateRow(index) {
    const rows = [...draft.rows];
    rows.splice(index + 1, 0, { ...clone(rows[index]), isDefault: false });
    const shiftedDefault = effectiveDefaultRow != null && index < effectiveDefaultRow ? effectiveDefaultRow + 1 : effectiveDefaultRow;
    update({ rows: shiftedDefault == null ? rows : markDefaultRow(rows, shiftedDefault), defaultRow: shiftedDefault ?? null });
  }
  function clearRow(index) {
    const rows = draft.rows.map((row, i) => i === index
      ? { ...row, enabled: false, isDefault: false, conditions: row.conditions.map(() => ''), actions: row.actions.map(() => '') }
      : row);
    const nextDefault = effectiveDefaultRow === index ? null : effectiveDefaultRow;
    update({
      rows: nextDefault == null ? rows : markDefaultRow(rows, nextDefault),
      defaultRow: nextDefault ?? null,
    });
  }
  const addColumn = kind => {
    const source = kind === 'conditions' ? inputFields : outputFields;
    const key = source.find(field => !draft[kind].some(column => column.field === field.key))?.key;
    if (!key) return;
    update({
      [kind]: [...draft[kind], kind === 'conditions' ? { field: key, operator: '==' } : { field: key }],
      rows: draft.rows.map(row => ({ ...row, [kind]: [...row[kind], ''] })),
    });
  };
  const addRow = () => update({
    rows: [...draft.rows, {
      enabled: true,
      priority: 0,
      conditions: draft.conditions.map(() => ''),
      actions: draft.actions.map(() => ''),
    }],
  });
  const hitPolicy = draft.hitPolicy || 'ALL';
  const selectedPolicy = hitPolicies.find(policy => policy.key === hitPolicy) || hitPolicies[1];
  const hitOrders = new Map();
  for (const hit of trace) {
    if (hit.rowIndex == null) continue;
    hitOrders.set(hit.rowIndex, [...(hitOrders.get(hit.rowIndex) || []), hit.order]);
  }

  return (
    <div className="editor-body">
      <Metadata draft={draft} update={update} />
      <section className="editor-section">
        <div className="section-heading">
          <span className="section-index">02</span>
          <div><h3>决策表</h3><p>每个启用行生成一条 Drools 规则；空单元格表示不限制/不赋值。数值可填区间 <code>600..700</code>，文本可填枚举 <code>VIP,whale</code>。</p></div>
        </div>
        <div className="hit-policy-bar">
          <div>
            <b>命中策略</b>
            <small>{selectedPolicy.description}</small>
          </div>
          <div className="segmented" role="group" aria-label="决策表命中策略">
            {hitPolicies.map(policy => (
              <button
                type="button"
                key={policy.key}
                className={hitPolicy === policy.key ? 'active' : ''}
                onClick={() => update({ hitPolicy: policy.key })}
                title={policy.description}
              >{policy.label}</button>
            ))}
          </div>
        </div>
        {warnings.length > 0 && (
          <div className="analysis-warnings inline">
            <CircleAlert size={17} />
            <div><b>决策表分析</b>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
          </div>
        )}
        <div className="table-scroll">
          <table className="decision-table">
            <thead>
              <tr className="table-group-row">
                <th rowSpan="2">启用</th>
                {hitPolicy === 'PRIORITY' && <th rowSpan="2" className="priority-heading">行优先级</th>}
                <th colSpan={draft.conditions.length}>
                  <span>条件列</span>
                  <IconButton icon={Plus} label="添加条件列" onClick={() => addColumn('conditions')} disabled={draft.conditions.length >= inputFields.length} />
                </th>
                <th colSpan={draft.actions.length}>
                  <span>结果列</span>
                  <IconButton icon={Plus} label="添加结果列" onClick={() => addColumn('actions')} disabled={draft.actions.length >= outputFields.length} />
                </th>
                <th rowSpan="2">操作</th>
              </tr>
              <tr>
                {draft.conditions.map((column, index) => {
                  const field = inputFields.find(entry => entry.key === column.field);
                  return (
                    <th className="column-heading" key={`c-${index}`}>
                      <select value={column.field} onChange={event => changeField('conditions', index, event.target.value)}>
                        {inputFields.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
                      </select>
                      <select value={column.operator} onChange={event => updateColumn('conditions', index, { operator: event.target.value })}>
                        {operators.filter(operator => field?.type !== 'Boolean' || ['==', '!='].includes(operator.key))
                          .map(operator => <option key={operator.key} value={operator.key}>{operator.label}</option>)}
                      </select>
                      <IconButton icon={X} label="删除条件列" onClick={() => removeColumn('conditions', index)} disabled={draft.conditions.length === 1} />
                    </th>
                  );
                })}
                {draft.actions.map((column, index) => (
                  <th className="column-heading" key={`a-${index}`}>
                    <select value={column.field} onChange={event => changeField('actions', index, event.target.value)}>
                      {outputFields.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
                    </select>
                    <IconButton icon={X} label="删除结果列" onClick={() => removeColumn('actions', index)} disabled={draft.actions.length === 1} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((row, rowIndex) => {
                const isDefaultRow = row.isDefault || draft.defaultRow === rowIndex;
                return (
                <tr className={`${row.enabled ? '' : 'disabled-row'} ${isDefaultRow ? 'default-row' : ''} ${hitOrders.has(rowIndex) ? 'matched-row' : ''}`} key={rowIndex}>
                  <td>
                    <div className="row-enable">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={event => update({
                          rows: draft.rows.map((entry, i) => i === rowIndex ? { ...entry, enabled: event.target.checked } : entry),
                        })}
                      />
                      {hitOrders.has(rowIndex) && <span className="row-hit-order" title={`第 ${hitOrders.get(rowIndex).join('、')} 次命中`}>{hitOrders.get(rowIndex).join(',')}</span>}
                    </div>
                  </td>
                  {hitPolicy === 'PRIORITY' && (
                    <td className="priority-cell">
                      <input
                        type="number"
                        min="-1000"
                        max="1000"
                        step="1"
                        value={row.priority ?? 0}
                        disabled={isDefaultRow}
                        aria-label={`第 ${rowIndex + 1} 行优先级`}
                        onChange={event => update({
                          rows: draft.rows.map((entry, i) => i === rowIndex ? { ...entry, priority: Number(event.target.value) } : entry),
                        })}
                      />
                    </td>
                  )}
                  {row.conditions.map((value, cellIndex) => (
                    <td key={`c-${cellIndex}`}>
                      <ValueInput
                        allowEmpty
                        freeform
                        field={inputFields.find(entry => entry.key === draft.conditions[cellIndex].field)}
                        value={value}
                        onChange={next => updateCell(rowIndex, 'conditions', cellIndex, next)}
                      />
                    </td>
                  ))}
                  {row.actions.map((value, cellIndex) => (
                    <td key={`a-${cellIndex}`}>
                      <ValueInput
                        allowEmpty
                        emptyLabel="不赋值"
                        field={outputFields.find(entry => entry.key === draft.actions[cellIndex].field)}
                        value={value}
                        onChange={next => updateCell(rowIndex, 'actions', cellIndex, next)}
                      />
                    </td>
                  ))}
                  <td className="table-row-actions">
                    <IconButton icon={ArrowUp} label="上移决策行" onClick={() => moveRow(rowIndex, -1)} disabled={rowIndex === 0} />
                    <IconButton icon={ArrowDown} label="下移决策行" onClick={() => moveRow(rowIndex, 1)} disabled={rowIndex === draft.rows.length - 1} />
                    <IconButton icon={Copy} label="复制决策行" onClick={() => duplicateRow(rowIndex)} disabled={draft.rows.length >= 200} />
                    <button
                      className={isDefaultRow ? 'chip chip-active' : 'chip'}
                      title="设为默认行（otherwise：所有其他行都不匹配时走此行）"
                      onClick={() => {
                        const nextDefault = isDefaultRow ? null : rowIndex;
                        update({
                          defaultRow: nextDefault,
                          rows: draft.rows.map((r, i) => i === rowIndex
                            ? { ...r, isDefault: !isDefaultRow, conditions: r.conditions.map(() => '') }
                            : { ...r, isDefault: false }),
                        });
                      }}
                    >{isDefaultRow ? '✓ 默认' : '默认行'}</button>
                    <IconButton icon={RotateCcw} label="清空并停用决策行" onClick={() => clearRow(rowIndex)} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button className="add-row" onClick={addRow} disabled={draft.rows.length >= 200}><Plus size={16} />添加决策行</button>
      </section>
    </div>
  );
}

function RuleFlowNode({ data, selected }) {
  const isTable = data.kind === 'table';
  const accent = isTable ? '#3b82f6' : '#218a79';
  return (
    <div style={{
      background: '#fff',
      border: `1.5px solid ${selected ? accent : '#e3eae7'}`,
      borderRadius: 10, padding: 0, minWidth: 220,
      boxShadow: selected ? `0 4px 16px ${accent}40, 0 1px 4px rgba(0,0,0,0.06)` : '0 2px 8px rgba(0,0,0,0.06)',
      fontSize: 12, overflow: 'hidden',
      transition: 'box-shadow 0.2s, border-color 0.2s',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#bbb', width: 8, height: 8, border: '2px solid #fff' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, flexShrink: 0,
          background: `${accent}15`, color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        }}>{isTable ? '▦' : '⚡'}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 9, color: accent, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {isTable ? '决策表' : '规则'} · v{data.version || '-'}{data.mappingCount ? ` · ${data.mappingCount} 项映射` : ''}
          </div>
          <div style={{ fontWeight: 600, color: '#2d3a37', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.name}</div>
        </div>
      </div>
      <div style={{ height: 3, background: `linear-gradient(90deg, ${accent}, ${accent}60)` }} />
      <Handle type="source" position={Position.Bottom} style={{ background: '#bbb', width: 8, height: 8, border: '2px solid #fff' }} />
    </div>
  );
}

function StartEndNode({ data }) {
  const isStart = data.kind === 'start';
  const color = isStart ? '#218a79' : '#c0392b';
  return (
    <div style={{
      background: isStart ? 'linear-gradient(135deg, #218a79, #2ba894)' : 'linear-gradient(135deg, #c0392b, #e74c3c)',
      borderRadius: 24, padding: '8px 32px', minWidth: 100, textAlign: 'center',
      boxShadow: `0 3px 10px ${color}50`, fontSize: 13, fontWeight: 700, letterSpacing: 1,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      {!isStart && <Handle type="target" position={Position.Top} style={{ background: color, width: 8, height: 8, border: '2px solid #fff' }} />}
      <span style={{ fontSize: 14 }}>{isStart ? '▶' : '■'}</span>{data.label}
      {isStart && <Handle type="source" position={Position.Bottom} style={{ background: color, width: 8, height: 8, border: '2px solid #fff' }} />}
    </div>
  );
}

function GatewayNode({ data, selected }) {
  return (
    <div className={`gateway-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <GitBranch size={18} />
      <div><b>条件网关</b><small>{data.branches} 条分支 · 首条匹配</small></div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { ruleFlow: RuleFlowNode, startEnd: StartEndNode, gateway: GatewayNode };

function StepMappingsEditor({ step, onChange }) {
  const allFields = [...inputFields, ...outputFields];
  const groups = [
    { key: 'inputMappings', label: '输入映射', sources: allFields, targets: inputFields },
    { key: 'outputMappings', label: '输出映射', sources: outputFields, targets: allFields },
  ];

  const candidates = (group, sourceKey, mappings, currentIndex = -1) => {
    const source = group.sources.find(field => field.key === sourceKey);
    const used = new Set(mappings.filter((_, index) => index !== currentIndex).map(mapping => mapping.target));
    return source ? group.targets.filter(field => field.type === source.type && field.key !== source.key && !used.has(field.key)) : [];
  };
  const addMapping = group => {
    const mappings = step[group.key] || [];
    for (const source of group.sources) {
      const target = candidates(group, source.key, mappings)[0];
      if (target) {
        onChange({ [group.key]: [...mappings, { source: source.key, target: target.key }] });
        return;
      }
    }
  };
  const updateMapping = (group, index, changes) => {
    const mappings = step[group.key] || [];
    const next = mappings.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, ...changes } : mapping);
    const mapping = next[index];
    const validTargets = candidates(group, mapping.source, next, index);
    if (!validTargets.some(field => field.key === mapping.target)) mapping.target = validTargets[0]?.key || '';
    onChange({ [group.key]: next });
  };

  return (
    <div className="step-mappings">
      {groups.map(group => {
        const mappings = step[group.key] || [];
        const canAdd = group.sources.some(source => candidates(group, source.key, mappings).length);
        return (
          <div className="mapping-group" key={group.key}>
            <div className="mapping-group-head"><span>{group.label}</span><IconButton icon={Plus} label={`添加${group.label}`} onClick={() => addMapping(group)} disabled={!canAdd || mappings.length >= 20} /></div>
            {mappings.map((mapping, index) => {
              const targets = candidates(group, mapping.source, mappings, index);
              const sources = group.sources.filter(source => candidates(group, source.key, mappings, index).length);
              return (
                <div className="mapping-row" key={`${group.key}-${index}`}>
                  <select value={mapping.source} aria-label={`${group.label}源字段`} onChange={event => updateMapping(group, index, { source: event.target.value })}>
                    {sources.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
                  </select>
                  <ArrowRight size={14} />
                  <select value={mapping.target} aria-label={`${group.label}目标字段`} onChange={event => updateMapping(group, index, { target: event.target.value })}>
                    {targets.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
                  </select>
                  <IconButton icon={X} label={`删除${group.label}`} onClick={() => onChange({ [group.key]: mappings.filter((_, mappingIndex) => mappingIndex !== index) })} />
                </div>
              );
            })}
            {!mappings.length && <small>未配置</small>}
          </div>
        );
      })}
    </div>
  );
}

function FlowEditor({ draft, update, rules, tables }) {
  const published = useMemo(() => [
    ...rules.filter(item => !item.archived && item.published).map(item => ({ ...item, flowType: 'rule' })),
    ...tables.filter(item => !item.archived && item.published).map(item => ({ ...item, flowType: 'table' })),
  ], [rules, tables]);

  // 构建带 start/end 的节点和边
  const buildGraph = useCallback(() => {
    const steps = draft.steps || [];
    const branches = draft.branches || [];
    const positions = draft.nodePositions || {};
    const startNode = { id: '__start__', type: 'startEnd', position: { x: 260, y: 20 }, data: { kind: 'start', label: '开始' } };
    const stepNodes = steps.map((step, i) => {
      const asset = published.find(item => item.id === step.id && (step.type === 'table' ? item.flowType === 'table' : item.flowType === 'rule'));
      const pos = positions[`step-${i}`] || { x: 200, y: 140 + i * 130 };
      return { id: `step-${i}`, type: 'ruleFlow', position: pos,
        data: { kind: step.type, name: asset?.draft.name || '已失效引用', version: asset?.versions?.at(-1)?.number,
          mappingCount: (step.inputMappings?.length || 0) + (step.outputMappings?.length || 0) } };
    });
    const gatewayY = 140 + steps.length * 130;
    const gatewayNode = branches.length ? {
      id: '__gateway__', type: 'gateway', position: positions.__gateway__ || { x: 215, y: gatewayY }, data: { branches: branches.length },
    } : null;
    const branchStartY = gatewayY + 140;
    const branchStartX = 200 - ((branches.length - 1) * 270) / 2;
    const branchNodes = branches.flatMap((branch, branchIndex) => branch.steps.map((step, stepIndex) => {
      const asset = published.find(item => item.id === step.id && (step.type === 'table' ? item.flowType === 'table' : item.flowType === 'rule'));
      const nodeId = `branch-${branch.id}-${stepIndex}`;
      return {
        id: nodeId,
        type: 'ruleFlow',
        position: positions[nodeId] || { x: branchStartX + branchIndex * 270, y: branchStartY + stepIndex * 130 },
        data: { kind: step.type, name: asset?.draft.name || '已失效引用', version: asset?.versions?.at(-1)?.number,
          mappingCount: (step.inputMappings?.length || 0) + (step.outputMappings?.length || 0) },
      };
    }));
    const maxBranchSteps = branches.reduce((maximum, branch) => Math.max(maximum, branch.steps.length), 0);
    const endY = branches.length ? branchStartY + maxBranchSteps * 130 : 140 + steps.length * 130;
    const endNode = { id: '__end__', type: 'startEnd', position: { x: 260, y: endY }, data: { kind: 'end', label: '结束' } };
    const nodes = [startNode, ...stepNodes, ...(gatewayNode ? [gatewayNode] : []), ...branchNodes, endNode];
    const edges = [];
    if (stepNodes.length) {
      edges.push({ id: 'e-start', source: '__start__', target: 'step-0', markerEnd: { type: 'arrowclosed', width: 18, height: 18 } });
      stepNodes.slice(0, -1).forEach((_, i) => edges.push({ id: `e-${i}`, source: `step-${i}`, target: `step-${i+1}`, markerEnd: { type: 'arrowclosed', width: 18, height: 18 } }));
      edges.push({ id: 'e-after-common', source: `step-${stepNodes.length - 1}`, target: branches.length ? '__gateway__' : '__end__', markerEnd: { type: 'arrowclosed', width: 18, height: 18 } });
    } else if (branches.length) {
      edges.push({ id: 'e-start-gateway', source: '__start__', target: '__gateway__', markerEnd: { type: 'arrowclosed', width: 18, height: 18 } });
    } else {
      edges.push({ id: 'e-direct', source: '__start__', target: '__end__', markerEnd: { type: 'arrowclosed', width: 18, height: 18 } });
    }
    for (const branch of branches) {
      if (!branch.steps.length) {
        edges.push({
          id: `e-gateway-${branch.id}-empty`, source: '__gateway__', target: '__end__',
          label: `${branch.default ? '默认' : branch.name}（空）`, labelStyle: { fontSize: 10, fill: '#b85c4d' },
          markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
        });
        continue;
      }
      const first = `branch-${branch.id}-0`;
      edges.push({
        id: `e-gateway-${branch.id}`, source: '__gateway__', target: first,
        label: branch.default ? '默认' : branch.name,
        labelStyle: { fontSize: 10, fill: '#596d69' },
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
      });
      branch.steps.slice(0, -1).forEach((_, index) => edges.push({
        id: `e-${branch.id}-${index}`, source: `branch-${branch.id}-${index}`, target: `branch-${branch.id}-${index + 1}`,
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
      }));
      edges.push({
        id: `e-${branch.id}-end`, source: `branch-${branch.id}-${branch.steps.length - 1}`, target: '__end__',
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
      });
    }
    return { nodes, edges };
  }, [draft.steps, draft.branches, draft.nodePositions, published]);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => buildGraph(), [buildGraph]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // steps 变化时重建
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph();
    setNodes(n); setEdges(e);
  }, [buildGraph]);

  const onNodeDragStop = useCallback((event, node) => {
    const positions = { ...(draft.nodePositions || {}) };
    positions[node.id] = node.position;
    update({ nodePositions: positions });
  }, [draft.nodePositions, update]);

  const addStep = value => {
    const branchSteps = (draft.branches || []).reduce((total, branch) => total + branch.steps.length, 0);
    if (!value || draft.steps.length + branchSteps >= 20) return;
    const [type, id] = value.split(':');
    update({ steps: [...draft.steps, { type, id }] });
  };

  const removeStep = nodeId => {
    const idx = parseInt(nodeId.replace('step-', ''));
    update({ steps: draft.steps.filter((_, i) => i !== idx) });
  };
  const updateStep = (index, changes) => update({
    steps: draft.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...changes } : step),
  });
  const branches = draft.branches || [];
  const flowFields = [...inputFields, ...outputFields];
  const totalSteps = draft.steps.length + branches.reduce((total, branch) => total + branch.steps.length, 0);
  const initialConditionValue = field => field.type === 'Boolean'
    ? 'true'
    : field.enum?.[0] ?? String(field.min ?? 0);
  const updateBranch = (index, changes) => update({
    branches: branches.map((branch, branchIndex) => branchIndex === index ? { ...branch, ...changes } : branch),
  });
  const addBranch = isDefault => {
    const asset = published[0];
    const field = flowFields.find(entry => entry.key === 'creditScore') || flowFields[0];
    if (!asset || !field || branches.length >= 8 || (isDefault && branches.some(branch => branch.default))) return;
    update({
      branches: [...branches, {
        id: crypto.randomUUID(),
        name: isDefault ? '默认分支' : `条件分支 ${branches.filter(branch => !branch.default).length + 1}`,
        default: isDefault,
        condition: isDefault ? null : { field: field.key, operator: '>=', value: initialConditionValue(field) },
        steps: [{ type: asset.flowType, id: asset.id }],
      }],
    });
  };
  const moveBranch = (index, direction) => {
    const next = [...branches];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    update({ branches: next });
  };
  const addBranchStep = (branchIndex, value) => {
    if (!value || totalSteps >= 20) return;
    const [type, id] = value.split(':');
    updateBranch(branchIndex, { steps: [...branches[branchIndex].steps, { type, id }] });
  };

  return (
    <div className="editor-body" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #eef2f0', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={draft.name} onChange={e => update({ name: e.target.value })}
          style={{ fontSize: 16, fontWeight: 700, border: '1px solid transparent', borderBottom: '1.5px solid #e3eae7', padding: '4px 8px', minWidth: 220, background: 'transparent' }}
          onFocus={e => e.target.style.borderBottomColor = '#218a79'}
          onBlur={e => e.target.style.borderBottomColor = '#e3eae7'} />
        <input value={draft.category || ''} onChange={e => update({ category: e.target.value })}
          placeholder="分类"
          style={{ fontSize: 12, border: '1px solid #e3eae7', borderRadius: 4, padding: '4px 10px', background: '#f6f9f8', width: 100 }} />
        <input value={draft.description || ''} onChange={e => update({ description: e.target.value })}
          placeholder="流程说明..."
          style={{ fontSize: 12, border: '1px solid transparent', padding: '4px 8px', flex: 1, minWidth: 180, color: '#6b7a77' }} />
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="flow-canvas-wrapper" style={{ flex: 1, height: 'auto', minHeight: 520 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable={true}
            nodesConnectable={false}
            elementsSelectable={true}
          >
            <Background gap={16} size={1} color="#d0d8d5" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => n.type === 'startEnd' ? (n.data.kind === 'start' ? '#218a79' : '#c0392b') : n.type === 'gateway' ? '#b7791f' : (n.data.kind === 'table' ? '#3b82f6' : '#218a79')} style={{ width: 140, height: 90 }} />
          </ReactFlow>
          {nodes.length === 0 && <div className="flow-canvas-empty">从下方添加资产开始编排流程</div>}
        </div>
        {!!draft.steps.length && (
          <section className="flow-step-settings">
            <h4>公共步骤配置</h4>
            {draft.steps.map((step, index) => {
              const asset = published.find(item => item.id === step.id && item.flowType === step.type);
              return (
                <div className="flow-step-config" key={`${step.type}:${step.id}:${index}`}>
                  <div className="flow-step-config-head"><span>{index + 1}</span><b>{asset?.draft.name || '已失效引用'}</b><small>{step.type === 'table' ? '决策表' : '规则'}</small><IconButton icon={Trash2} label="删除公共步骤" onClick={() => removeStep(`step-${index}`)} /></div>
                  <StepMappingsEditor step={step} onChange={changes => updateStep(index, changes)} />
                </div>
              );
            })}
          </section>
        )}
        <label className="flow-add">
          添加公共步骤
          <select value="" onChange={event => addStep(event.target.value)} disabled={totalSteps >= 20}>
            <option value="">{totalSteps >= 20 ? '已达 20 步上限' : '选择规则或决策表'}</option>
            {published.map(asset => (
              <option key={`${asset.flowType}:${asset.id}`} value={`${asset.flowType}:${asset.id}`}>
                {asset.flowType === 'table' ? '[决策表]' : '[规则]'} {asset.draft.name} · v{asset.versions.at(-1)?.number || '-'}
              </option>
            ))}
          </select>
        </label>
        <section className="flow-branches">
          <div className="flow-branches-head">
            <div><h4>条件网关</h4><small>按分支顺序选择第一条满足条件的路径</small></div>
            <div>
              <button className="secondary" onClick={() => addBranch(false)} disabled={!published.length || branches.length >= 8 || totalSteps >= 20}><GitBranch size={15} />添加条件分支</button>
              <button className="secondary" onClick={() => addBranch(true)} disabled={!published.length || branches.length >= 8 || branches.some(branch => branch.default) || totalSteps >= 20}><Plus size={15} />添加默认分支</button>
            </div>
          </div>
          {branches.map((branch, branchIndex) => {
            const conditionField = branch.default ? null : flowFields.find(field => field.key === branch.condition?.field) || flowFields[0];
            return (
              <div className={`flow-branch ${branch.default ? 'default' : ''}`} key={branch.id}>
                <div className="flow-branch-title">
                  <span>{branchIndex + 1}</span>
                  <input value={branch.name} maxLength={40} onChange={event => updateBranch(branchIndex, { name: event.target.value })} aria-label={`第 ${branchIndex + 1} 个分支名称`} />
                  {branch.default && <em>默认</em>}
                  <IconButton icon={ArrowUp} label="上移分支" onClick={() => moveBranch(branchIndex, -1)} disabled={branchIndex === 0} />
                  <IconButton icon={ArrowDown} label="下移分支" onClick={() => moveBranch(branchIndex, 1)} disabled={branchIndex === branches.length - 1} />
                  <IconButton icon={Trash2} label="删除分支" onClick={() => update({ branches: branches.filter((_, index) => index !== branchIndex) })} />
                </div>
                {!branch.default && conditionField && (
                  <div className="flow-condition">
                    <select value={branch.condition?.field} onChange={event => {
                      const field = flowFields.find(entry => entry.key === event.target.value);
                      updateBranch(branchIndex, { condition: { field: field.key, operator: '==', value: initialConditionValue(field) } });
                    }}>
                      {flowFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
                    </select>
                    <select value={branch.condition?.operator} onChange={event => updateBranch(branchIndex, { condition: { ...branch.condition, operator: event.target.value } })}>
                      {operators.filter(operator => conditionField.type !== 'Boolean' || ['==', '!='].includes(operator.key)).map(operator => <option key={operator.key} value={operator.key}>{operator.label}</option>)}
                    </select>
                    <ValueInput field={conditionField} value={branch.condition?.value ?? ''} onChange={value => updateBranch(branchIndex, { condition: { ...branch.condition, value } })} />
                  </div>
                )}
                <div className="flow-branch-steps">
                  {branch.steps.map((step, stepIndex) => {
                    const asset = published.find(item => item.id === step.id && item.flowType === step.type);
                    return (
                      <div className="flow-branch-step" key={`${step.type}:${step.id}:${stepIndex}`}>
                        <div className="flow-branch-step-head"><span>{stepIndex + 1}</span><b>{asset?.draft.name || '已失效引用'}</b><small>{step.type === 'table' ? '决策表' : '规则'}</small><IconButton icon={X} label="移除分支步骤" onClick={() => updateBranch(branchIndex, { steps: branch.steps.filter((_, index) => index !== stepIndex) })} /></div>
                        <StepMappingsEditor step={step} onChange={changes => updateBranch(branchIndex, { steps: branch.steps.map((item, index) => index === stepIndex ? { ...item, ...changes } : item) })} />
                      </div>
                    );
                  })}
                  <select value="" onChange={event => addBranchStep(branchIndex, event.target.value)} disabled={totalSteps >= 20} aria-label={`向${branch.name}添加步骤`}>
                    <option value="">添加分支步骤</option>
                    {published.map(asset => <option key={`${asset.flowType}:${asset.id}`} value={`${asset.flowType}:${asset.id}`}>{asset.flowType === 'table' ? '[决策表]' : '[规则]'} {asset.draft.name}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          {!branches.length && <div className="flow-branches-empty">当前流程仅执行公共步骤</div>}
        </section>
      </div>
    </div>
  );
}

const changeSetStatuses = {
  DRAFT: ['草稿', 'draft'], SUBMITTED: ['待评审', 'submitted'],
  APPROVED: ['已批准', 'approved'], REJECTED: ['已驳回', 'rejected'],
};
const assetTypeLabels = { rule: '规则', table: '决策表', flow: '规则流' };

function GovernanceView() {
  const [changeSets, setChangeSets] = useState([]);
  const [assets, setAssets] = useState([]);
  const [audit, setAudit] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [view, setView] = useState('changes');
  const [comment, setComment] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const selected = changeSets.find(item => item.id === selectedId);

  const refreshAudit = () => api('/audit-events?limit=100').then(setAudit);
  useEffect(() => {
    Promise.all([api('/change-sets'), api('/rules'), api('/tables'), api('/flows'), api('/audit-events?limit=100')])
      .then(([sets, rules, tables, flows, events]) => {
        setChangeSets(sets);
        setAssets([
          ...rules.filter(item => !item.archived).map(item => ({ ...item, type: 'rule' })),
          ...tables.filter(item => !item.archived).map(item => ({ ...item, type: 'table' })),
          ...flows.filter(item => !item.archived).map(item => ({ ...item, type: 'flow' })),
        ]);
        setAudit(events);
        if (sets.length) {
          setSelectedId(sets[0].id);
          setDraft({ name: sets[0].name, description: sets[0].description, items: sets[0].items.map(item => ({ type: item.assetType, id: item.assetId })) });
        }
      }).catch(error => setNotice(error.message));
  }, []);

  const select = item => {
    setSelectedId(item.id);
    setDraft({ name: item.name, description: item.description, items: item.items.map(entry => ({ type: entry.assetType, id: entry.assetId })) });
    setComment(item.decisionComment || '');
    setConflict(null);
    setNotice('');
  };
  const create = () => {
    setSelectedId(null);
    setDraft({ name: '未命名变更集', description: '', items: [] });
    setComment('');
    setConflict(null);
    setNotice('');
    setView('changes');
  };
  const replace = item => {
    setChangeSets(previous => [item, ...previous.filter(entry => entry.id !== item.id)]);
    setSelectedId(item.id);
    setDraft({ name: item.name, description: item.description, items: item.items.map(entry => ({ type: entry.assetType, id: entry.assetId })) });
    setComment(item.decisionComment || '');
  };
  async function perform(operation) {
    setBusy(true);
    setNotice('');
    try { await operation(); }
    catch (error) {
      if (error.details?.current && error.details?.currentRevision) setConflict(error.details);
      else setNotice(error.message);
    } finally { setBusy(false); }
  }
  const save = () => perform(async () => {
    const saved = await api(selectedId ? `/change-sets/${selectedId}` : '/change-sets', {
      method: selectedId ? 'PUT' : 'POST',
      body: JSON.stringify({ ...draft, ...(selectedId ? { revision: selected.revision } : {}) }),
    });
    replace(saved);
    setConflict(null);
    setNotice('变更集已保存');
    await refreshAudit();
  });
  const transition = action => perform(async () => {
    const updated = await api(`/change-sets/${selectedId}/${action}`, {
      method: 'POST', body: JSON.stringify({ revision: selected.revision, comment }),
    });
    replace(updated);
    setConflict(null);
    const labels = { submit: '已提交评审', approve: '变更集已批准', reject: '变更集已驳回', reopen: '已重新打开变更集' };
    setNotice(labels[action]);
    await refreshAudit();
  });
  const toggleAsset = asset => {
    const key = `${asset.type}:${asset.id}`;
    const exists = draft.items.some(item => `${item.type}:${item.id}` === key);
    setDraft({ ...draft, items: exists ? draft.items.filter(item => `${item.type}:${item.id}` !== key) : [...draft.items, { type: asset.type, id: asset.id }] });
  };
  const displayValue = value => value === undefined ? '未设置' : value === null ? '空' : typeof value === 'object' ? JSON.stringify(value) : String(value);

  return (
    <div className="governance-view">
      <div className="section-heading governance-heading">
        <span className="section-index"><ShieldCheck size={16} /></span>
        <div><h3>变更治理</h3><p>固定资产修订、检查结构化差异并保留评审证据。</p></div>
        <div className="governance-tabs"><button className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}>变更集</button><button className={view === 'audit' ? 'active' : ''} onClick={() => setView('audit')}>审计日志</button></div>
        {view === 'changes' && <button className="primary" onClick={create} disabled={busy}><Plus size={15} />新建变更集</button>}
      </div>
      {notice && <div className={`notice ${notice.includes('已') ? 'success' : ''}`}><CircleAlert size={16} />{notice}<IconButton icon={X} label="关闭提示" onClick={() => setNotice('')} /></div>}
      <ConflictNotice conflict={conflict} noun="变更集" onLoad={() => { replace(conflict.current); setConflict(null); setNotice('已载入服务器版本'); }} />
      {view === 'audit' ? <div className="audit-list">
        <div className="audit-head"><b>最近审计事件</b><span>{audit.length} 条</span></div>
        {audit.map(event => <div className="audit-row" key={event.id}><span className="audit-dot" /><div><b>{event.summary}</b><small>{event.actor} · {event.resourceType}:{event.resourceId}</small></div><time>{fmt(event.occurredAt)}</time></div>)}
        {!audit.length && <div className="list-empty">尚无审计事件</div>}
      </div> : <div className="governance-layout">
        <section className="change-set-list">
          <div className="release-section-title"><h4>变更集</h4><span>{changeSets.length} 个</span></div>
          {changeSets.map(item => { const status = changeSetStatuses[item.status] || [item.status, '']; return <button key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => select(item)}><span><b>{item.name}</b><small>{item.items.length} 个资产 · r{item.revision}</small></span><em className={`change-status ${status[1]}`}>{status[0]}</em></button>; })}
          {!changeSets.length && <div className="list-empty">尚无变更集</div>}
        </section>
        <section className="change-set-detail">
          {!draft ? <div className="list-empty">新建或选择一个变更集</div> : <>
            <div className="change-set-toolbar">
              <div><span className="eyebrow">{selected ? changeSetStatuses[selected.status]?.[0] : '新建变更集'}</span><h2>{draft.name}</h2></div>
              <div>
                {(!selected || selected.status === 'DRAFT') && <button className="secondary" onClick={save} disabled={busy || !draft.name.trim()}><Save size={15} />保存</button>}
                {selected?.status === 'DRAFT' && <button className="primary" onClick={() => transition('submit')} disabled={busy || !selected.items.length}><Send size={15} />提交评审</button>}
                {selected?.status === 'SUBMITTED' && <><button className="secondary danger" onClick={() => transition('reject')} disabled={busy || !comment.trim()}><X size={15} />驳回</button><button className="primary" onClick={() => transition('approve')} disabled={busy}><Check size={15} />批准</button></>}
                {selected?.status === 'REJECTED' && <button className="secondary" onClick={() => transition('reopen')} disabled={busy}><RotateCcw size={15} />重新打开</button>}
              </div>
            </div>
            {(!selected || selected.status === 'DRAFT') ? <>
              <div className="change-set-form"><label>名称<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>说明<textarea rows="3" maxLength={1000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div>
              <div className="asset-picker"><div className="release-section-title"><h4>纳入资产</h4><span>{draft.items.length}/50</span></div>{assets.map(asset => { const checked = draft.items.some(item => item.type === asset.type && item.id === asset.id); return <label key={`${asset.type}:${asset.id}`}><input type="checkbox" checked={checked} onChange={() => toggleAsset(asset)} /><span><b>{asset.draft.name}</b><small>{assetTypeLabels[asset.type]} · 当前 r{asset.revision}{asset.published ? ` · 已发布 v${asset.versions.at(-1)?.number}` : ' · 未发布'}</small></span></label>; })}</div>
            </> : <div className="change-set-summary"><p>{selected.description || '无补充说明'}</p><span>创建于 {fmt(selected.createdAt)} · 当前修订 r{selected.revision}</span></div>}
            {selected?.status === 'SUBMITTED' && <label className="review-comment">评审意见<textarea rows="3" value={comment} onChange={event => setComment(event.target.value)} placeholder="批准意见可选；驳回时必填" /></label>}
            {selected?.decisionComment && selected.status !== 'SUBMITTED' && <div className="decision-comment"><b>评审意见</b><p>{selected.decisionComment}</p></div>}
            {selected && <div className="change-diffs"><div className="release-section-title"><h4>固定差异</h4><span>{selected.items.reduce((sum, item) => sum + item.changes.length, 0)} 项</span></div>{selected.items.map(item => <article className="change-asset" key={`${item.assetType}:${item.assetId}`}><header><div><b>{item.name}</b><small>{assetTypeLabels[item.assetType]} · 草稿 r{item.assetRevision} · 基线 {item.baseVersion ? `v${item.baseVersion}` : '新资产'}</small></div><span>+{item.summary.added} / -{item.summary.removed} / ~{item.summary.changed}</span></header><div>{item.changes.slice(0, 100).map((change, index) => <div className={`change-row ${change.kind}`} key={`${change.path}:${index}`}><code>{change.path}</code><span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'}</span><small>{change.kind !== 'added' && <del>{displayValue(change.before)}</del>}{change.kind !== 'removed' && <ins>{displayValue(change.after)}</ins>}</small></div>)}</div></article>)}</div>}
          </>}
        </section>
      </div>}
    </div>
  );
}

function BomView({ onSaved }) {
  const [bom, setBom] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);

  useEffect(() => { api('/bom').then(setBom).catch(e => setNotice(e.message)); }, []);

  function updateField(index, changes) {
    setBom(prev => ({ ...prev, fields: prev.fields.map((f, i) => i === index ? { ...f, ...changes } : f) }));
  }
  function addField() {
    setBom(prev => ({
      ...prev,
      fields: [...prev.fields, {
        key: 'newField', label: '新字段', type: 'String', kind: 'output',
        group: '未分组', unit: null, min: null, max: null, enum: null, control: 'text', description: '',
      }],
    }));
  }
  async function save() {
    setBusy(true); setNotice('');
    try {
      const res = await api('/bom', { method: 'PUT', body: JSON.stringify({ version: bom.version, fields: bom.fields }) });
      applyBom(res.bom);
      setBom(res.bom);
      setConflict(null);
      setNotice(res.warnings?.length ? `已保存（${res.warnings.length} 条警告）` : 'BOM 已保存');
      onSaved?.();
    } catch (e) {
      if (e.details?.current && e.details?.currentRevision) setConflict(e.details);
      else setNotice(e.message);
    }
    finally { setBusy(false); }
  }

  if (!bom) return <div className="welcome"><p>加载中...</p></div>;

  return (
    <div className="execute-main standalone-main" style={{ padding: 24 }}>
      <div className="section-heading">
        <span className="section-index"><Braces size={16} /></span>
        <div><h3>字段模型（BOM）</h3><p>定义与业务系统交换的事实字段；保存后新规则与 DRL 生成将使用新模型。已部署 Release 不受影响（DRL 已冻结）。</p></div>
      </div>
      {notice && <div className={`notice ${notice.includes('已') ? 'success' : ''}`}><CircleAlert size={16} />{notice}</div>}
      <ConflictNotice conflict={conflict} noun="字段模型" onLoad={() => {
        applyBom(conflict.current);
        setBom(conflict.current);
        setConflict(null);
        setNotice('已载入服务器版本');
      }} />
      <div style={{ margin: '16px 0', color: '#6b7a77', fontSize: 13 }}>
        当前 v{bom.version} · {bom.fields.length} 个字段（{inputFields.length} 输入 / {outputFields.length} 输出）
      </div>
      <table className="decision-table" style={{ width: '100%' }}>
        <thead><tr><th>Key（英文标识）</th><th>中文名</th><th>类型</th><th>方向</th><th>分组</th><th>枚举值（逗号分隔）</th><th>范围</th></tr></thead>
        <tbody>
          {bom.fields.map((f, i) => (
            <tr key={i}>
              <td><input value={f.key} readOnly title="key 一旦被引用不可修改" style={{ fontFamily: 'monospace', fontSize: 12, background: '#f6f9f8' }} /></td>
              <td><input value={f.label} onChange={e => updateField(i, { label: e.target.value })} /></td>
              <td>
                <select value={f.type} onChange={e => updateField(i, { type: e.target.value, enum: e.target.value === 'String' ? f.enum : null })}>
                  {['Integer', 'Double', 'String', 'Boolean'].map(t => <option key={t}>{t}</option>)}
                </select>
              </td>
              <td>
                <select value={f.kind} onChange={e => updateField(i, { kind: e.target.value })}>
                  <option value="input">输入</option>
                  <option value="output">输出</option>
                </select>
              </td>
              <td><input value={f.group || ''} onChange={e => updateField(i, { group: e.target.value })} /></td>
              <td>
                <input
                  disabled={f.type !== 'String'}
                  placeholder={f.type === 'String' ? '低,中,高' : '仅文本字段可配枚举'}
                  value={(f.enum || []).join(',')}
                  onChange={e => updateField(i, { enum: e.target.value.split(',').map(s => s.trim()).filter(Boolean).length ? e.target.value.split(',').map(s => s.trim()).filter(Boolean) : null })}
                />
              </td>
              <td>
                {(f.type === 'Integer' || f.type === 'Double') ? (
                  <input
                    style={{ width: 120 }}
                    placeholder="min..max"
                    value={`${f.min ?? ''}..${f.max ?? ''}`}
                    onChange={e => {
                      const [lo, hi] = e.target.value.split('..');
                      updateField(i, {
                        min: lo?.trim() ? Number(lo) : null,
                        max: hi?.trim() ? Number(hi) : null,
                      });
                    }}
                  />
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
        <button className="secondary" onClick={addField} disabled={busy}><Plus size={16} />新增字段</button>
        <button className="primary" onClick={save} disabled={busy}><Save size={16} />保存 BOM</button>
      </div>
    </div>
  );
}

function App() {
  const [kind, setKind] = useState(initialKind);
  const [assets, setAssets] = useState({ rules: [], tables: [], flows: [] });
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('code');
  const [mobileView, setMobileView] = useState('list');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testFacts, setTestFacts] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [flowDebug, setFlowDebug] = useState({ stopAfter: '', expectedPath: '' });
  const meta = kinds[kind];
  const list = assets[kind] || [];
  const item = list.find(asset => asset.id === selected);

  useEffect(() => {
    Promise.all(['rules', 'tables', 'flows'].map(name => api(`/${name}`)))
      .then(([rules, tables, flows]) => {
        setAssets({ rules, tables, flows });
      })
      .catch(error => setNotice(error.message));
    // 加载 BOM，填充模块级 inputFields/outputFields
    api('/bom').then(bom => applyBom(bom)).catch(error => setNotice(`BOM 加载失败：${error.message}`));
  }, []);
  useEffect(() => {
    setDraft(null);
    setQuery('');
    setFilter('all');
    setMobileView('list');
    setConflict(null);
  }, [kind]);
  useEffect(() => {
    setDraft(item ? clone(item.draft) : null);
    setTestFacts({});
    setTestResult(null);
    setFlowDebug({ stopAfter: '', expectedPath: '' });
    setTab('edit');
    setConflict(null);
  }, [selected, kind]);

  const dirty = item && draft && JSON.stringify(draft) !== JSON.stringify(item.draft);
  const pending = item?.published
    && JSON.stringify(item.draft) !== JSON.stringify(kind === 'flows' ? item.versions.at(-1)?.draft : item.published);
  const activeBom = currentBomObj.fields.length ? currentBomObj : undefined;
  const tableValidation = draft && kind === 'tables' ? validateTable(draft, activeBom) : null;
  const error = draft
    ? kind === 'rules'
      ? validateRule(draft, activeBom)
      : kind === 'tables'
        ? tableValidation.error
        : validateFlow(draft, assets.rules, assets.tables, activeBom)
    : null;
  const warnings = tableValidation?.warnings || [];
  const listed = useMemo(() => list.filter(asset => (
    !asset.archived
    && (filter !== 'published' || asset.published)
    && (filter !== 'draft' || !asset.published)
    && `${asset.draft.name} ${asset.draft.description} ${asset.draft.category || ''}`.toLowerCase().includes(query.toLowerCase())
  )), [list, filter, query]);
  const counts = {
    all: list.filter(asset => !asset.archived).length,
    published: list.filter(asset => !asset.archived && asset.published).length,
    draft: list.filter(asset => !asset.archived && !asset.published).length,
  };

  useEffect(() => {
    const warn = event => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const canLeave = () => !dirty || window.confirm('有未保存的修改，确认放弃并切换吗？');
  const selectKind = next => {
    if (next === kind || !canLeave()) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${next}`);
    setKind(next);
  };
  const update = changes => {
    setDraft(previous => ({ ...previous, ...changes }));
    setTestResult(null);
  };
  const upsert = updated => setAssets(previous => ({
    ...previous,
    [kind]: [updated, ...previous[kind].filter(asset => asset.id !== updated.id)],
  }));
  async function run(operation) {
    setBusy(true);
    setNotice('');
    try {
      await operation();
    } catch (runError) {
      if (runError.details?.current && runError.details?.currentRevision) setConflict(runError.details);
      else setNotice(runError.message);
    } finally {
      setBusy(false);
    }
  }
  function add() {
    if (!canLeave()) return;
    run(async () => {
      const created = await api(`/${kind}`, { method: 'POST' });
      upsert(created);
      setSelected(created.id);
      setMobileView('editor');
    });
  }
  function save() {
    if (error) return setNotice(error);
    run(async () => {
      const updated = await api(`/${kind}/${selected}`, { method: 'PUT', body: JSON.stringify({ revision: item.revision, draft }) });
      upsert(updated);
      setConflict(null);
      setNotice('草稿已保存');
    });
  }
  function publish() {
    if (dirty) return setNotice('请先保存草稿，再发布版本');
    run(async () => {
      const updated = await api(`/${kind}/${selected}/publish`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) });
      upsert(updated);
      setNotice(`已发布 v${updated.versions.at(-1).number}`);
    });
  }
  function testAsset() {
    if (error) return setNotice(error);
    setBusy(true);
    setNotice('');
    (async () => {
      setTestResult(null);
      const facts = outputFacts(testFacts);
      const body = kind === 'rules'
        ? { rule: draft, facts }
        : {
            draft, facts,
            ...(kind === 'flows' && flowDebug.stopAfter ? { stopAfter: flowDebug.stopAfter } : {}),
            ...(kind === 'flows' && flowDebug.expectedPath ? { expectedPath: flowDebug.expectedPath === '__none__' ? null : flowDebug.expectedPath } : {}),
          };
      try {
        setTestResult(await api(`/${kind}/${selected}/test`, { method: 'POST', body: JSON.stringify(body) }));
      } catch (testError) {
        if (testError.details && typeof testError.details === 'object') setTestResult(testError.details);
        else setNotice(testError.message);
      } finally {
        setBusy(false);
      }
    })();
  }
  function restore(version) {
    if (dirty && !window.confirm('恢复版本会覆盖未保存修改，继续吗？')) return;
    run(async () => {
      const updated = await api(`/${kind}/${selected}/restore`, {
        method: 'POST',
        body: JSON.stringify({ version, revision: item.revision }),
      });
      upsert(updated);
      setDraft(clone(updated.draft));
      setNotice(`v${version} 已恢复为草稿，尚未发布`);
    });
  }
  function archive() {
    if (!window.confirm(`归档后${meta.one}将从列表与发布导出中移除。确认归档？`)) return;
    run(async () => {
      const updated = await api(`/${kind}/${selected}/archive`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) });
      upsert(updated);
      setSelected(null);
      setMobileView('list');
      setNotice(`${meta.one}已归档`);
    });
  }

  let preview = '';
  try {
    if (draft && !error) {
      if (kind === 'rules') preview = generateDrl([draft], currentBomObj);
      if (kind === 'tables') preview = tableDrl(draft, currentBomObj);
      if (kind === 'flows') {
        const snapshot = flowSnapshot(draft, assets.rules, assets.tables, currentBomObj);
        const sections = snapshot.steps.map(step => `// 公共步骤 · ${step.name} · v${step.version}\n${step.drl}`);
        for (const branch of snapshot.branches || []) {
          sections.push(...branch.steps.map(step => `// 分支：${branch.name}${branch.default ? '（默认）' : ''} · ${step.name} · v${step.version}\n${step.drl}`));
        }
        preview = sections.join('\n');
      }
    }
  } catch {
    preview = '';
  }
  const currentVersion = item?.versions.at(-1)?.number;

  return (
    <div className={`app ${mobileView === 'editor' ? 'mobile-editor' : ''}`}>
      <nav className="mobile-nav" aria-label="工作空间导航">
        {Object.entries(kinds).map(([key, entry]) => (
          <button key={key} className={kind === key ? 'active' : ''} onClick={() => selectKind(key)}>
            <entry.Icon size={16} />{entry.label}
          </button>
        ))}
      </nav>
      <aside className="rail">
        <div className="brand"><div className="brand-mark"><Braces size={22} strokeWidth={2.4} /></div><span>规则工作台<small>RULES WORKBENCH</small></span></div>
        <div className="rail-label">工作空间</div>
        {Object.entries(kinds).map(([key, entry]) => (
          <button key={key} className={`rail-link ${kind === key ? 'active' : ''}`} onClick={() => selectKind(key)}>
            <entry.Icon size={18} />{entry.label}
          </button>
        ))}
        <div className="rail-spacer" />
        <div className="rail-info"><span className="rail-info-icon"><Settings2 size={17} /></span><div><b>Drools 规则资产</b><small>结构化编辑 · DRL 校验</small></div></div>
      </aside>
      {kind === 'execute' ? (
        <main className="execute-main standalone-main"><ExecuteView /></main>
      ) : kind === 'tests' ? (
        <main className="execute-main standalone-main"><TestSuitesView /></main>
      ) : kind === 'releases' ? (
        <main className="execute-main standalone-main"><ReleaseView /></main>
      ) : kind === 'governance' ? (
        <main className="execute-main standalone-main"><GovernanceView /></main>
      ) : kind === 'bom' ? (
        <main className="execute-main standalone-main"><BomView /></main>
      ) : (<>
      <section className="list-panel">
        <div className="list-top"><div><span className="eyebrow">规则资产</span><h1>{meta.label}</h1></div><IconButton icon={Plus} label={`新建${meta.one}`} onClick={add} disabled={busy} /></div>
        <div className="search"><Search size={16} /><input placeholder="搜索名称、分类或说明" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton icon={X} label="清除搜索" onClick={() => setQuery('')} />}</div>
        <div className="filters">{[['all', '全部'], ['published', '已发布'], ['draft', '未发布']].map(([key, label]) => <button key={key} className={filter === key ? 'chosen' : ''} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div>
        <div className="list-caption"><span>{listed.length} 个{meta.one}</span>{kind !== 'flows' && <button onClick={() => { window.location.href = '/api/export'; }}><ArrowDownToLine size={15} />导出 DRL</button>}</div>
        <div className="rule-list">
          {listed.map(asset => (
            <button key={asset.id} onClick={() => { if (asset.id === selected || canLeave()) { setSelected(asset.id); setMobileView('editor'); } }} className={`rule-item ${selected === asset.id ? 'selected' : ''}`}>
              <div className="rule-item-head"><strong>{asset.draft.name}</strong><span className={`status-dot ${asset.published ? 'live' : ''}`} /></div>
              <p>{asset.draft.description || '暂无说明'}</p>
              <div className="rule-meta"><span>{asset.draft.category || '执行编排'}</span><span>{asset.published ? `v${asset.versions.at(-1)?.number} 已发布` : '草稿'}</span><span>{fmt(asset.updatedAt)}</span></div>
            </button>
          ))}
          {!listed.length && <div className="list-empty"><Filter size={21} /><p>没有匹配的{meta.one}</p><button onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button></div>}
        </div>
        <div className="list-footer">数据保存在本机服务 · 无账号权限控制</div>
      </section>
      <main className="workspace">
        {!draft ? <div className="welcome"><div className="welcome-icon"><FileCode2 size={28} /></div><h2>选择一个{meta.one}开始编辑</h2><p>在左侧查看资产，或新建一个{meta.one}。</p><button className="primary" onClick={add}><Plus size={17} />新建{meta.one}</button></div> : <>
          <header className="workspace-header">
            <div className="header-title"><IconButton icon={ChevronLeft} label="返回列表" className="back" onClick={() => setMobileView('list')} /><div className="breadcrumb">{meta.label} <span>/</span> {draft.category || '执行编排'}</div><div className="title-line"><h2>{draft.name}</h2><span className={`badge ${item?.published ? 'published' : ''}`}>{item?.published ? `已发布 v${currentVersion}` : '未发布'}</span><span className="revision-badge">修订 r{item?.revision || 1}</span>{pending && <span className="unsaved">待发布修改</span>}{dirty && <span className="unsaved">未保存</span>}</div></div>
            <div className="header-actions"><IconButton icon={Archive} label={`归档${meta.one}`} onClick={archive} disabled={busy} /><button className="secondary" onClick={save} disabled={busy || !dirty}><Save size={16} />保存草稿</button><button className="primary" onClick={publish} disabled={busy || !!error || !!dirty}><CloudUpload size={17} />发布版本</button></div>
          </header>
          {notice && <div className={`notice ${notice.includes('已') ? 'success' : ''}`}><CircleAlert size={16} />{notice}<IconButton icon={X} label="关闭提示" onClick={() => setNotice('')} /></div>}
          <ConflictNotice conflict={conflict} noun={meta.one} onLoad={() => {
            upsert(conflict.current);
            setDraft(clone(conflict.current.draft));
            setConflict(null);
            setNotice('已载入服务器版本');
          }} />
          <div className="editor-tabs">
            <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}><Settings2 size={16} />{kind === 'tables' ? '表格编辑' : kind === 'flows' ? '流程编排' : '规则编辑'}</button>
            <button className={tab === 'test' ? 'active' : ''} onClick={() => setTab('test')}><Play size={16} />试运行</button>
            <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}><FileCode2 size={16} />{kind === 'flows' ? '流程预览' : 'DRL 预览'}</button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><Clock3 size={16} />版本记录 <span>{item?.versions.length}</span></button>
          </div>
          <div className="editor-scroll">
            {tab === 'edit' && (kind === 'rules' ? <RuleEditor draft={draft} update={update} /> : kind === 'tables' ? <TableEditor draft={draft} update={update} warnings={warnings} trace={testResult?.decisionTrace} /> : <FlowEditor draft={draft} update={update} rules={assets.rules} tables={assets.tables} />)}
            {error && tab === 'edit' && <div className="validation editor-error"><CircleAlert size={17} />{error}</div>}
            {tab === 'test' && <div className="test-view"><div className="section-heading"><span className="section-index">T</span><div><h3>试运行</h3><p>{kind === 'flows' ? '依次运行公共步骤、应用节点字段映射，并在条件网关选择首个匹配分支。' : '以当前编辑内容运行，留空的输入字段不会赋值。'}</p></div></div><FactForm facts={testFacts} setFacts={facts => { setTestFacts(facts); setTestResult(null); }} />{kind === 'flows' && <FlowDebugControls draft={draft} assets={assets} value={flowDebug} onChange={next => { setFlowDebug(next); setTestResult(null); }} />}<button className="primary test-run" onClick={testAsset} disabled={busy || !!error}><Play size={16} />运行测试</button><Result result={testResult} flow={kind === 'flows'} /></div>}
            {tab === 'code' && <div className="code-view"><div className="code-toolbar"><div><h3>{kind === 'flows' ? '当前流程预览' : 'DRL 预览'}</h3><p>{kind === 'flows' ? '根据当前草稿引用的已发布规则生成；发布后会固定每一步的版本与 DRL。' : '根据当前编辑内容生成；发布导出仅包含已保存并发布的版本。'}</p></div><button className="secondary" disabled={!preview} onClick={() => navigator.clipboard.writeText(preview).then(() => setNotice('内容已复制')).catch(() => setNotice('复制失败'))}><Copy size={15} />复制代码</button></div>{error ? <div className="validation"><CircleAlert size={17} />{error}</div> : preview ? <pre><code>{preview}</code></pre> : <div className="no-versions">{kind === 'flows' ? '添加步骤后生成流程预览' : '尚无可预览内容'}</div>}</div>}
            {tab === 'history' && <div className="history-view"><h3>发布版本</h3><p>发布版本冻结规则内容、DRL 和字段模型；草稿修订用于追踪保存与恢复，不会自动上线。</p>{item?.versions.length ? [...item.versions].reverse().map((version, index) => <div className="version-row" key={version.number}><span className="version-icon"><GitBranch size={18} /></span><div><b>版本 v{version.number}</b>{index === 0 && <span className="latest">当前发布</span>}<small>{fmt(version.createdAt)} · {version.draft?.name || version.rule?.name || draft.name} · {version.bomVersion ? `BOM v${version.bomVersion}` : 'Legacy 模型'}</small></div><button className="secondary" onClick={() => restore(version.number)} disabled={busy}><RotateCcw size={15} />恢复为草稿</button></div>) : <div className="no-versions">尚无发布版本</div>}<h3 className="revision-title">草稿修订</h3>{[...(item?.revisions || [])].reverse().map((revision, index) => <div className="version-row revision-row" key={revision.number}><span className="version-icon"><Save size={17} /></span><div><b>修订 r{revision.number}</b>{index === 0 && <span className="latest">当前草稿</span>}<small>{fmt(revision.createdAt)} · {revision.reason === 'restored' ? '从发布版本恢复' : revision.reason === 'created' ? '创建资产' : '保存草稿'} · {revision.draft?.name || draft.name}</small></div></div>)}</div>}
          </div>
          <footer className="workspace-footer"><span><span className="footer-dot" />{item?.published ? `线上版本 v${currentVersion}` : '尚未发布'}{pending ? ' · 有待发布修改' : ''}{dirty ? ' · 有未保存修改' : ''}</span><span>{kind === 'flows' ? '排他网关 · 节点字段映射 · 发布快照' : '字段模型：RuleInput · 规则语言：DRL'}</span></footer>
        </>}
      </main>
      </>)}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
