export function createMutationService({
  readRules,
  writeRules,
  readAssets,
  writeAssets,
  readReleases,
  writeReleases,
  readApplicationPackages,
  writeApplicationPackages,
  readTargets,
  writeTargets,
  readActivationGenerations,
  writeActivationGenerations,
  readDeployments,
  writeDeployments,
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

  function mutateProjectAssets(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const [rules, tables, flows, eventStreams] = await Promise.all([
        readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId), readAssets('eventStreams', projectId),
      ]);
      const collections = { rule: rules, table: tables, flow: flows, 'event-stream': eventStreams };
      const result = await operation(collections);
      if (result?.changed) {
        await writeRules(rules, projectId);
        await writeAssets('tables', tables, projectId);
        await writeAssets('flows', flows, projectId);
        await writeAssets('eventStreams', eventStreams, projectId);
      }
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateRuleProjectImport(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const [rules, tables, flows, packages] = await Promise.all([
        readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId), readPackageRecords(projectId),
      ]);
      const collections = { rules, tables, flows, packages };
      const result = await operation(collections);
      if (result?.changed) {
        await writeRules(rules, projectId);
        await writeAssets('tables', tables, projectId);
        await writeAssets('flows', flows, projectId);
        await writePackageRecords(projectId, packages);
      }
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

  function mutateDeployments(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const deployments = await readDeployments(projectId);
      const result = await operation(deployments);
      if (result?.changed) await writeDeployments(deployments, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateApplicationPackages(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const applicationPackages = await readApplicationPackages(projectId);
      const result = await operation(applicationPackages);
      if (result?.changed) await writeApplicationPackages(applicationPackages, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateTargets(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const targets = await readTargets(projectId);
      const result = await operation(targets);
      if (result?.changed) await writeTargets(targets, projectId);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function mutateActivationGenerations(operation, projectId = 'default') {
    const pending = queue.then(async () => {
      const generations = await readActivationGenerations(projectId);
      const result = await operation(generations);
      if (result?.changed) await writeActivationGenerations(generations, projectId);
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
    mutateProjectAssets,
    mutateRuleProjectImport,
    mutateReleases,
    mutateDeployments,
    mutateApplicationPackages,
    mutateTargets,
    mutateActivationGenerations,
    mutateTestSuites,
    mutateChangeSets,
  };
}
