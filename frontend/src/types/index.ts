export type UserRole = 'admin' | 'author' | 'reviewer' | 'deployer' | 'viewer'

export interface User {
  id: string
  username: string
  displayName: string
  email: string
  initials: string
  roles: UserRole[]
}

export interface Project {
  id: string
  name: string
  description: string
  packageCount: number
  assetCount: number
  version: string
  environmentCount: number
  updatedAt: string
  updatedBy: string
  branch: string
  icon: 'loan' | 'warehouse' | 'shield'
  engine: 'rules' | 'cep'
  source: 'demo' | 'server'
  defaultEnvironment?: string
  archived?: boolean
  createdAt?: string
}

export type AssetType = 'rule' | 'decision-table' | 'flow' | 'event-stream'
export type AssetStatus = 'draft' | 'in-review' | 'rejected' | 'published' | 'archived'

export interface Asset {
  id: string
  name: string
  type: AssetType
  modifiedBy: string
  status: AssetStatus
  version: string
  bomInvalid?: boolean
  bomIssue?: string
}

export interface RuleAttributes {
  priority: number
  hitPolicy: 'FIRST' | 'PRIORITY' | 'COLLECT'
  effectiveDate: string
  createdBy: string
  reviewedAt: string
}

export interface DecisionTableColumn {
  id: string
  label: string
  kind: 'condition' | 'action'
}

export interface DecisionTableDefinition {
  hitPolicy: 'FIRST' | 'PRIORITY' | 'COLLECT'
  columns: DecisionTableColumn[]
  rows: Array<Record<string, string>>
}

interface RuleConditionMetadata {
  factType?: string
  quantifier?: 'one' | 'exists' | 'all' | 'none'
  connector?: 'and' | 'or'
}

export interface RuleFieldConditionDraft extends RuleConditionMetadata {
  field: string
  operator: string
  value: string
  raw?: never
  pattern?: never
  condition?: never
}

export interface RuleRawConditionDraft extends RuleConditionMetadata {
  raw: string
  field?: string
  operator?: string
  value?: string
  pattern?: never
  condition?: never
}

export interface RulePatternConditionDraft extends RuleConditionMetadata {
  pattern: string
  condition: string
  field?: string
  operator?: string
  value?: string
  raw?: never
}

export type RuleConditionDraft = RuleFieldConditionDraft | RuleRawConditionDraft | RulePatternConditionDraft

export interface RuleActionDraft {
  field: string
  value: string
  factType?: string
  actionType?: 'set' | 'add'
}

export interface RuleDraft {
  name: string
  description: string
  category: string
  priority: number
  conditions: RuleConditionDraft[]
  actions: RuleActionDraft[]
}

export interface DecisionTableDraft {
  name: string
  description: string
  category: string
  priority: number
  hitPolicy: 'ALL' | 'COLLECT' | 'FIRST' | 'PRIORITY'
  conditions: Array<{ field: string; operator: string }>
  actions: Array<{ field: string }>
  rows: Array<{
    conditions: string[]
    actions: string[]
    enabled: boolean
    isDefault?: boolean
    priority?: number
  }>
}

export type AssetDraft = RuleDraft | DecisionTableDraft

export interface AssetDetail extends Asset {
  packageId: string
  packageName: string
  updatedAt: string
  revision?: number
  draft?: AssetDraft
  content?: string
  attributes: RuleAttributes
  decisionTable?: DecisionTableDefinition
  validationWarnings?: string[]
  changeSetId?: string
}

export type ChangeSetStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
export type ChangeKind = 'added' | 'removed' | 'changed'

export interface ChangeSetDiff {
  path: string
  kind: ChangeKind
  before?: unknown
  after?: unknown
}

export interface ChangeSetItem {
  assetType: 'rule' | 'table' | 'flow'
  assetId: string
  assetRevision: number
  baseVersion: number | null
  name: string
  before: unknown
  after: unknown
  changes: ChangeSetDiff[]
  summary: { added: number; removed: number; changed: number }
}

