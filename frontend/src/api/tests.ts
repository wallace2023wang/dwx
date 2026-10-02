import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { BomModel, TestCase, TestSuite } from '../types'
import { http } from './client'

const loanCases: TestCase[] = [
  { id: 'loan-1', name: '未成年拒绝', inputs: { age: 17, creditScore: 720, yearlyIncome: 150000, delinquencies: 0 }, expected: '拒绝', actual: '拒绝', status: 'passed', durationMs: 18, firedRules: ['申请人年满 18 岁'] },
  { id: 'loan-2', name: '优质客户', inputs: { age: 35, creditScore: 750, yearlyIncome: 200000, delinquencies: 0 }, expected: '批准 LOW', actual: '批准 LOW', status: 'passed', durationMs: 22, firedRules: ['信用分达到准入线', '风险等级评估', '最终审批结果'] },
  { id: 'loan-3', name: '中等信用低收入', inputs: { age: 42, creditScore: 650, yearlyIncome: 80000, delinquencies: 0 }, expected: '批准 MEDIUM', actual: '批准 MEDIUM', status: 'passed', durationMs: 20, firedRules: ['信用分达到准入线', '风险等级评估'] },
  { id: 'loan-4', name: '信用分不足', inputs: { age: 28, creditScore: 580, yearlyIncome: 120000, delinquencies: 1 }, expected: '拒绝 HIGH', actual: '拒绝 HIGH', status: 'passed', durationMs: 17, firedRules: ['信用分达到准入线', '风险等级评估'] },
  { id: 'loan-5', name: '多次逾期', inputs: { age: 50, creditScore: 680, yearlyIncome: 180000, delinquencies: 3 }, expected: '拒绝 HIGH', actual: '批准 MEDIUM', status: 'failed', durationMs: 24, firedRules: ['信用分达到准入线', '风险等级评估'], diagnostic: '决策表第 5 行“逾期次数 >= 3”未命中，疑似被第 3 行优先级覆盖。' },
  { id: 'loan-6', name: '贷款额超收入 3 倍', inputs: { age: 33, creditScore: 720, yearlyIncome: 60000, delinquencies: 0 }, expected: '拒绝', actual: '拒绝', status: 'passed', durationMs: 19, firedRules: ['贷款金额不超过年收入 3 倍'] },
  { id: 'loan-7', name: '边界：刚好 18 岁', inputs: { age: 18, creditScore: 600, yearlyIncome: 100000, delinquencies: 0 }, expected: '批准 MEDIUM', actual: '批准 MEDIUM', status: 'passed', durationMs: 21, firedRules: ['信用分达到准入线', '风险等级评估'] },
  { id: 'loan-8', name: '边界：信用分 600', inputs: { age: 30, creditScore: 600, yearlyIncome: 100000, delinquencies: 0 }, expected: '批准 MEDIUM', actual: '批准 MEDIUM', status: 'passed', durationMs: 20, firedRules: ['信用分达到准入线', '风险等级评估'] },
  { id: 'loan-9', name: '高收入低信用', inputs: { age: 45, creditScore: 590, yearlyIncome: 500000, delinquencies: 0 }, expected: '拒绝 HIGH', actual: '拒绝 HIGH', status: 'passed', durationMs: 16, firedRules: ['信用分达到准入线'] },
  { id: 'loan-10', name: '一次历史逾期', inputs: { age: 39, creditScore: 710, yearlyIncome: 160000, delinquencies: 1 }, expected: '批准 LOW', actual: '批准 LOW', status: 'passed', durationMs: 23, firedRules: ['历史逾期次数上限', '最终审批结果'] },
  { id: 'loan-11', name: '边界：逾期 2 次', inputs: { age: 31, creditScore: 690, yearlyIncome: 140000, delinquencies: 2 }, expected: '批准 MEDIUM', actual: '批准 MEDIUM', status: 'passed', durationMs: 22, firedRules: ['历史逾期次数上限', '风险等级评估'] },
  { id: 'loan-12', name: '零逾期标准客户', inputs: { age: 26, creditScore: 705, yearlyIncome: 130000, delinquencies: 0 }, expected: '批准 LOW', actual: '批准 LOW', status: 'passed', durationMs: 19, firedRules: ['信用分达到准入线', '最终审批结果'] },
]

