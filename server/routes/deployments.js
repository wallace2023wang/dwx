import { reply } from '../http-utils.js';

export function createDeploymentHandler({ readDeployments, readEnvironments }) {
  return async function handleDeployments(req, res, resource, projectId) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
    if (resource === 'deployments') return reply(res, 200, await readDeployments(projectId));
    if (resource === 'environments') return reply(res, 200, await readEnvironments(projectId));
    return reply(res, 404, { error: '未找到资源' });
  };
}