export interface ChangeSet {
  id: string
  revision: number
  status: ChangeSetStatus
  name: string
  description: string
  items: ChangeSetItem[]
  bomVersion?: number
  createdBy: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  decidedAt: string | null
  decisionComment: string
}

export interface DecisionTableAnalysis {
  error: string | null
  warnings: string[]
  drl: string | null
}

export interface PackageNode {
  id: string
  name: string
  label: string
  parentId?: string | null
  assets: Asset[]
}

export interface LoginCredentials {
  username: string
  password: string
}

export interface LoginResult {
  token: string
  user: User
}

export type BomDataType = 'Integer' | 'Decimal' | 'Boolean' | 'String' | 'Enum' | 'Date' | 'List<String>'

export interface BomField {
  key: string
  label: string
  type: BomDataType
  runtimeType?: 'Integer' | 'Double' | 'String' | 'Boolean'
  direction: 'input' | 'output'
  references: number
  factName?: string
  factLabel?: string
  enum?: string[] | null
  unit?: string | null
  min?: number | null
  max?: number | null
  control?: 'text' | 'number' | 'select' | 'boolean' | 'date'
  group?: string
  description?: string
  maxLength?: number | null
  regex?: string | null
  allowDuplicates?: boolean
  required?: boolean
}

export interface BomFactType {
  name: string
  label: string
  direction: 'input' | 'output' | 'mixed'
  fields: BomField[]
}

export interface BomEventFieldRef {
  field: string
  required?: boolean
}

export interface BomEventType {
  name: string
  label?: string
  version?: number
  keyField?: string | null
  timeField?: string | null
  sourceField?: string | null
  retention?: string | null
  allowedLateness?: string | null
  duplicateKey?: string[]
  fields: BomEventFieldRef[]
}

export interface VocabularyTerm {
  property: string
  label: string
  type: string
  references: number
}

export interface BomModel {
  version: number
  updatedAt?: string
  updatedBy: string
  eventTypes?: BomEventType[]
  factTypes: BomFactType[]
  vocabulary: VocabularyTerm[]
  relationships: string[]
  drl: string
}

export type RulesetHitPolicy = 'FIRST' | 'PRIORITY' | 'COLLECT'

export interface Ruleset {
  id: string
  name: string
  flowId: string
  flowName: string
  hitPolicy: RulesetHitPolicy
  maxFirings: number
  inputs: string[]
  outputs: string[]
  packages: string[]
  sequential: boolean
  revision?: number
  status?: AssetStatus
  version?: number
  updatedAt?: string
  branchCount?: number
  stepCount?: number
  steps?: Array<{ order: number; type: 'rule' | 'table' | 'rule-group'; id?: string; name: string; version: number; branchName?: string | null }>
  needsRepublish?: boolean
  outdatedDependencies?: Array<
    | { kind?: 'asset'; id: string; name: string; publishedVersion: number; latestVersion: number }
    | { kind: 'rule-group'; nodeId: string; packageName: string; reason: 'members-changed' | 'bom-changed' }
  >
}

export interface FlowMapping {
  source: string
  target: string
}

export interface FlowStepDraft {
  nodeId: string
  type: 'rule' | 'table' | 'rule-group'
  id?: string
  selector?: {
    packageName: string
    includeChildren: boolean
  }
  inputMappings?: FlowMapping[]
  outputMappings?: FlowMapping[]
}

