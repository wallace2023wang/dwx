function isActiveRuleset(item) {
  return Boolean(item) && !item.archived && (item.lifecycleStatus || 'active') === 'active';
}

export function rulesetNameKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

export function nextRulesetName(flows, baseName = '未命名规则集') {
  const used = new Set(flows.filter(isActiveRuleset).map(item => rulesetNameKey(item.draft?.name)).filter(Boolean));
  if (!used.has(rulesetNameKey(baseName))) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!used.has(rulesetNameKey(candidate))) return candidate;
  }
}

export function rulesetNameConflict(flows, item, nextName, options = {}) {
  const key = rulesetNameKey(nextName);
  if (!key) return null;
  if (options.allowUnchanged && rulesetNameKey(item?.draft?.name) === key) return null;
  const duplicate = flows.find(candidate => candidate.id !== item?.id
    && isActiveRuleset(candidate)
    && rulesetNameKey(candidate.draft?.name) === key
    && (!options.publishedOnly || candidate.published));
  if (!duplicate) return null;
  return {
    status: 409,
    code: 'RULESET_NAME_CONFLICT',
    error: `规则集名称“${nextName.trim()}”已被同项目中的另一个规则集使用，请改名或归档重复规则集`,
    details: { conflictingRulesetId: duplicate.id, conflictingRulesetName: duplicate.draft.name },
  };
}