const suitesByProject: Record<string, TestSuite> = {
  miniloan: {
    id: 'loan-baseline', name: '基准场景', target: 'miniloan-decision', targetVersion: 'v2.1.0', required: true,
    lastRunAt: '2026-09-28 15:06',
    columns: [
      { key: 'age', label: '年龄' }, { key: 'creditScore', label: '信用分' },
      { key: 'yearlyIncome', label: '年收入' }, { key: 'delinquencies', label: '逾期' },
    ],
    cases: loanCases,
  },
  'grain-temperature': {
    id: 'grain-baseline', name: '粮温调控基准场景', target: 'grain-control', targetVersion: 'v1.4.0', required: true,
    lastRunAt: '2026-09-27 10:35',
    columns: [
      { key: 'averageTemperature', label: '整仓均温' }, { key: 'insideTemperature', label: '仓内温度' },
      { key: 'outsideTemperature', label: '仓外温度' }, { key: 'humidity', label: '湿度' },
    ],
    cases: [
      { id: 'grain-1', name: '高温启动通风', inputs: { averageTemperature: 27, insideTemperature: 28, outsideTemperature: 17, humidity: 63 }, expected: 'HIGH · 启动通风', actual: 'HIGH · 启动通风', status: 'passed', durationMs: 15, firedRules: ['整仓均温超限告警', '低温通风启动条件'] },
      { id: 'grain-2', name: '正常温度保持', inputs: { averageTemperature: 18, insideTemperature: 19, outsideTemperature: 20, humidity: 55 }, expected: 'NORMAL · 不通风', actual: 'NORMAL · 不通风', status: 'passed', durationMs: 12, firedRules: [] },
      { id: 'grain-3', name: '低温差禁止通风', inputs: { averageTemperature: 24, insideTemperature: 24, outsideTemperature: 22, humidity: 68 }, expected: 'MEDIUM · 不通风', actual: 'MEDIUM · 不通风', status: 'passed', durationMs: 14, firedRules: ['温差梯度风险评估'] },
      { id: 'grain-4', name: '高湿告警', inputs: { averageTemperature: 21, insideTemperature: 22, outsideTemperature: 14, humidity: 82 }, expected: 'HIGH · 启动通风', actual: 'HIGH · 启动通风', status: 'passed', durationMs: 17, firedRules: ['温差梯度风险评估', '低温通风启动条件'] },
      { id: 'grain-5', name: '边界：均温 25 度', inputs: { averageTemperature: 25, insideTemperature: 25, outsideTemperature: 16, humidity: 60 }, expected: 'NORMAL · 不通风', actual: 'NORMAL · 不通风', status: 'passed', durationMs: 13, firedRules: [] },
      { id: 'grain-6', name: '边界：温差 8 度', inputs: { averageTemperature: 23, insideTemperature: 24, outsideTemperature: 16, humidity: 58 }, expected: 'MEDIUM · 不通风', actual: 'MEDIUM · 不通风', status: 'passed', durationMs: 14, firedRules: ['温差梯度风险评估'] },
    ],
  },
}

export type TestValue = string | number | boolean

interface ServerAssertion {
  type: 'output' | 'fired' | 'path' | 'event'
  field?: string
  label?: string
  expected: unknown
  actual: unknown
  passed: boolean
}

interface ServerRunCase {
  id: string
  name: string
  passed: boolean
  durationMs: number
  outputs?: Record<string, TestValue>
  fired?: string[]
  assertions?: ServerAssertion[]
  error?: string
  parentCaseId?: string
  parameterId?: string | null
  parameterName?: string | null
  inputFacts?: Record<string, TestValue>
  omittedFields?: string[]
}

