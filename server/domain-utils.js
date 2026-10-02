import { canonicalPackageName, packageLabel } from '../shared/packages.js';

export function initializeAssetRevision(item, reason = 'created') {
  const now = item.updatedAt || new Date().toISOString();
  item.revision = item.revision || 1;
  item.revisions ||= [{ number: item.revision, createdAt: now, reason, draft: structuredClone(item.draft) }];
  return item;
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
