import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { BomModel, TestCase, TestSuite } from '../types'
import { http } from './client'

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
  const targetType = { rule: '规则', table: '决策表', flow: '规则集' }[suite.target.type]
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

async function loadSuites(projectId: string): Promise<ManagedTestSuite[]> {
  const [{ data: suites }, { data: bom }] = await Promise.all([
    http.get<ServerSuite[]>(`/projects/${encodeURIComponent(projectId)}/test-suites`),
    http.get<BomModel>(`/projects/${encodeURIComponent(projectId)}/bom`),
  ])
  return suites.map(suite => transformSuite(suite, bom))
}

async function runSuite(projectId: string, suiteId: string): Promise<void> {
  try {
    await http.post(`/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(suiteId)}/run`)
  } catch (error) {
    throw requestError(error)
  }
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
      if (!projectId) throw new Error('项目不存在')
      return createSuite(projectId, payload)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useUpdateTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, revision, payload }: { id: string; revision: number; payload: TestSuitePayload }) => {
      if (!projectId) throw new Error('项目不存在')
      return updateSuite(projectId, id, revision, payload)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useArchiveTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, revision }: { id: string; revision: number }) => {
      if (!projectId) throw new Error('项目不存在')
      return archiveSuite(projectId, id, revision)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useRunAllTestSuites(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error('项目不存在')
      return runAllSuites(projectId)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}

export function useCompareTestSuite(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ suiteId, baseVersion, candidateVersion }: { suiteId: string; baseVersion: number; candidateVersion: number }) => {
      if (!projectId) throw new Error('项目不存在')
      return compareSuite(projectId, suiteId, baseVersion, candidateVersion)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tests'] }),
  })
}
