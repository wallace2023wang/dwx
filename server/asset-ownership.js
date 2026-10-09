export function assetOwner(item) {
  return item?.ownerId ? { id: item.ownerId, name: item.ownerName || item.ownerId } : null;
}

export function canManageAssetDraft(principal, item) {
  if (principal?.mode === 'local') return true;
  if (principal?.permissions?.includes('*') || principal?.roles?.includes('admin')) return true;
  return !item?.ownerId || item.ownerId === principal?.id;
}

export function draftOwnershipError(principal, item) {
  if (canManageAssetDraft(principal, item)) return null;
  return { status: 403, error: `该草稿由 ${item.ownerName || item.ownerId} 负责，请由负责人或管理员操作` };
}

export function claimAssetDraft(item, principal) {
  if (!item.ownerId && principal?.id) {
    item.ownerId = principal.id;
    item.ownerName = principal.name || principal.id;
  }
  return item;
}

export function assignAssetOwner(item, ownerId, ownerName = ownerId) {
  item.ownerId = ownerId;
  item.ownerName = ownerName || ownerId;
  return item;
}
