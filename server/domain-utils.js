import { canonicalPackageName, packageLabel } from '../shared/packages.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeAssetGovernance(input = {}) {
  const rawTags = input.tags == null ? [] : input.tags;
  if (!Array.isArray(rawTags)) throw new Error('标签必须是数组');
  const tags = [...new Set(rawTags.map(tag => typeof tag === 'string' ? tag.trim() : '').filter(Boolean))];
  if (tags.length > 10 || tags.some(tag => tag.length > 24)) throw new Error('标签最多 10 个，每个不超过 24 个字符');
  const effectiveFrom = input.effectiveFrom == null || input.effectiveFrom === '' ? null : input.effectiveFrom;
  const effectiveTo = input.effectiveTo == null || input.effectiveTo === '' ? null : input.effectiveTo;
  if ((effectiveFrom && (typeof effectiveFrom !== 'string' || !DATE_RE.test(effectiveFrom)))
    || (effectiveTo && (typeof effectiveTo !== 'string' || !DATE_RE.test(effectiveTo)))) {
    throw new Error('有效期必须使用 YYYY-MM-DD 格式');
  }
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) throw new Error('有效期开始日期不能晚于结束日期');
  return { tags, effectiveFrom, effectiveTo };
}

export function assetGovernance(item) {
  return {
    tags: Array.isArray(item?.tags) ? item.tags : [],
    effectiveFrom: item?.effectiveFrom || null,
    effectiveTo: item?.effectiveTo || null,
  };
}

export function initializeAssetRevision(item, reason = 'created') {
  const now = item.updatedAt || new Date().toISOString();
  if (item.archived) item.lifecycleStatus = 'archived';
  else item.lifecycleStatus ||= 'active';
  item.archived = item.lifecycleStatus === 'archived';
  item.revision = item.revision || 1;
  Object.assign(item, assetGovernance(item));
  item.revisions ||= [{ number: item.revision, createdAt: now, reason, draft: structuredClone(item.draft) }];
  return item;
}

export function isActiveAsset(item) {
  return Boolean(item) && !item.archived && (item.lifecycleStatus || 'active') === 'active';
}

export function normalizePackageReferences(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizePackageReferences(item);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (typeof value.category === 'string') value.category = canonicalPackageName(value.category);
  for (const item of Object.values(value)) normalizePackageReferences(item);
  return value;
}

export function normalizeAssetPackages(item) {
  return normalizePackageReferences(item);
}

export function normalizePackageRecords(records = []) {
  const normalized = new Map();
  for (const record of records) {
    const originalName = typeof record?.name === 'string' ? record.name.trim() : '';
    const name = canonicalPackageName(originalName);
    if (!name) continue;
    const parentId = record.parentId ? canonicalPackageName(record.parentId) : null;
    const label = typeof record.label === 'string' && record.label.trim() && record.label.trim() !== originalName
      ? record.label.trim()
      : packageLabel(originalName);
    const next = { ...record, name, label, parentId };
    const existing = normalized.get(name);
    normalized.set(name, existing ? { ...next, assets: existing.assets } : next);
  }
  return [...normalized.values()];
}

export function advanceAssetRevision(item, reason, captureDraft = false) {
  initializeAssetRevision(item);
  item.revision += 1;
  item.updatedAt = new Date().toISOString();
  if (captureDraft) item.revisions.push({
    number: item.revision, createdAt: item.updatedAt, reason, draft: structuredClone(item.draft),
  });
}
