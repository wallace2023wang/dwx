const ASSET_ACTIVITY_TYPES = new Set(['rule', 'table', 'flow', 'event-stream']);

export function createActivityService({
  readProjectRecords,
  canAccessProject,
  canAccessAsset,
  readAllAuditEvents,
  normalizeProjectEngine,
  getPostgresStore,
}) {
  async function recentActivity(principal, limit) {
    const projects = (await readProjectRecords(false)).filter(project => canAccessProject(principal, project));
    const projectById = new Map(projects.map(project => [project.id, project]));
    const projectIds = [...projectById.keys()];
    const scanLimit = Math.min(5000, Math.max(limit * 20, 200));
    const postgresStore = getPostgresStore();
    const events = postgresStore
      ? await postgresStore.listAuditEventsForProjects(scanLimit, projectIds)
      : (await readAllAuditEvents()).filter(event => projectById.has(event.projectId || 'default'));
    return events
      .filter(event => !ASSET_ACTIVITY_TYPES.has(event.resourceType) || canAccessAsset(principal, event.resourceId))
      .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
      .slice(0, limit)
      .map(event => {
        const project = projectById.get(event.projectId || 'default');
        return {
          id: event.id,
          project: { id: project.id, name: project.name, engine: normalizeProjectEngine(project.engine) },
          actor: event.actor,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          summary: event.summary,
          details: event.details || {},
          occurredAt: event.occurredAt,
        };
      });
  }

  return { recentActivity };
}
