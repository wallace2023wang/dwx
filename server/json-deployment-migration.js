import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultEnvironments, migrateLegacyDeployments, normalizeActiveDeployments } from '../shared/deployments.js';

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

export async function migrateJsonDeploymentDomain({ releasesFile, deploymentsFile, environmentsFile, targetsFile }) {
  const releases = await readJson(releasesFile, []);
  const existingDeployments = await readJson(deploymentsFile, []);
  const existingEnvironments = await readJson(environmentsFile, []);
  const releasesByProject = new Map();
  for (const release of releases) {
    const projectId = release.projectId || 'default';
    if (!releasesByProject.has(projectId)) releasesByProject.set(projectId, []);
    releasesByProject.get(projectId).push(release);
  }
  const migrated = [...releasesByProject.entries()].flatMap(([projectId, projectReleases]) => (
    migrateLegacyDeployments(projectReleases, projectId)
  ));
  const cleanedReleases = releases.map(release => {
    const cleaned = { ...release };
    delete cleaned.deployments;
    return cleaned;
  });
  const deploymentIds = new Set(existingDeployments.map(item => item.id));
  const nextDeployments = normalizeActiveDeployments([
    ...existingDeployments,
    ...migrated.filter(item => !deploymentIds.has(item.id)),
  ]);
  const projectIds = new Set([
    ...cleanedReleases.map(item => item.projectId || 'default'),
    ...existingEnvironments.map(item => item.projectId || 'default'),
    'default',
  ]);
  const environmentKeys = new Set(existingEnvironments.map(item => `${item.projectId || 'default'}\u0000${item.id}`));
  const nextEnvironments = [...existingEnvironments];
  for (const projectId of projectIds) {
    for (const environment of defaultEnvironments(projectId)) {
      if (!environmentKeys.has(`${projectId}\u0000${environment.id}`)) nextEnvironments.push(environment);
    }
  }
  if (migrated.length || releases.some(release => Object.hasOwn(release, 'deployments'))) await writeJson(releasesFile, cleanedReleases);
  if (migrated.length || JSON.stringify(nextDeployments) !== JSON.stringify(existingDeployments)) await writeJson(deploymentsFile, nextDeployments);
  if (nextEnvironments.length !== existingEnvironments.length) await writeJson(environmentsFile, nextEnvironments);
  let platformTargets = [];
  if (targetsFile) {
    const existingTargets = await readJson(targetsFile, []);
    platformTargets = [...new Map(existingTargets.map(target => {
      const { projectId: _projectId, ...platformTarget } = target;
      return [platformTarget.id, platformTarget];
    })).values()];
    if (JSON.stringify(platformTargets) !== JSON.stringify(existingTargets)) await writeJson(targetsFile, platformTargets);
  }
  return { deployments: migrated.length, releases: cleanedReleases.length, environments: nextEnvironments.length, targets: platformTargets.length };
}
