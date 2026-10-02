import crypto from 'node:crypto';
import { defaultBom } from '../shared/bom.js';

export const VALID_PROJECT_ENGINES = new Set(['rules', 'cep']);

export const normalizeProjectEngine = value => VALID_PROJECT_ENGINES.has(value) ? value : 'rules';

export const normalizeProjectRecord = project => ({ ...project, engine: normalizeProjectEngine(project?.engine) });

export function defaultProjectRecord() {
  return {
    id: 'default', name: '默认风控项目', description: 'Team Server 当前 default 工作空间中的真实规则资产',
    icon: 'shield', engine: 'rules', version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local', archived: false,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: new Date().toISOString(), updatedBy: 'Team Server',
  };
}

function blankBom() {
  return { version: 1, updatedAt: new Date().toISOString(), fields: [], eventTypes: [] };
}

function grainBomTemplate() {
  const bom = defaultBom();
  bom.fields = [
    { key: 'eventId', label: '事件 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'sampledAt', label: '采样时间', type: 'String', semanticType: 'Date', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'date', description: '' },
    { key: 'warehouseId', label: '粮仓 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'sensorId', label: '传感器 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓温控事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '' },
    { key: 'averageTemperature', label: '整仓均温', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓', group: '温控监测', unit: '°C', min: -50, max: 80, enum: null, control: 'number', description: '' },
    { key: 'humidity', label: '仓内湿度', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'GrainStore', factTypeLabel: '粮仓', group: '温控监测', unit: '%', min: 0, max: 100, enum: null, control: 'number', description: '' },
    { key: 'ventilationRequired', label: '是否通风', type: 'Boolean', semanticType: 'Boolean', kind: 'output', factType: 'ControlDecision', factTypeLabel: '调控决策', group: '结果输出', unit: null, min: null, max: null, enum: null, control: 'boolean', description: '' },
  ];
  bom.eventTypes = [{
    name: 'GrainStore',
    label: '粮仓温控采样事件',
    version: 1,
    keyField: 'warehouseId',
    timeField: 'sampledAt',
    sourceField: 'sensorId',
    retention: '24h',
    allowedLateness: '5m',
    duplicateKey: ['eventId'],
    fields: [
      { field: 'eventId', required: true },
      { field: 'warehouseId', required: true },
      { field: 'sensorId', required: true },
      { field: 'sampledAt', required: true },
      { field: 'averageTemperature', required: true },
      { field: 'humidity', required: false },
    ],
  }];
  return bom;
}

export function createProjectRecordFactory({
  readProjectRecords,
  readBom,
  projectData,
  readPackageRecords,
  writeProjectRecords,
  writeBom,
  writePackageRecords,
  getPostgresStore,
}) {
  return async function createProjectRecord(payload, actor) {
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    if (!name || name.length > 80) return { status: 400, error: '项目名称需为 1-80 个字符' };
    const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
    if (description.length > 500) return { status: 400, error: '项目描述不能超过 500 个字符' };
    const icon = ['loan', 'warehouse', 'shield'].includes(payload?.icon) ? payload.icon : 'shield';
    const engine = payload?.engine == null ? 'rules' : payload.engine;
    if (!VALID_PROJECT_ENGINES.has(engine)) return { status: 400, error: '项目引擎类型必须是 rules 或 cep' };
    const existing = await readProjectRecords(true);
    if (existing.some(project => project.name === name)) return { status: 409, error: '项目名称已存在' };
    const id = `project-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const project = { id, name, description, icon, engine, version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local', archived: false, createdAt: now, updatedAt: now, updatedBy: actor };
    let bom = blankBom();
    let packages = [];
    if (payload?.bomTemplate === 'loan' || payload?.bomTemplate === 'risk') bom = defaultBom();
    else if (payload?.bomTemplate === 'grain') bom = grainBomTemplate();
    else if (typeof payload?.copyProjectId === 'string') {
      const source = existing.find(item => item.id === payload.copyProjectId);
      if (!source) return { status: 400, error: '复制来源项目不存在' };
      bom = structuredClone(await readBom(source.id));
      bom.version = 1;
      bom.updatedAt = now;
      const sourceData = await projectData(source.id);
      packages = structuredClone(await readPackageRecords(source.id, sourceData));
    }
    const postgresStore = getPostgresStore();
    if (postgresStore) await postgresStore.createProject(project, bom, packages);
    else {
      await writeProjectRecords([...existing, project]);
      await writeBom(bom, null, id);
      await writePackageRecords(id, packages);
    }
    return { item: { ...project, packageCount: packages.length, assetCount: 0, environmentCount: 0, source: 'server' } };
  };
}
