import { bodyOf, reply } from '../http-utils.js';
import { canonicalRuleSetVariables, validateRuleSetVariables } from '../../shared/ruleset-variables.js';
import { normalizeApprovalPolicy, validateApprovalPolicy } from '../../shared/approval-policy.js';

function validateProjectVariables(variables, bom) {
  const normalized = Array.isArray(variables) ? canonicalRuleSetVariables(variables) : [];
  const error = validateRuleSetVariables(normalized);
  if (error) return { error: `Rule Project 变量无效：${error}` };
  const bomKeys = new Set((bom?.fields || []).map(field => field.key));
  const conflict = normalized.find(variable => bomKeys.has(variable.name));
  if (conflict) return { error: `Rule Project 变量“${conflict.name}”不能与 BOM 字段同名` };
  return { variables: normalized };
}

export function createProjectHandlers({
  createProjectRecord,
  actorOf,
  appendAuditEvent,
  readProjectRecords,
  canAccessProject,
  getPostgresStore,
  projectData,
  readPackageRecords,
  projectSummary,
  normalizeProjectEngine,
  writeProjectRecords,
  deleteProjectData,
  readAuditEvents,
  visibleProjectPackages,
  renderProjectReport,
}) {
  async function handleProjectCollection(req, res, url) {
    if (req.method === 'POST') {
      const result = await createProjectRecord(await bodyOf(req), actorOf(req));
      if (result.error) return reply(res, result.status, { error: result.error });
      await appendAuditEvent('project.created', 'project', result.item.id, `创建项目：${result.item.name}`, {}, req);
      return reply(res, 201, result.item);
    }
    if (req.method === 'GET') {
      const postgresStore = getPostgresStore();
      const includeArchived = url.searchParams.get('archived') === 'true';
      const records = (await readProjectRecords(includeArchived)).filter(project => canAccessProject(req.principal, project));
      const summaries = await Promise.all(records.map(async project => {
        if (postgresStore && project.assetCount != null) return { ...project, source: 'server' };
        const data = await projectData(project.id);
        const packages = await readPackageRecords(project.id, data);
        return projectSummary(project, data, packages);
      }));
      return reply(res, 200, summaries);
    }
    return reply(res, 405, { error: 'Method not allowed' });
  }

  async function handleProjectLifecycle(req, res, segments, projectId, project, projects) {
    const postgresStore = getPostgresStore();
    if (segments.length === 3 && req.method === 'PUT') {
      const payload = await bodyOf(req);
      const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
      const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
      if (!name || name.length > 80 || description.length > 500) return reply(res, 400, { error: '项目名称或描述无效' });
      if (payload?.engine != null && payload.engine !== normalizeProjectEngine(project.engine)) return reply(res, 400, { error: '项目引擎创建后不可修改' });
      const data = await projectData(projectId);
      const variableResult = validateProjectVariables(payload?.variables == null ? project.variables || [] : payload.variables, data.bom);
      if (variableResult.error) return reply(res, 400, { error: variableResult.error });
      const approvalPolicy = payload?.approvalPolicy == null ? normalizeApprovalPolicy(project.approvalPolicy) : payload.approvalPolicy;
      const approvalPolicyError = validateApprovalPolicy(approvalPolicy);
      if (approvalPolicyError) return reply(res, 400, { error: approvalPolicyError });
      const updates = {
        ...project,
        name,
        description,
        icon: ['loan', 'warehouse', 'shield'].includes(payload.icon) ? payload.icon : project.icon,
        defaultEnvironment: payload.defaultEnvironment || project.defaultEnvironment || 'local',
        variables: variableResult.variables,
        approvalPolicy: normalizeApprovalPolicy(approvalPolicy),
        updatedAt: new Date().toISOString(),
        updatedBy: actorOf(req),
      };
      const saved = postgresStore ? await postgresStore.updateProject(projectId, updates) : (await writeProjectRecords(projects.map(item => item.id === projectId ? updates : item)), updates);
      return reply(res, 200, { ...saved, source: 'server' });
    }
    if (segments.length === 4 && segments[3] === 'archive' && req.method === 'POST') {
      const saved = postgresStore ? await postgresStore.archiveProject(projectId) : (await writeProjectRecords(projects.map(item => item.id === projectId ? { ...item, archived: true, updatedAt: new Date().toISOString() } : item)), { ...project, archived: true });
      return reply(res, 200, { ...saved, source: 'server' });
    }
    if (segments.length === 3 && req.method === 'DELETE') {
      if (projectId === 'default') return reply(res, 400, { error: '默认项目不能删除' });
      const data = await projectData(projectId);
      const production = data.releases.some(release => (release.deployments || [])
        .some(deployment => deployment.environment === 'production' && deployment.status !== 'stopped'));
      if (production) return reply(res, 409, { error: '项目已发布到 production，只能归档' });
      if (postgresStore) {
        const result = await postgresStore.deleteProject(projectId);
        if (result.blocked) return reply(res, 409, { error: '项目已发布到 production，只能归档' });
      } else {
        await deleteProjectData(projects, projectId);
      }
      return reply(res, 204, '');
    }
    return null;
  }

  async function handleProjectAuditEvents(req, res, url, projectId) {
    const postgresStore = getPostgresStore();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const events = postgresStore
      ? await postgresStore.listAuditEvents(limit, projectId)
      : (await readAuditEvents(projectId)).slice(0, limit);
    return reply(res, 200, events);
  }

  function handleProjectReport(req, res, project, data, packageRecords) {
    const packages = visibleProjectPackages(req.principal, data.rules, data.tables, packageRecords, data.bom, data.changeSets);
    const html = renderProjectReport(project, data, packages, actorOf(req));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${project.name}-资产报告.html`)}` });
    return res.end(html);
  }

  function handleProjectSummary(res, project, data, packageRecords) {
    return reply(res, 200, projectSummary(project, data, packageRecords));
  }

  return {
    handleProjectCollection,
    handleProjectLifecycle,
    handleProjectAuditEvents,
    handleProjectReport,
    handleProjectSummary,
  };
}