export interface ServerCoverage {
  kind: 'rule' | 'table-row' | 'flow-path'
  hit: number
  total: number
  percentage: number
  items: Array<{ id: string; label: string; hit: boolean }>
}

export interface ServerRun {
  id: string
  runAt: string
  targetVersion: number | null
  cases: ServerRunCase[]
  total?: number
  passedCount?: number
  failedCount?: number
  passed?: boolean
  coverage?: ServerCoverage
  kind?: 'comparison'
}

export interface ServerComparisonCase {
  id: string
  name: string
  parentCaseId: string
  parameterId: string | null
  parameterName: string | null
  classification: 'unchanged' | 'changed' | 'improved' | 'regressed'
  base: Pick<ServerRunCase, 'outputs' | 'fired' | 'passed' | 'error'> & { path?: string | null }
  candidate: Pick<ServerRunCase, 'outputs' | 'fired' | 'passed' | 'error'> & { path?: string | null }
}

export interface ServerComparisonReport {
  id: string
  kind: 'comparison'
  runAt: string
  baseVersion: number
  candidateVersion: number
  passed: boolean
  summary: { total: number; unchanged: number; changed: number; improved: number; regressed: number; reviewRequired: number }
  cases: ServerComparisonCase[]
  coverage: { base: ServerCoverage; candidate: ServerCoverage }
}

export interface ServerTestCase {
  id: string
  name: string
  enabled: boolean
  facts: Record<string, TestValue>
  events?: Array<Record<string, unknown>>
  waitMs?: number
  parameters?: Array<{ id: string; name: string; facts: Record<string, TestValue> }>
  expected: { outputs: Record<string, TestValue>; fired: string[]; path?: string | null }
  expectedEvents?: Array<{ statement: string; eventType: string; count?: number; fields?: Record<string, TestValue> }>
}

export interface ServerSuite {
  id: string
  name: string
  description: string
  target: { type: 'rule' | 'table' | 'flow' | 'event-stream'; id: string }
  targetName?: string
  required: boolean
  cases: ServerTestCase[]
  revision: number
  lastRun: ServerRun | null
  runs?: Array<ServerRun | ServerComparisonReport>
  targetVersions?: number[]
}

export type TestSuitePayload = Pick<ServerSuite, 'name' | 'description' | 'target' | 'required' | 'cases'>

export interface ManagedTestSuite extends TestSuite {
  definition?: ServerSuite
  coverage?: ServerCoverage
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.join('、') || '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (value == null) return '-'
  return String(value)
}

function resultText(values: Record<string, TestValue> | undefined, labels: Map<string, string>): string {
  if (!values || Object.keys(values).length === 0) return '-'
  return Object.entries(values).map(([key, value]) => `${labels.get(key) || key}=${valueText(value)}`).join(' · ')
}

