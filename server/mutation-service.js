export function createMutationService({
  readRules,
  writeRules,
  readAssets,
  writeAssets,
  readReleases,
  writeReleases,
  readPackageRecords,
  writePackageRecords,
  readChangeSets,
  writeChangeSets,
}) {
  // Serialize write paths so concurrent requests cannot overwrite snapshots.
  let queue = Promise.resolve();
  let packageQueue = Promise.resolve();
  let reviewQueue = Promise.resolve();

  function serializeReview(operation) {
    const pending = reviewQueue.then(operation);
    reviewQueue = pending.catch(() => {});
    return pending;
  }

  function mutatePackageRecords(projectId, data, operation) {
    const pending = packageQueue.then(async () => {
      const packages = await readPackageRecords(projectId, data);
      const result = await operation(packages);
      if (result?.changed) await writePackageRecords(projectId, packages);
      return result;
    });
    packageQueue = pending.catch(() => {});
    return pending;
  }

  function mutate(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const rules = await readRules(projectId);
      const result = await operation(rules);
      await writeRules(rules, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateAssets(kind, operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const assets = await readAssets(kind, projectId);
      const result = await operation(assets);
      if (result?.item || result?.changed) await writeAssets(kind, assets, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateReleases(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const releases = await readReleases(projectId);
      const result = await operation(releases);
      if (result?.changed) await writeReleases(releases, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateTestSuites(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const suites = await readAssets('testSuites', projectId);
      const result = await operation(suites);
      if (result?.changed) await writeAssets('testSuites', suites, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateChangeSets(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const changeSets = await readChangeSets(projectId);
      const result = await operation(changeSets);
      if (result?.changed) await writeChangeSets(changeSets, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  return {
    serializeReview,
    mutatePackageRecords,
    mutate,
    mutateAssets,
    mutateReleases,
    mutateTestSuites,
    mutateChangeSets,
  };
}
