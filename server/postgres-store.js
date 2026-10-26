import pg from 'pg';
import { migrate } from './migrate.js';

const ASSET_TYPES = { rules: 'rule', tables: 'table', flows: 'flow', eventStreams: 'event-stream' };

export class StorageConflictError extends Error {
  constructor(resource, currentRevision) {
    super(`${resource}已被其他用户修改`);
    this.name = 'StorageConflictError';
    this.resource = resource;
    this.currentRevision = currentRevision;
  }
}

const iso = value => value instanceof Date ? value.toISOString() : value;
const fingerprint = value => JSON.stringify(value);

export class PostgresStore {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_SIZE || 10) });
    this.snapshots = new WeakMap();
  }

  async initialize() {
    await migrate(this.databaseUrl);
    await this.pool.query('SELECT 1');
  }

  remember(item, revision) {
    this.snapshots.set(item, { revision, fingerprint: fingerprint(item) });
    return item;
  }

  async listAssets(kind, projectId = 'default') {
    const type = ASSET_TYPES[kind];
    const assets = await this.pool.query('SELECT * FROM assets WHERE project_id = $1 AND asset_type = $2 ORDER BY updated_at DESC', [projectId, type]);
    if (!assets.rows.length) return [];
    const ids = assets.rows.map(row => row.id);
    const [versions, revisions] = await Promise.all([
      this.pool.query('SELECT asset_id, content FROM asset_versions WHERE asset_id = ANY($1::text[]) ORDER BY version', [ids]),
      this.pool.query('SELECT asset_id, revision, draft, reason, created_at FROM asset_revisions WHERE asset_id = ANY($1::text[]) ORDER BY revision', [ids]),
    ]);
    return assets.rows.map(row => this.remember({
      id: row.id,
      draft: row.draft,
      published: row.published,
      versions: versions.rows.filter(entry => entry.asset_id === row.id).map(entry => entry.content),
      revision: Number(row.revision),
      revisions: revisions.rows.filter(entry => entry.asset_id === row.id).map(entry => ({
        number: Number(entry.revision), draft: entry.draft, reason: entry.reason, createdAt: iso(entry.created_at),
      })),
      archived: row.archived,
      lifecycleStatus: row.lifecycle_status || (row.archived ? 'archived' : 'active'),
      deprecatedAt: iso(row.deprecated_at) || null,
      deprecatedBy: row.deprecated_by || null,
      deprecationReason: row.deprecation_reason || null,
      replacedByAssetId: row.replaced_by_asset_id || null,
      ownerId: row.owner_id || null,
      ownerName: row.owner_name || null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      effectiveFrom: iso(row.effective_from) || null,
      effectiveTo: iso(row.effective_to) || null,
      migration: row.migration || null,
      updatedAt: iso(row.updated_at),
    }, Number(row.revision)));
  }

  async saveAssets(kind, assets, transactionClient = null, projectId = 'default') {
    const type = ASSET_TYPES[kind];
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      for (const asset of assets) {
        const snapshot = this.snapshots.get(asset);
        if (snapshot?.fingerprint === fingerprint(asset)) continue;
        const existing = await client.query('SELECT revision FROM assets WHERE id = $1 FOR UPDATE', [asset.id]);
        const now = asset.updatedAt || new Date().toISOString();
        if (!existing.rowCount) {
          await client.query(`INSERT INTO assets
            (id, project_id, asset_type, revision, draft, published, archived, created_at, updated_at,
             lifecycle_status, deprecated_at, deprecated_by, deprecation_reason, replaced_by_asset_id,
             owner_id, owner_name, tags, effective_from, effective_to, migration)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`, [
            asset.id, projectId, type, asset.revision || 1, asset.draft, asset.published, asset.archived === true,
            asset.revisions?.[0]?.createdAt || now, now,
            asset.lifecycleStatus || (asset.archived ? 'archived' : 'active'), asset.deprecatedAt || null,
            asset.deprecatedBy || null, asset.deprecationReason || null, asset.replacedByAssetId || null,
            asset.ownerId || null, asset.ownerName || null, JSON.stringify(asset.tags || []), asset.effectiveFrom || null, asset.effectiveTo || null, asset.migration || null,
          ]);
        } else {
          const current = Number(existing.rows[0].revision);
          const expected = snapshot?.revision ?? current;
          if (current !== expected) throw new StorageConflictError(`${type}:${asset.id}`, current);
          await client.query(`UPDATE assets SET revision = $2, draft = $3, published = $4,
            archived = $5, updated_at = $6, lifecycle_status = $7, deprecated_at = $8,
            deprecated_by = $9, deprecation_reason = $10, replaced_by_asset_id = $11,
            owner_id = $12, owner_name = $13, tags = $14, effective_from = $15, effective_to = $16, migration = $17 WHERE id = $1`, [
            asset.id, asset.revision || current, asset.draft, asset.published, asset.archived === true, now,
            asset.lifecycleStatus || (asset.archived ? 'archived' : 'active'), asset.deprecatedAt || null,
            asset.deprecatedBy || null, asset.deprecationReason || null, asset.replacedByAssetId || null,
            asset.ownerId || null, asset.ownerName || null, JSON.stringify(asset.tags || []), asset.effectiveFrom || null, asset.effectiveTo || null, asset.migration || null,
          ]);
        }
        for (const revision of asset.revisions || []) {
          await client.query(`INSERT INTO asset_revisions (asset_id, revision, draft, reason, created_at)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [asset.id, revision.number, revision.draft, revision.reason, revision.createdAt]);
        }
        for (const version of asset.versions || []) {
          await client.query(`INSERT INTO asset_versions (asset_id, version, content, created_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [asset.id, version.number, version, version.createdAt]);
        }
      }
      if (ownsTransaction) await client.query('COMMIT');
      for (const asset of assets) this.remember(asset, asset.revision || 1);
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async getBom(projectId = 'default') {
    const result = await this.pool.query('SELECT definition FROM bom_versions WHERE project_id = $1 AND active ORDER BY version DESC LIMIT 1', [projectId]);
    return result.rows[0]?.definition || null;
  }

  async saveBom(bom, expectedVersion = null, transactionClient = null, projectId = 'default') {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      const active = await client.query('SELECT version FROM bom_versions WHERE project_id = $1 AND active FOR UPDATE', [projectId]);
      const currentVersion = active.rowCount ? Number(active.rows[0].version) : null;
      if (expectedVersion != null && currentVersion !== expectedVersion) {
        throw new StorageConflictError('bom:default', currentVersion);
      }
      await client.query('UPDATE bom_versions SET active = false WHERE project_id = $1 AND active', [projectId]);
      await client.query(`INSERT INTO bom_versions (project_id, version, definition, created_at, active)
        VALUES ($1, $2, $3, $4, true) ON CONFLICT (project_id, version) DO UPDATE SET definition = EXCLUDED.definition, active = true`,
      [projectId, bom.version, bom, bom.updatedAt || new Date().toISOString()]);
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listProjects(includeArchived = false) {
    const result = await this.pool.query(`SELECT p.*,
      GREATEST((SELECT count(*)::int FROM packages pkg WHERE pkg.project_id = p.id),
        (SELECT count(DISTINCT COALESCE(a.draft->>'category', '未分类'))::int FROM assets a WHERE a.project_id = p.id AND NOT a.archived)) AS package_count,
      (SELECT count(*)::int FROM assets a WHERE a.project_id = p.id AND NOT a.archived) AS asset_count,
      (SELECT count(DISTINCT d.environment_id)::int FROM deployments d
        WHERE d.project_id = p.id AND d.status NOT IN ('stopped', 'failed')) AS environment_count
      FROM projects p WHERE ($1 OR NOT p.archived) ORDER BY p.updated_at DESC`, [includeArchived]);
    return result.rows.map(row => ({
      id: row.id, name: row.name, description: row.description, icon: row.icon, engine: row.engine || 'rules',
      variables: Array.isArray(row.variables) ? row.variables : [],
      approvalPolicy: row.approval_policy || undefined,
      version: row.version, branch: row.branch, defaultEnvironment: row.default_environment,
      archived: row.archived, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      updatedBy: row.updated_by, packageCount: row.package_count, assetCount: row.asset_count,
      environmentCount: row.environment_count,
    }));
  }

  async getProject(id) {
    return (await this.listProjects(true)).find(project => project.id === id) || null;
  }

  async createProject(project, bom, packages = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO projects
        (id, workspace_id, name, description, icon, engine, version, branch, default_environment, variables, approval_policy, archived, created_at, updated_at, updated_by)
        VALUES ($1, 'default', $2, $3, $4, $5, $6, 'main', $7, $8, $9, false, $10, $10, $11)`, [
        project.id, project.name, project.description, project.icon, project.engine || 'rules', project.version, project.defaultEnvironment,
        JSON.stringify(project.variables || []), JSON.stringify(project.approvalPolicy || {}), project.createdAt, project.updatedBy,
      ]);
      await client.query(`INSERT INTO environments (project_id, id, name, kind, is_default)
        VALUES ($1, 'local', '本地环境', 'dev', true),
               ($1, 'test', '测试环境', 'test', false),
               ($1, 'production', '生产环境', 'prod', false)
        ON CONFLICT (project_id, id) DO NOTHING`, [project.id]);
      for (const pkg of packages) await client.query(`INSERT INTO packages (project_id, name, label, parent_id, created_at)
        VALUES ($1, $2, $3, $4, $5)`, [project.id, pkg.name, pkg.label, pkg.parentId || null, pkg.createdAt]);
      await this.saveBom(bom, null, client, project.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return this.getProject(project.id);
  }

  async updateProject(id, updates) {
    const result = await this.pool.query(`UPDATE projects SET name = $2, description = $3, icon = $4,
      default_environment = $5, variables = $6, approval_policy = $7, updated_at = $8, updated_by = $9 WHERE id = $1 RETURNING id`, [
      id, updates.name, updates.description, updates.icon, updates.defaultEnvironment,
      JSON.stringify(updates.variables || []), JSON.stringify(updates.approvalPolicy || {}), updates.updatedAt, updates.updatedBy,
    ]);
    return result.rowCount ? this.getProject(id) : null;
  }

  async archiveProject(id) {
    const result = await this.pool.query(`UPDATE projects SET archived = true, updated_at = now()
      WHERE id = $1 RETURNING id`, [id]);
    return result.rowCount ? this.getProject(id) : null;
  }

  async deleteProject(id) {
    const production = await this.pool.query(`SELECT 1 FROM deployments
      WHERE project_id = $1 AND environment_id = 'production'
        AND status NOT IN ('stopped', 'failed') LIMIT 1`, [id]);
    if (production.rowCount) return { blocked: true };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM change_sets WHERE project_id = $1', [id]);
      await client.query('DELETE FROM audit_events WHERE project_id = $1', [id]);
      await client.query('DELETE FROM test_suites WHERE project_id = $1', [id]);
      await client.query('DELETE FROM application_packages WHERE project_id = $1', [id]);
      await client.query('DELETE FROM deployments WHERE release_id IN (SELECT id FROM releases WHERE project_id = $1)', [id]);
      await client.query('DELETE FROM releases WHERE project_id = $1', [id]);
      await client.query('DELETE FROM bom_versions WHERE project_id = $1', [id]);
      await client.query('DELETE FROM assets WHERE project_id = $1', [id]);
      const result = await client.query('DELETE FROM projects WHERE id = $1', [id]);
      await client.query('COMMIT');
      return { deleted: result.rowCount > 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listPackages(projectId) {
    const result = await this.pool.query('SELECT * FROM packages WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return result.rows.map(row => ({ name: row.name, label: row.label, parentId: row.parent_id, createdAt: iso(row.created_at) }));
  }

  async savePackages(projectId, packages) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      await client.query('DELETE FROM packages WHERE project_id = $1', [projectId]);
      for (const pkg of packages) await client.query(`INSERT INTO packages (project_id, name, label, parent_id, created_at)
        VALUES ($1, $2, $3, $4, $5)`, [projectId, pkg.name, pkg.label, pkg.parentId || null, pkg.createdAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listTestSuites(projectId = 'default') {
    const suites = await this.pool.query('SELECT * FROM test_suites WHERE project_id = $1 ORDER BY updated_at DESC', [projectId]);
    if (!suites.rows.length) return [];
    const ids = suites.rows.map(row => row.id);
    const runs = await this.pool.query('SELECT suite_id, report FROM test_runs WHERE suite_id = ANY($1::text[]) ORDER BY run_at DESC', [ids]);
    return suites.rows.map(row => {
      const history = runs.rows.filter(run => run.suite_id === row.id).slice(0, 20).map(run => run.report);
      return this.remember({
        id: row.id, name: row.name, description: row.description,
        target: { type: row.target_type, id: row.target_asset_id }, required: row.required,
        cases: row.cases, revision: Number(row.revision), archived: row.archived,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
        lastRun: history.find(run => run.id === row.last_run_id) || null, runs: history,
      }, Number(row.revision));
    });
  }

  async saveTestSuites(suites, transactionClient = null, projectId = 'default') {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      for (const suite of suites) {
        const snapshot = this.snapshots.get(suite);
        if (snapshot?.fingerprint === fingerprint(suite)) continue;
        const existing = await client.query('SELECT revision FROM test_suites WHERE id = $1 AND project_id = $2 FOR UPDATE', [suite.id, projectId]);
        if (existing.rowCount) {
          const current = Number(existing.rows[0].revision);
          if (current !== (snapshot?.revision ?? current)) throw new StorageConflictError(`test-suite:${suite.id}`, current);
        } else {
          await client.query(`INSERT INTO test_suites
            (id, project_id, revision, name, description, target_type, target_asset_id, required, cases, archived, created_at, updated_at, last_run_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)`, [
            suite.id, projectId, suite.revision || 1, suite.name, suite.description || '', suite.target.type, suite.target.id,
            suite.required, JSON.stringify(suite.cases), suite.archived === true, suite.createdAt, suite.updatedAt,
          ]);
        }
        for (const run of suite.runs || []) {
          await client.query(`INSERT INTO test_runs (id, suite_id, target_version, passed, report, run_at)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [run.id, suite.id, run.targetVersion, run.passed, run, run.runAt]);
        }
        const values = [suite.id, suite.revision || 1, suite.name, suite.description || '', suite.target.type, suite.target.id,
          suite.required, JSON.stringify(suite.cases), suite.archived === true, suite.createdAt, suite.updatedAt, suite.lastRun?.id || null];
        await client.query(`UPDATE test_suites SET revision = $2, name = $3, description = $4,
          target_type = $5, target_asset_id = $6, required = $7, cases = $8, archived = $9,
          created_at = $10, updated_at = $11, last_run_id = $12 WHERE id = $1 AND project_id = $13`, [...values, projectId]);
      }
      if (ownsTransaction) await client.query('COMMIT');
      for (const suite of suites) this.remember(suite, suite.revision || 1);
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listReleases(projectId = 'default') {
    const releases = await this.pool.query('SELECT * FROM releases WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    const deployments = await this.listDeployments(projectId);
    return releases.rows.map(row => this.remember({
      ...row.content,
      deployments: deployments.filter(deployment => deployment.releaseId === row.id).map(deployment => ({
        id: deployment.id,
        environment: deployment.environmentId,
        deployedAt: deployment.createdAt,
        checksum: deployment.checksum,
        modelVersion: deployment.modelVersion,
        engine: deployment.engine,
        engineVersion: deployment.engineVersion,
        status: deployment.status === 'ready' ? 'deployed' : deployment.status,
        ...(deployment.activatedAt ? { activatedAt: deployment.activatedAt } : {}),
        ...(deployment.activatedBy ? { activatedBy: deployment.activatedBy } : {}),
        ...(deployment.stoppedAt ? { stoppedAt: deployment.stoppedAt } : {}),
        ...(deployment.stoppedBy ? { stoppedBy: deployment.stoppedBy } : {}),
      })),
    }, Number(row.row_revision)));
  }

  async saveReleases(releases, transactionClient = null, projectId = 'default') {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      for (const release of releases) {
        const snapshot = this.snapshots.get(release);
        if (snapshot?.fingerprint === fingerprint(release)) continue;
        const existing = await client.query('SELECT row_revision FROM releases WHERE id = $1 FOR UPDATE', [release.id]);
        let rowRevision = 1;
        if (existing.rowCount) {
          const current = Number(existing.rows[0].row_revision);
          if (current !== (snapshot?.revision ?? current)) throw new StorageConflictError(`release:${release.id}`, current);
          rowRevision = current + 1;
        }
        const content = structuredClone(release);
        delete content.deployments;
        await client.query(`INSERT INTO releases
          (id, project_id, decision_service, release_version, target_type, target_asset_id, checksum, content, row_revision, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, row_revision = EXCLUDED.row_revision`, [
          release.id, projectId, release.decisionService, release.version, release.target.type, release.target.id,
          release.checksum, content, rowRevision, release.createdAt,
        ]);
        this.snapshots.set(release, { revision: rowRevision, fingerprint: fingerprint(release) });
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listDeployments(projectId = 'default') {
    const result = await this.pool.query(`SELECT deployment.*, COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', event.id, 'deploymentId', event.deployment_id, 'type', event.event_type,
        'actor', event.actor, 'details', event.details, 'occurredAt', event.occurred_at
      ) ORDER BY event.occurred_at
    ) FILTER (WHERE event.id IS NOT NULL), '[]'::jsonb) AS events
      FROM deployments deployment
      LEFT JOIN deployment_events event ON event.deployment_id = deployment.id
      WHERE deployment.project_id = $1
      GROUP BY deployment.id ORDER BY deployment.deployed_at`, [projectId]);
    return result.rows.map(row => ({
      id: row.id,
      releaseId: row.release_id,
      decisionService: row.decision_service,
      environmentId: row.environment_id,
      engine: row.engine,
      checksum: row.checksum,
      status: row.status,
      modelVersion: row.model_version,
      engineVersion: row.engine_version,
      createdAt: iso(row.deployed_at),
      updatedAt: iso(row.updated_at),
      ...(row.activated_at ? { activatedAt: iso(row.activated_at) } : {}),
      ...(row.activated_by ? { activatedBy: row.activated_by } : {}),
      ...(row.stopped_at ? { stoppedAt: iso(row.stopped_at) } : {}),
      ...(row.stopped_by ? { stoppedBy: row.stopped_by } : {}),
      events: row.events.map(event => ({ ...event, occurredAt: iso(event.occurredAt) })),
    }));
  }

  async saveDeployments(deployments, projectId = 'default', transactionClient = null) {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const ids = deployments.map(item => item.id);
      await client.query('DELETE FROM deployments WHERE project_id = $1 AND NOT (id = ANY($2::text[]))', [projectId, ids]);
      await client.query("UPDATE deployments SET status = 'ready' WHERE project_id = $1 AND status = 'active'", [projectId]);
      for (const deployment of deployments) {
        const receipt = {
          id: deployment.id, environment: deployment.environmentId, deployedAt: deployment.createdAt,
          checksum: deployment.checksum, status: deployment.status === 'ready' ? 'deployed' : deployment.status,
        };
        await client.query(`INSERT INTO deployments
          (id, release_id, environment, deployed_at, receipt, project_id, decision_service, environment_id,
           engine, checksum, status, model_version, engine_version, updated_at, activated_at, activated_by, stopped_at, stopped_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (id) DO UPDATE SET
            receipt=EXCLUDED.receipt, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at,
            activated_at=EXCLUDED.activated_at, activated_by=EXCLUDED.activated_by,
            stopped_at=EXCLUDED.stopped_at, stopped_by=EXCLUDED.stopped_by`, [
          deployment.id, deployment.releaseId, deployment.environmentId, deployment.createdAt, receipt,
          projectId, deployment.decisionService, deployment.environmentId, deployment.engine,
          deployment.checksum, deployment.status, deployment.modelVersion, deployment.engineVersion,
          deployment.updatedAt, deployment.activatedAt || null, deployment.activatedBy || null,
          deployment.stoppedAt || null, deployment.stoppedBy || null,
        ]);
        for (const event of deployment.events || []) {
          await client.query(`INSERT INTO deployment_events (id, deployment_id, event_type, actor, details, occurred_at)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [
            event.id, deployment.id, event.type, event.actor, event.details || {}, event.occurredAt,
          ]);
        }
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listApplicationPackages(projectId = 'default') {
    const packages = await this.pool.query(
      'SELECT * FROM application_packages WHERE project_id = $1 ORDER BY updated_at DESC',
      [projectId],
    );
    if (!packages.rows.length) return [];
    const ids = packages.rows.map(row => row.id);
    const manifests = await this.pool.query(
      'SELECT * FROM application_package_manifests WHERE application_package_id = ANY($1::text[]) ORDER BY manifest_version',
      [ids],
    );
    return packages.rows.map(row => ({
      schemaVersion: 1,
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      decisionService: row.decision_service,
      rulesetPath: row.ruleset_path,
      targetType: row.target_type,
      engine: row.engine,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      createdBy: row.created_by,
      manifests: manifests.rows.filter(manifest => manifest.application_package_id === row.id).map(manifest => ({
        schemaVersion: 1,
        id: manifest.id,
        applicationPackageId: row.id,
        version: Number(manifest.manifest_version),
        decisionService: row.decision_service,
        rulesetPath: row.ruleset_path,
        targetType: row.target_type,
        engine: row.engine,
        releaseId: manifest.release_id,
        releaseVersion: Number(manifest.release_version),
        releaseDisplayVersion: manifest.release_display_version,
        releaseChecksum: manifest.release_checksum,
        checksum: manifest.checksum,
        createdAt: iso(manifest.created_at),
        createdBy: manifest.created_by,
      })),
    }));
  }

  async saveApplicationPackages(applicationPackages, projectId = 'default', transactionClient = null) {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const ids = applicationPackages.map(item => item.id);
      await client.query('DELETE FROM application_packages WHERE project_id = $1 AND NOT (id = ANY($2::text[]))', [projectId, ids]);
      for (const applicationPackage of applicationPackages) {
        const existing = await client.query('SELECT * FROM application_packages WHERE id = $1 FOR UPDATE', [applicationPackage.id]);
        if (existing.rowCount) {
          const row = existing.rows[0];
          if (row.project_id !== projectId
              || row.decision_service !== applicationPackage.decisionService
              || row.ruleset_path !== applicationPackage.rulesetPath
              || row.target_type !== applicationPackage.targetType
              || row.engine !== applicationPackage.engine) {
            throw new Error('应用包固定边界不可修改');
          }
          await client.query('UPDATE application_packages SET name = $2, updated_at = $3 WHERE id = $1', [
            applicationPackage.id, applicationPackage.name, applicationPackage.updatedAt,
          ]);
        } else {
          await client.query(`INSERT INTO application_packages
            (id, project_id, name, decision_service, ruleset_path, target_type, engine, created_at, updated_at, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
            applicationPackage.id, projectId, applicationPackage.name, applicationPackage.decisionService,
            applicationPackage.rulesetPath, applicationPackage.targetType, applicationPackage.engine,
            applicationPackage.createdAt, applicationPackage.updatedAt, applicationPackage.createdBy,
          ]);
        }
        for (const manifest of applicationPackage.manifests || []) {
          const stored = await client.query('SELECT checksum FROM application_package_manifests WHERE id = $1', [manifest.id]);
          if (stored.rowCount) {
            if (stored.rows[0].checksum !== manifest.checksum) throw new Error('应用包 manifest 不可修改');
            continue;
          }
          await client.query(`INSERT INTO application_package_manifests
            (id, application_package_id, manifest_version, release_id, release_version, release_display_version,
             release_checksum, checksum, created_at, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
            manifest.id, applicationPackage.id, manifest.version, manifest.releaseId, manifest.releaseVersion,
            manifest.releaseDisplayVersion, manifest.releaseChecksum, manifest.checksum,
            manifest.createdAt, manifest.createdBy,
          ]);
        }
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listTargets(projectId = 'default') {
    const result = await this.pool.query('SELECT * FROM deployment_targets WHERE project_id = $1 ORDER BY name, id', [projectId]);
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      environmentId: row.environment_id,
      engine: row.engine,
      endpoint: row.endpoint,
      enabled: row.enabled,
      status: row.status,
      nodeId: row.node_id || null,
      engineVersion: row.engine_version || null,
      lastSeenAt: iso(row.last_seen_at) || null,
      lastError: row.last_error || null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      createdBy: row.created_by,
    }));
  }

  async saveTargets(targets, projectId = 'default', transactionClient = null) {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const ids = targets.map(item => item.id);
      await client.query('DELETE FROM deployment_targets WHERE project_id = $1 AND NOT (id = ANY($2::text[]))', [projectId, ids]);
      for (const target of targets) {
        await client.query(`INSERT INTO deployment_targets
          (id, project_id, name, environment_id, engine, endpoint, enabled, status, node_id,
           engine_version, last_seen_at, last_error, created_at, updated_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, endpoint=EXCLUDED.endpoint,
            enabled=EXCLUDED.enabled, status=EXCLUDED.status, node_id=EXCLUDED.node_id,
            engine_version=EXCLUDED.engine_version, last_seen_at=EXCLUDED.last_seen_at,
            last_error=EXCLUDED.last_error, updated_at=EXCLUDED.updated_at`, [
          target.id, projectId, target.name, target.environmentId, target.engine, target.endpoint,
          target.enabled !== false, target.status || 'unknown', target.nodeId || null,
          target.engineVersion || null, target.lastSeenAt || null, target.lastError || null,
          target.createdAt, target.updatedAt, target.createdBy,
        ]);
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listActivationGenerations(projectId = 'default') {
    const result = await this.pool.query(
      'SELECT * FROM activation_generations WHERE project_id = $1 ORDER BY generation DESC, created_at DESC', [projectId],
    );
    return result.rows.map(row => ({
      id: row.id,
      applicationPackageId: row.application_package_id,
      manifestId: row.manifest_id,
      releaseId: row.release_id,
      decisionService: row.decision_service,
      environmentId: row.environment_id,
      generation: Number(row.generation),
      expectedGeneration: Number(row.expected_generation),
      status: row.status,
      targets: row.targets || [],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      createdBy: row.created_by,
      activatedAt: iso(row.activated_at) || null,
      failedAt: iso(row.failed_at) || null,
      error: row.error || null,
    }));
  }

  async saveActivationGenerations(generations, projectId = 'default', transactionClient = null) {
    const client = transactionClient || await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      for (const generation of generations) {
        if (generation.status === 'active') {
          await client.query(`UPDATE activation_generations SET status = 'draining', updated_at = $4
            WHERE project_id = $1 AND decision_service = $2 AND environment_id = $3 AND status = 'active' AND id <> $5`, [
            projectId, generation.decisionService, generation.environmentId, generation.updatedAt, generation.id,
          ]);
        }
        await client.query(`INSERT INTO activation_generations
          (id, project_id, application_package_id, manifest_id, release_id, decision_service,
           environment_id, generation, expected_generation, status, targets, created_at,
           updated_at, created_by, activated_at, failed_at, error)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, targets=EXCLUDED.targets,
            updated_at=EXCLUDED.updated_at, activated_at=EXCLUDED.activated_at,
            failed_at=EXCLUDED.failed_at, error=EXCLUDED.error`, [
          generation.id, projectId, generation.applicationPackageId, generation.manifestId,
          generation.releaseId, generation.decisionService, generation.environmentId,
          generation.generation, generation.expectedGeneration, generation.status,
          JSON.stringify(generation.targets || []), generation.createdAt, generation.updatedAt,
          generation.createdBy, generation.activatedAt || null, generation.failedAt || null,
          generation.error || null,
        ]);
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { if (ownsTransaction) client.release(); }
  }

  async listEnvironments(projectId = 'default') {
    const result = await this.pool.query('SELECT * FROM environments WHERE project_id = $1 ORDER BY is_default DESC, name', [projectId]);
    return result.rows.map(row => ({ id: row.id, name: row.name, kind: row.kind, isDefault: row.is_default }));
  }

  async saveEnvironments(environments, projectId = 'default') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const environment of environments) {
        await client.query(`INSERT INTO environments (project_id, id, name, kind, is_default)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, id) DO UPDATE SET
          name=EXCLUDED.name, kind=EXCLUDED.kind, is_default=EXCLUDED.is_default`, [
          projectId, environment.id, environment.name, environment.kind, Boolean(environment.isDefault),
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listChangeSets(projectId = 'default') {
    const result = await this.pool.query('SELECT * FROM change_sets WHERE project_id = $1 ORDER BY updated_at DESC', [projectId]);
    return result.rows.map(row => this.remember({
      ...row.definition,
      id: row.id,
      revision: Number(row.revision),
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }, Number(row.revision)));
  }

  async saveChangeSets(changeSets, projectId = 'default') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const changeSet of changeSets) {
        const snapshot = this.snapshots.get(changeSet);
        if (snapshot?.fingerprint === fingerprint(changeSet)) continue;
        const existing = await client.query('SELECT revision FROM change_sets WHERE id = $1 FOR UPDATE', [changeSet.id]);
        if (existing.rowCount) {
          const current = Number(existing.rows[0].revision);
          if (current !== (snapshot?.revision ?? current)) throw new StorageConflictError(`change-set:${changeSet.id}`, current);
        }
        const definition = structuredClone(changeSet);
        for (const key of ['id', 'revision', 'status', 'createdAt', 'updatedAt']) delete definition[key];
        await client.query(`INSERT INTO change_sets
          (id, project_id, revision, status, definition, created_at, updated_at)
          VALUES ($1, $7, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, status = EXCLUDED.status,
            definition = EXCLUDED.definition, updated_at = EXCLUDED.updated_at`, [
          changeSet.id, changeSet.revision || 1, changeSet.status, definition,
          changeSet.createdAt, changeSet.updatedAt, projectId,
        ]);
      }
      await client.query('COMMIT');
      for (const changeSet of changeSets) this.remember(changeSet, changeSet.revision || 1);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async appendAuditEvent(event) {
    await this.pool.query(`INSERT INTO audit_events
      (id, project_id, actor, action, resource_type, resource_id, summary, details, occurred_at)
      VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8)`, [
      event.id, event.actor, event.action, event.resourceType, event.resourceId,
      event.summary, event.details || {}, event.occurredAt, event.projectId || 'default',
    ]);
  }

  async listAuditEvents(limit = 100, projectId = 'default') {
    const result = await this.pool.query(`SELECT id, actor, action, resource_type, resource_id, summary, details, occurred_at
      FROM audit_events WHERE project_id = $1 ORDER BY sequence DESC LIMIT $2`, [projectId, limit]);
    return result.rows.map(row => ({
      id: row.id, actor: row.actor, action: row.action,
      resourceType: row.resource_type, resourceId: row.resource_id,
      summary: row.summary, details: row.details, occurredAt: iso(row.occurred_at),
    }));
  }

  async listAuditEventsForProjects(limit = 100, projectIds = []) {
    if (!projectIds.length) return [];
    const result = await this.pool.query(`SELECT id, project_id, actor, action, resource_type, resource_id, summary, details, occurred_at
      FROM audit_events WHERE project_id = ANY($1::text[]) ORDER BY sequence DESC LIMIT $2`, [projectIds, limit]);
    return result.rows.map(row => ({
      id: row.id, projectId: row.project_id, actor: row.actor, action: row.action,
      resourceType: row.resource_type, resourceId: row.resource_id,
      summary: row.summary, details: row.details, occurredAt: iso(row.occurred_at),
    }));
  }

  async close() { await this.pool.end(); }
}