function transformSuite(suite: ServerSuite, bom: BomModel): ManagedTestSuite {
  if (suite.target.type === 'event-stream') {
    const results = new Map((suite.lastRun?.cases || []).map(testCase => [testCase.id, testCase]))
    return {
      id: suite.id,
      name: suite.name,
      target: `事件流 · ${suite.targetName || suite.target.id}`,
      targetVersion: !suite.targetVersions?.length ? '待目标发布' : suite.lastRun?.targetVersion ? `v${suite.lastRun.targetVersion}` : '未运行',
      required: suite.required,
      lastRunAt: suite.lastRun ? new Date(suite.lastRun.runAt).toLocaleString('zh-CN', { hour12: false }) : '尚未运行',
      columns: [{ key: 'events', label: '事件输入' }],
      cases: suite.cases.map(testCase => {
        const result = results.get(testCase.id)
        const failed = result?.assertions?.filter(assertion => !assertion.passed) || []
        return {
          id: testCase.id,
          name: testCase.name,
          inputs: { events: testCase.events?.length || 0, ...(testCase.waitMs ? { waitMs: testCase.waitMs } : {}) },
          expected: (testCase.expectedEvents || []).map(event => `${event.statement}/${event.eventType} × ${event.count ?? 1}`).join(' · ') || '-',
          actual: result ? (result.assertions || []).map(assertion => `${assertion.actual}`).join(' · ') || (result.passed ? '通过' : '失败') : '-',
          status: !testCase.enabled || !result ? 'not-run' : result.passed ? 'passed' : 'failed',
          durationMs: result?.durationMs || 0,
          firedRules: [],
          ...(failed.length ? { diagnostic: failed.map(assertion => `事件断言：期望 ${valueText(assertion.expected)}，实际 ${valueText(assertion.actual)}`).join('；') } : {}),
        } satisfies TestCase
      }),
      definition: suite,
      coverage: suite.lastRun?.coverage,
    }
  }
  const fields = bom.factTypes.flatMap(fact => fact.fields)
  const labels = new Map(fields.map(field => [field.key, field.label]))
  const keys = [...new Set(suite.cases.flatMap(testCase => [
    ...Object.keys(testCase.facts),
    ...(testCase.parameters || []).flatMap(parameter => Object.keys(parameter.facts)),
  ]))]
  const results = new Map((suite.lastRun?.cases || []).map(testCase => [testCase.id, testCase]))
  const targetType = { rule: '规则', table: '决策表', flow: '规则流' }[suite.target.type]
  return {
    id: suite.id,
    name: suite.name,
    target: `${targetType} · ${suite.targetName || suite.target.id}`,
    targetVersion: suite.lastRun?.targetVersion ? `v${suite.lastRun.targetVersion}` : '未运行',
    required: suite.required,
    lastRunAt: suite.lastRun ? new Date(suite.lastRun.runAt).toLocaleString('zh-CN', { hour12: false }) : '尚未运行',
    columns: keys.map(key => ({ key, label: labels.get(key) || key })),
    cases: suite.cases.flatMap(testCase => {
      const variants = testCase.parameters?.length ? testCase.parameters.map(parameter => ({
        id: `${testCase.id}::${parameter.id}`,
        name: `${testCase.name} / ${parameter.name}`,
        inputs: { ...testCase.facts, ...parameter.facts },
      })) : [{ id: testCase.id, name: testCase.name, inputs: testCase.facts }]
      return variants.map(variant => {
      const result = results.get(variant.id)
      const failed = result?.assertions?.filter(assertion => !assertion.passed) || []
      const expectedParts = [resultText(testCase.expected.outputs, labels)]
      if (testCase.expected.fired.length) expectedParts.push(`命中 ${testCase.expected.fired.join('、')}`)
      if (testCase.expected.path !== undefined) expectedParts.push(`路径 ${testCase.expected.path || '默认'}`)
      const diagnostic = result?.error || failed.map(assertion => {
        const subject = assertion.type === 'output' ? assertion.label || assertion.field : assertion.type === 'fired' ? '命中规则' : '流程路径'
        return `${subject}：期望 ${valueText(assertion.expected)}，实际 ${valueText(assertion.actual)}`
      }).join('；')
      return {
        id: variant.id,
        name: variant.name,
        inputs: result?.inputFacts || variant.inputs,
        expected: expectedParts.filter(part => part !== '-').join(' · ') || '-',
        actual: result ? resultText(result.outputs, labels) : '-',
        status: !testCase.enabled || !result ? 'not-run' : result.passed ? 'passed' : 'failed',
        durationMs: result?.durationMs || 0,
        firedRules: result?.fired || [],
        omittedInputs: (result?.omittedFields || []).map(key => labels.get(key) || key),
        ...(diagnostic ? { diagnostic } : {}),
      } satisfies TestCase
      })
    }),
    definition: suite,
    coverage: suite.lastRun?.coverage,
  }
}

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('测试运行失败')
}

