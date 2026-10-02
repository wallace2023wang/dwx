const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function pathOf(parent, key) {
  return parent ? `${parent}.${key}` : String(key);
}

function keyedArray(values) {
  return values.length > 0 && values.every(value => isObject(value) && typeof value.id === 'string' && value.id);
}

export function structuredDiff(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === undefined) return [{ path: path || '$', kind: 'added', after }];
  if (after === undefined) return [{ path: path || '$', kind: 'removed', before }];

  if (Array.isArray(before) && Array.isArray(after)) {
    if (keyedArray(before) && keyedArray(after)) {
      const left = new Map(before.map(value => [value.id, value]));
      const right = new Map(after.map(value => [value.id, value]));
      const ids = [...new Set([...left.keys(), ...right.keys()])];
      return ids.flatMap(id => structuredDiff(left.get(id), right.get(id), `${path}[${id}]`));
    }
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) => structuredDiff(before[index], after[index], `${path}[${index}]`)).flat();
  }

  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(key => structuredDiff(before[key], after[key], pathOf(path, key)));
  }

  return [{ path: path || '$', kind: 'changed', before, after }];
}

export function summarizeDiff(changes) {
  return changes.reduce((summary, change) => {
    summary[change.kind] += 1;
    return summary;
  }, { added: 0, removed: 0, changed: 0 });
}

export function normalizeChangeSetReferences(items) {
  if (!Array.isArray(items)) return items;
  return items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const rawType = item.type ?? item.kind;
    const type = rawType === 'decision-table' ? 'table' : rawType;
    return { ...item, type };
  });
}

export function validateChangeSet(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '变更集格式无效';
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) return '变更集名称长度应为 1-100 个字符';
  if (input.description != null && (typeof input.description !== 'string' || input.description.length > 1000)) return '变更集说明不能超过 1000 个字符';
  if (!Array.isArray(input.items) || input.items.length > 50) return '变更集最多包含 50 个资产';
  const seen = new Set();
  for (const item of normalizeChangeSetReferences(input.items)) {
    if (!item || !['rule', 'table', 'flow', 'event-stream'].includes(item.type) || typeof item.id !== 'string' || !item.id) return '变更集包含无效资产引用';
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return '同一资产不能重复加入变更集';
    seen.add(key);
  }
  return null;
}

export function snapshotChangeItem(type, asset) {
  const latest = asset.versions?.at(-1);
  const before = latest ? structuredClone(latest.rule || latest.draft || null) : null;
  const after = structuredClone(asset.draft);
  const changes = structuredDiff(latest ? before : undefined, after).slice(0, 500);
  return {
    assetType: type,
    assetId: asset.id,
    assetRevision: asset.revision || 1,
    baseVersion: latest?.number || null,
    name: asset.draft?.name || '未命名资产',
    before,
    after,
    changes,
    summary: summarizeDiff(changes),
  };
}