export interface FlowEditorMetadata {
  positions: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

export interface FlowBranchDraft {
  id: string
  name: string
  default?: boolean
  condition?: {
    field: string
    operator: string
    value: string
  }
  steps: FlowStepDraft[]
}

export interface FlowDraft {
  name: string
  description: string
  category?: string
  priority?: number
  steps: FlowStepDraft[]
  branches?: FlowBranchDraft[]
  editor?: FlowEditorMetadata
}

export interface FlowAssetOption {
  id: string
  name: string
  type: 'rule' | 'table'
  category: string
  version: number
  outputFields?: string[]
}

export interface FlowPackageOption {
  name: string
  label: string
  parentId: string | null
  publishedRuleCount: number
  publishedTableCount: number
  excludedDraftCount: number
  outputFields: string[]
  members: Array<{ id: string; name: string; type: 'rule' | 'table'; version: number }>
}

export interface FlowDetail extends Ruleset {
  description: string
  category: string
  draft: FlowDraft
  availableAssets: FlowAssetOption[]
  availablePackages: FlowPackageOption[]
}

export type FlowNodeKind = 'start' | 'gateway' | 'ruleTask' | 'tableTask' | 'ruleGroup' | 'end'

export interface FlowNodeDefinition {
  id: string
  kind: FlowNodeKind
  position: { x: number; y: number }
  label: string
  detail?: string
  active?: boolean
  branchId?: string | null
  stepType?: FlowStepDraft['type']
}

export interface FlowConnection {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
  labelTone?: 'positive' | 'negative'
}

export interface FlowDefinition {
  id: string
  name: string
  nodes: FlowNodeDefinition[]
  connections: FlowConnection[]
}

export type TestCaseStatus = 'passed' | 'failed' | 'not-run'

export interface TestColumn {
  key: string
  label: string
}

export interface TestCase {
  id: string
  name: string
  inputs: Record<string, string | number | boolean>
  expected: string
  actual: string
  status: TestCaseStatus
  durationMs: number
  firedRules: string[]
  diagnostic?: string
  omittedInputs?: string[]
}

export interface TestSuite {
  id: string
  name: string
  target: string
  targetVersion: string
  required: boolean
  lastRunAt: string
  columns: TestColumn[]
  cases: TestCase[]
}

export type ReleaseEnvironment = 'dev' | 'test' | 'staging' | 'production' | 'local'
export type ReleaseState = 'running' | 'built' | 'rolled-back' | 'archived'
export type ReleaseType = 'patch' | 'minor' | 'major'

export interface ReleaseWebhookConfig {
  enabled: boolean
  callbackUrl: string
  secret?: string
  clearedAfterMs?: number
  maxRetries?: number
  minIntervalMs?: number
}

export interface ReleaseRecord {
  id: string
  name?: string
  decisionService?: string
  version: string
  state: ReleaseState
  environments: ReleaseEnvironment[]
  shadow: boolean
  assetSummary: string
  assetCount: number
  checksum: string
  author: string
  createdAt: string
  notes: string
  latestForDecisionService?: boolean
  engine?: 'rules' | 'cep'
  webhook?: ReleaseWebhookConfig
}

export interface ReleaseDraft {
  version: string
  type: ReleaseType
  notes: string
  assetIds: string[]
  targetEnvironments: ReleaseEnvironment[]
  knownIssueAccepted: boolean
  approver: string
}

export interface ServerPrincipal {
  id: string
  name: string
  email?: string | null
  roles: string[]
  permissions: string[]
  mode: 'local' | 'oidc'
}

export interface StorageStatus {
  mode: 'json' | 'postgresql'
  optimisticLocking: boolean
  authMode: 'local' | 'oidc'
}

export interface AdminUser {
  id: string
  username: string
  displayName: string
  email: string
  role: string
  lastLogin: string
  status: 'active' | 'disabled'
  current: boolean
}

export interface AdminRole {
  id: string
  label: string
  permissions: string[]
}

export interface AdminEnvironment {
  id: string
  purpose: string
  endpoint: string
  deploymentPolicy: string
  currentRelease: string
  shadowMode: string
  status: 'online' | 'offline' | 'unregistered'
  source: 'server' | 'preset'
}

export interface ServiceHealth {
  id: 'team-server' | 'build-service' | 'res'
  name: string
  status: 'online' | 'offline'
  detail: string
}

export interface AdminOverview {
  principal: ServerPrincipal | null
  storage: StorageStatus | null
  users: AdminUser[]
  roles: AdminRole[]
  environments: AdminEnvironment[]
  services: ServiceHealth[]
  fetchedAt: string
}
