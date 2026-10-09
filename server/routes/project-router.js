import { authorizeProject } from '../auth.js';
import { reply } from '../http-utils.js';
import { projectBomModel } from '../project-presenters.js';

export function createProjectRouter({
  handleProjectCollection,
  handleProjectLifecycle,
  handleProjectAuditEvents,
  handleProjectReport,
  handleProjectSummary,
  handleChangeSets,
  handleProjectPackages,
  handleProjectEventStreams,
  handleProjectFlows,
  handleTestSuites,
  handleReleases,
  handleProjectRules,
  handleProjectAssets,
  handleProjectImports,
  readProjectRecords,
  projectData,
  readPackageRecords,
  normalizeProjectEngine,
  updateProjectBom,
  bomFieldReferences,
  handleCollaboration,
}) {
  return async function handleProjects(req, res, segments, url) {
    if (segments.length === 2) return handleProjectCollection(req, res, url);
    const projectId = segments[2];
    const projects = await readProjectRecords(true);
    const project = projects.find(item => item.id === projectId);
    if (!project) return reply(res, 404, { error: '项目不存在' });
    authorizeProject(req.principal, project);
    const lifecycle = await handleProjectLifecycle(req, res, segments, projectId, project, projects);
    if (lifecycle !== null) return lifecycle;
    if (segments[3] === 'change-sets') {
      return handleChangeSets(req, res, ['api', 'change-sets', ...segments.slice(4)], projectId, true);
    }
    if (segments.length === 4 && segments[3] === 'audit-events' && req.method === 'GET') {
      return handleProjectAuditEvents(req, res, url, projectId);
    }
    const data = await projectData(projectId);
    data.project = project;
    const packageRecords = await readPackageRecords(projectId, data);
    data.packageRecords = packageRecords;
    const projectEngine = normalizeProjectEngine(project.engine);
    if ([4, 5].includes(segments.length) && segments[3] === 'collaboration') {
      return handleCollaboration(req, res, projectId, data, url, segments[4]);
    }
    if (projectEngine === 'cep' && ['rules', 'tables', 'flows', 'rulesets', 'imports', 'exports'].includes(segments[3])) {
      const message = 'CEP 项目不支持规则资产、决策表或规则集';
      return reply(res, req.method === 'GET' ? 404 : 403, { error: message });
    }
    if (projectEngine === 'rules' && segments[3] === 'event-streams') {
      return reply(res, req.method === 'GET' ? 404 : 403, { error: '规则项目不支持事件流资产' });
    }
    if (segments.length === 4 && segments[3] === 'report' && req.method === 'GET') {
      return handleProjectReport(req, res, project, data, packageRecords);
    }
    if (segments.length === 3 && req.method === 'GET') return handleProjectSummary(res, project, data, packageRecords);
    if (segments[3] === 'packages') {
      return handleProjectPackages(req, res, segments, projectId, data, packageRecords);
    }
    if (segments.length === 5 && segments[3] === 'assets' && segments[4] === 'batch') {
      return handleProjectAssets(req, res, projectId, data, packageRecords);
    }
    if (segments[3] === 'imports' || segments[3] === 'exports') {
      return handleProjectImports(req, res, segments, projectId, data, packageRecords);
    }
    if (segments.length === 4 && segments[3] === 'bom' && req.method === 'GET') return reply(res, 200, projectBomModel(data, data.bom));
    if (segments.length === 4 && segments[3] === 'bom' && req.method === 'PUT') return updateProjectBom(req, res, projectId, data.bom);
    if (segments.length === 5 && segments[3] === 'bom' && segments[4] === 'references' && req.method === 'GET') {
      const fieldKey = url.searchParams.get('field');
      if (!fieldKey) return reply(res, 400, { error: '缺少字段 key' });
      return reply(res, 200, await bomFieldReferences(fieldKey, projectId));
    }
    if (segments[3] === 'event-streams') {
      return handleProjectEventStreams(req, res, segments, projectId, data);
    }
    if (segments[3] === 'rulesets' || segments[3] === 'flows') {
      return handleProjectFlows(req, res, segments, projectId, data, packageRecords);
    }
    if (segments[3] === 'tests' || segments[3] === 'test-suites') {
      return handleTestSuites(req, res, ['api', 'test-suites', ...segments.slice(4)], projectId, data);
    }
    if (segments.length === 4 && segments[3] === 'releases') {
      return handleReleases(req, res, ['api', 'releases'], projectId, true);
    }
    if (segments.length === 6 && segments[3] === 'releases' && ['deploy', 'activate', 'rollback', 'undeploy', 'execute', 'events', 'webhook', 'alerts'].includes(segments[5])) {
      return handleReleases(req, res, ['api', 'releases', segments[4], segments[5]], projectId, true);
    }
    if (segments.length === 6 && segments[3] === 'services' && segments[5] === 'execute') {
      return handleReleases(req, res, ['api', 'services', segments[4], 'execute'], projectId, true);
    }
    if (segments[3] === 'rules') {
      return handleProjectRules(req, res, segments, url, projectId, data, packageRecords);
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
