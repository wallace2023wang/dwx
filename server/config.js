import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createServerConfig(env = process.env) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const storage = env.RULES_DATA_FILE || path.join(root, 'data', 'rules.json');
  const dataDir = path.dirname(storage);
  const assetFiles = {
    tables: env.RULES_TABLES_FILE || path.join(dataDir, 'tables.json'),
    flows: env.RULES_FLOWS_FILE || path.join(dataDir, 'flows.json'),
    eventStreams: env.RULES_EVENT_STREAMS_FILE || path.join(dataDir, 'event-streams.json'),
    releases: env.RULES_RELEASES_FILE || path.join(dataDir, 'releases.json'),
    applicationPackages: env.RULES_APPLICATION_PACKAGES_FILE || path.join(dataDir, 'application-packages.json'),
    targets: env.RULES_TARGETS_FILE || path.join(dataDir, 'targets.json'),
    activationGenerations: env.RULES_ACTIVATION_GENERATIONS_FILE || path.join(dataDir, 'activation-generations.json'),
    deployments: env.RULES_DEPLOYMENTS_FILE || path.join(dataDir, 'deployments.json'),
    environments: env.RULES_ENVIRONMENTS_FILE || path.join(dataDir, 'environments.json'),
    testSuites: env.RULES_TEST_SUITES_FILE || path.join(dataDir, 'test-suites.json'),
    bom: env.RULES_BOM_FILE || path.join(dataDir, 'bom.json'),
    changeSets: env.RULES_CHANGE_SETS_FILE || path.join(dataDir, 'change-sets.json'),
    auditEvents: env.RULES_AUDIT_FILE || path.join(dataDir, 'audit-events.json'),
    adminUsers: env.RULES_ADMIN_USERS_FILE || path.join(dataDir, 'admin-users.json'),
    projects: env.RULES_PROJECTS_FILE || path.join(dataDir, 'projects.json'),
    packages: env.RULES_PACKAGES_FILE || path.join(dataDir, 'packages.json'),
  };
  const rulesResUrl = env.RULES_RES_URL || env.RES_URL || 'http://127.0.0.1:8790';
  const rulesResManagementUrl = env.RULES_RES_MANAGEMENT_URL || env.RES_MANAGEMENT_URL
    || env.RULES_RES_URL || env.RES_URL || 'http://127.0.0.1:8793';
  return {
    root,
    storage,
    port: Number(env.API_PORT || 8787),
    rulesBuildUrl: env.RULES_BUILD_URL || env.ENGINE_URL || 'http://127.0.0.1:8788',
    rulesResUrl,
    rulesResManagementUrl,
    rulesResManagementApiKey: env.RULES_RES_MANAGEMENT_API_KEY || env.RES_MANAGEMENT_API_KEY || '',
    rulesResExecutionApiKey: env.RULES_RES_EXECUTION_API_KEY || env.RES_EXECUTION_API_KEY || '',
    cepBuildUrl: env.CEP_BUILD_URL || 'http://127.0.0.1:8791',
    cepResUrl: env.CEP_RES_URL || 'http://127.0.0.1:8792',
    cepApiKey: env.CEP_API_KEY || '',
    dataDir,
    assetFiles,
  };
}
