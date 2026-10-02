export function createGovernanceService({ getPostgresStore, readRules, readAssets, readChangeSets }) {
  async function currentConflictResource(resource, projectId = 'default') {
    const separator = resource.indexOf(':');
    const type = resource.slice(0, separator);
    const id = resource.slice(separator + 1);
    const postgresStore = getPostgresStore();
    if (type === 'bom') return postgresStore?.getBom(projectId);
    if (type === 'test-suite') return (await readAssets('testSuites', projectId)).find(item => item.id === id) || null;
    if (type === 'change-set') return (await readChangeSets(projectId)).find(item => item.id === id) || null;
    if (['rule', 'table', 'flow', 'event-stream'].includes(type)) {
      const items = type === 'rule' ? await readRules(projectId) : await readAssets(type === 'event-stream' ? 'eventStreams' : `${type}s`, projectId);
      return items.find(item => item.id === id) || null;
    }
    return null;
  }

  function submittedChangeSetForAsset(changeSets, assetId) {
    return changeSets.find(changeSet => changeSet.status === 'SUBMITTED'
      && changeSet.items?.some(entry => entry.assetId === assetId));
  }

  function reviewLock(changeSets, assetId) {
    const changeSet = submittedChangeSetForAsset(changeSets, assetId);
    return changeSet ? {
      status: 409,
      error: `资产正在变更集“${changeSet.name}”中审核，审核完成后才能修改`,
      changeSetId: changeSet.id,
    } : null;
  }

  return { currentConflictResource, submittedChangeSetForAsset, reviewLock };
}