const demoProjectIds = new Set(['miniloan', 'grain-temperature'])

async function loadSuites(projectId: string): Promise<ManagedTestSuite[]> {
  if (!demoProjectIds.has(projectId)) {
    const [{ data: suites }, { data: bom }] = await Promise.all([
      http.get<ServerSuite[]>(`/projects/${encodeURIComponent(projectId)}/test-suites`),
      http.get<BomModel>(`/projects/${encodeURIComponent(projectId)}/bom`),
    ])
    return suites.map(suite => transformSuite(suite, bom))
  }
  await new Promise((resolve) => window.setTimeout(resolve, 140))
  const suite = suitesByProject[projectId]
  return suite ? [suite] : []
}

async function runSuite(projectId: string, suiteId: string): Promise<void> {
  if (!demoProjectIds.has(projectId)) {
    try {
      await http.post(`/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(suiteId)}/run`)
      return
    } catch (error) {
      throw requestError(error)
    }
  }
  await new Promise((resolve) => window.setTimeout(resolve, 850))
  const suite = suitesByProject[projectId]
  if (!suite) throw new Error('测试套件不存在')
  suitesByProject[projectId] = { ...suite, lastRunAt: '2026-09-29 13:20', cases: suite.cases.map((testCase) => ({ ...testCase })) }
}

async function createSuite(projectId: string, payload: TestSuitePayload): Promise<ServerSuite> {
  try { return (await http.post<ServerSuite>(`/projects/${encodeURIComponent(projectId)}/test-suites`, payload)).data }
  catch (error) { throw requestError(error) }
}

async function updateSuite(projectId: string, id: string, revision: number, payload: TestSuitePayload): Promise<ServerSuite> {
  try {
    return (await http.put<ServerSuite>(
      `/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(id)}`,
      { ...payload, revision },
    )).data
  } catch (error) { throw requestError(error) }
}

async function archiveSuite(projectId: string, id: string, revision: number): Promise<void> {
  try { await http.post(`/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(id)}/archive`, { revision }) }
  catch (error) { throw requestError(error) }
}

async function runAllSuites(projectId: string): Promise<void> {
  try { await http.post(`/projects/${encodeURIComponent(projectId)}/test-suites/run`) }
  catch (error) { throw requestError(error) }
}

async function compareSuite(projectId: string, suiteId: string, baseVersion: number, candidateVersion: number): Promise<ServerComparisonReport> {
  try {
    return (await http.post<{ report: ServerComparisonReport }>(
      `/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(suiteId)}/compare`,
      { baseVersion, candidateVersion },
    )).data.report
  } catch (error) { throw requestError(error) }
}

export function useTestSuites(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'tests'],
    queryFn: () => loadSuites(projectId ?? ''),
    enabled: Boolean(projectId),
  })
}

export function useTestSuite(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'tests'],
    queryFn: () => loadSuites(projectId ?? ''),
    enabled: Boolean(projectId),
    select: suites => suites[0] ?? null,
  })
}

export function useRunTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (suiteId: string) => runSuite(projectId ?? '', suiteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useCreateTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: TestSuitePayload) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能创建测试套件')
      return createSuite(projectId, payload)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useUpdateTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, revision, payload }: { id: string; revision: number; payload: TestSuitePayload }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能修改测试套件')
      return updateSuite(projectId, id, revision, payload)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useArchiveTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, revision }: { id: string; revision: number }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能归档测试套件')
      return archiveSuite(projectId, id, revision)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useRunAllTestSuites(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能运行全量回归')
      return runAllSuites(projectId)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useCompareTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ suiteId, baseVersion, candidateVersion }: { suiteId: string; baseVersion: number; candidateVersion: number }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能执行版本对比')
      return compareSuite(projectId, suiteId, baseVersion, candidateVersion)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}
