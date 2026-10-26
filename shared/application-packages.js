import { createHash } from 'node:crypto';

export const APPLICATION_PACKAGE_SCHEMA_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function checksum(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex')}`;
}

function releaseEngine(release) {
  return release?.engine?.type === 'esper' ? 'esper' : release?.engine?.type === 'drools' ? 'drools' : null;
}

function assertPackageRelease(release) {
  if (!release) throw new Error('Release 不存在');
  if (!['flow', 'event-stream'].includes(release.target?.type)) {
    throw new Error('应用包只能引用规则集或事件流 Release');
  }
  if (!release.decisionService || !release.target.id || !release.checksum || !releaseEngine(release)) {
    throw new Error('Release 缺少应用包所需的冻结信息');
  }
}

export function manifestContent(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    applicationPackageId: manifest.applicationPackageId,
    version: manifest.version,
    decisionService: manifest.decisionService,
    rulesetPath: manifest.rulesetPath,
    targetType: manifest.targetType,
    engine: manifest.engine,
    releaseId: manifest.releaseId,
    releaseVersion: manifest.releaseVersion,
    releaseDisplayVersion: manifest.releaseDisplayVersion,
    releaseChecksum: manifest.releaseChecksum,
  };
}

export function manifestChecksum(manifest) {
  return checksum(manifestContent(manifest));
}

export function buildApplicationManifest(applicationPackage, release, {
  id,
  createdAt = new Date().toISOString(),
  createdBy = 'Team Server',
} = {}) {
  assertPackageRelease(release);
  if (!applicationPackage?.id || !id) throw new Error('应用包或 manifest ID 无效');
  if (applicationPackage.decisionService !== release.decisionService
      || applicationPackage.rulesetPath !== release.target.id
      || applicationPackage.targetType !== release.target.type
      || applicationPackage.engine !== releaseEngine(release)) {
    throw new Error('Release 与应用包固定的决策服务、目标路径或执行引擎不一致');
  }
  if ((applicationPackage.manifests || []).some(item => item.releaseId === release.id)) {
    return applicationPackage.manifests.find(item => item.releaseId === release.id);
  }
  const manifest = {
    schemaVersion: APPLICATION_PACKAGE_SCHEMA_VERSION,
    id,
    applicationPackageId: applicationPackage.id,
    version: Math.max(0, ...(applicationPackage.manifests || []).map(item => Number(item.version) || 0)) + 1,
    decisionService: release.decisionService,
    rulesetPath: release.target.id,
    targetType: release.target.type,
    engine: releaseEngine(release),
    releaseId: release.id,
    releaseVersion: release.version,
    releaseDisplayVersion: release.displayVersion || `${release.version}.0.0`,
    releaseChecksum: release.checksum,
    createdAt,
    createdBy,
  };
  manifest.checksum = manifestChecksum(manifest);
  return manifest;
}

export function createApplicationPackage({
  id,
  name,
  projectId = 'default',
  release,
  manifestId,
  createdAt = new Date().toISOString(),
  createdBy = 'Team Server',
}) {
  assertPackageRelease(release);
  const packageName = typeof name === 'string' ? name.trim() : '';
  if (!id || !manifestId) throw new Error('应用包 ID 无效');
  if (!packageName || packageName.length > 80) throw new Error('应用包名称需为 1-80 个字符');
  const applicationPackage = {
    schemaVersion: APPLICATION_PACKAGE_SCHEMA_VERSION,
    id,
    projectId,
    name: packageName,
    decisionService: release.decisionService,
    rulesetPath: release.target.id,
    targetType: release.target.type,
    engine: releaseEngine(release),
    createdAt,
    updatedAt: createdAt,
    createdBy,
    manifests: [],
  };
  applicationPackage.manifests.push(buildApplicationManifest(applicationPackage, release, {
    id: manifestId, createdAt, createdBy,
  }));
  return applicationPackage;
}

export function appendApplicationManifest(applicationPackage, release, options) {
  const existing = (applicationPackage.manifests || []).find(item => item.releaseId === release?.id);
  if (existing) return { manifest: existing, changed: false };
  const manifest = buildApplicationManifest(applicationPackage, release, options);
  applicationPackage.manifests ||= [];
  applicationPackage.manifests.push(manifest);
  applicationPackage.updatedAt = manifest.createdAt;
  return { manifest, changed: true };
}

export function verifyApplicationManifest(applicationPackage, manifest, release) {
  if (!manifest || manifest.schemaVersion !== APPLICATION_PACKAGE_SCHEMA_VERSION) return '不支持的应用包 manifest 格式';
  if (manifest.applicationPackageId !== applicationPackage.id) return 'manifest 不属于当前应用包';
  if (manifest.checksum !== manifestChecksum(manifest)) return '应用包 manifest 校验和不匹配';
  if (!release || release.id !== manifest.releaseId) return 'manifest 引用的 Release 不存在';
  if (release.checksum !== manifest.releaseChecksum) return 'manifest 引用的 Release 校验和不匹配';
  if (release.decisionService !== applicationPackage.decisionService
      || release.target?.id !== applicationPackage.rulesetPath
      || release.target?.type !== applicationPackage.targetType
      || releaseEngine(release) !== applicationPackage.engine) {
    return 'manifest 引用的 Release 已偏离应用包固定边界';
  }
  return null;
}

export function presentApplicationPackages(applicationPackages, deployments) {
  return applicationPackages.map(applicationPackage => {
    const manifests = [...(applicationPackage.manifests || [])]
      .sort((left, right) => (Number(right.version) || 0) - (Number(left.version) || 0))
      .map(manifest => {
        const manifestDeployments = deployments
          .filter(item => item.releaseId === manifest.releaseId)
          .map(item => ({ id: item.id, environmentId: item.environmentId, status: item.status }));
        const deployment = [...manifestDeployments].reverse().find(item => item.environmentId === 'local')
          || manifestDeployments.at(-1) || null;
        return { ...manifest, deployment, deployments: manifestDeployments };
      });
    const activeManifestIds = {};
    for (const manifest of manifests) {
      for (const deployment of manifest.deployments) {
        if (deployment.status === 'active' && !activeManifestIds[deployment.environmentId]) {
          activeManifestIds[deployment.environmentId] = manifest.id;
        }
      }
    }
    return { ...applicationPackage, manifests, activeManifestId: activeManifestIds.local || null, activeManifestIds };
  });
}
