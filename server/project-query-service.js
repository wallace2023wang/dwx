export function createProjectQueryService({
  readRules,
  readAssets,
  readReleases,
  readBom,
  readChangeSets,
  normalizeProjectEngine,
  projectPackages,
  canAccessAsset,
  getCurrentBom,
}) {
  async function projectData(projectId = 'default') {
    const [rules, tables, flows, eventStreams, releases, bom, changeSets, testSuites] = await Promise.all([
      readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId), readAssets('eventStreams', projectId), readReleases(projectId), readBom(projectId), readChangeSets(projectId), readAssets('testSuites', projectId),
    ]);
    return {
      allRules: rules,
      allTables: tables,
      allEventStreams: eventStreams,
      rules: rules.filter(item => !item.archived),
      tables: tables.filter(item => !item.archived),
      flows: flows.filter(item => !item.archived),
      eventStreams: eventStreams.filter(item => !item.archived),
      releases, bom, changeSets, testSuites: testSuites.filter(item => !item.archived),
    };
  }

  function projectSummary(project, { rules, tables, flows, eventStreams = [], releases }, packages = []) {
    const assets = normalizeProjectEngine(project.engine) === 'cep' ? eventStreams : [...rules, ...tables];
    const categories = new Set(assets.map(item => item.draft.category || '未分类'));
    const latestRelease = releases.reduce((latest, release) => Math.max(latest, Number(release.version) || 0), 0);
    const environments = new Set(releases.flatMap(release => (release.deployments || [])
      .filter(deployment => deployment.status !== 'stopped')
      .map(deployment => deployment.environment)));
    const updatedAt = [...assets, ...flows].map(item => item.updatedAt).filter(Boolean).sort().at(-1) || new Date(0).toISOString();
    return {
      ...project,
      packageCount: packages.length || categories.size,
      assetCount: assets.length,
      version: `v${latestRelease || 1}.0.0`,
      environmentCount: environments.size,
      updatedAt: updatedAt === new Date(0).toISOString() ? project.updatedAt : updatedAt,
      source: 'server',
    };
  }

  function visibleProjectPackages(principal, rules, tables, packageRecords = [], bom = getCurrentBom(), changeSets = []) {
    return projectPackages(rules, tables, packageRecords, bom, changeSets)
      .map(pkg => ({ ...pkg, assets: pkg.assets.filter(asset => canAccessAsset(principal, asset.id)) }));
  }

  return { projectData, projectSummary, visibleProjectPackages };
}
