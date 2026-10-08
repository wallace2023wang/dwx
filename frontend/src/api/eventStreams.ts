import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { http } from './client'

export interface EplStatement {
  name: string
  epl: string
  enabled?: boolean
  output?: string[]
  label?: string
  description?: string
  group?: string
  mode?: 'guided' | 'advanced'
  template?: string
  params?: Record<string, unknown>
}
export interface EventStreamDraft { name: string; description?: string; category?: string; statements: EplStatement[] }
export interface EventStreamVersion {
  number: number
  assetRevision?: number
  createdAt?: string
  createdBy?: string
  statements?: EplStatement[]
  draft?: EventStreamDraft
  authoring?: Array<Pick<EplStatement, 'name' | 'label' | 'description' | 'group' | 'mode' | 'template' | 'params'>>
}
export interface EventStreamSummary {
  id: string
  name: string
  description?: string
  type: 'event-stream'
  status: 'draft' | 'published' | 'archived'
  package?: string
  version: number
  revision: number
  statementCount: number
  hasDraftChanges?: boolean
  statementLabels?: string[]
  updatedAt?: string
  modifiedBy?: string
}
export interface EventStreamRecord extends EventStreamSummary {
  draft: EventStreamDraft
  validationError?: string | null
  schemas?: Array<{ name: string; fields: Array<{ key: string; type: string }> }>
  versions?: EventStreamVersion[]
}

export async function loadEventStreams(projectId: string): Promise<EventStreamSummary[]> {
  return (await http.get<EventStreamSummary[]>(`/projects/${encodeURIComponent(projectId)}/event-streams`)).data
}

function requestError(error: unknown) {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response
    return new Error(response?.data?.error || '请求失败')
  }
  return error instanceof Error ? error : new Error('请求失败')
}

export function useEventStreams(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'event-streams'],
    enabled: Boolean(projectId),
    queryFn: () => loadEventStreams(projectId ?? ''),
  })
}

export function useEventStream(projectId: string | undefined, streamId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'event-streams', streamId],
    enabled: Boolean(projectId && streamId),
    queryFn: async () => (await http.get<EventStreamRecord>(`/projects/${encodeURIComponent(projectId ?? '')}/event-streams/${encodeURIComponent(streamId ?? '')}`)).data,
  })
}

export function useCreateEventStream(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Partial<EventStreamDraft>) => {
      if (!projectId) throw new Error('缺少项目')
      try { return (await http.post<EventStreamRecord>(`/projects/${encodeURIComponent(projectId)}/event-streams`, payload)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'event-streams'] }),
  })
}

export function useSaveEventStream(projectId: string | undefined, streamId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ revision, draft }: { revision: number; draft: EventStreamDraft }) => {
      if (!projectId || !streamId) throw new Error('缺少事件流')
      try { return (await http.put<EventStreamRecord>(`/projects/${encodeURIComponent(projectId)}/event-streams/${encodeURIComponent(streamId)}`, { revision, draft })).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: detail => {
      queryClient.setQueryData(['projects', projectId, 'event-streams', streamId], detail)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'event-streams'] })
    },
  })
}

export function useDeleteEventStream(projectId: string | undefined, streamId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (revision: number) => {
      if (!projectId || !streamId) throw new Error('缺少事件流')
      try {
        await http.delete(`/projects/${encodeURIComponent(projectId)}/event-streams/${encodeURIComponent(streamId)}`, { data: { revision } })
      } catch (error) {
        throw requestError(error)
      }
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['projects', projectId, 'event-streams', streamId] })
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'event-streams'] })
    },
  })
}

export function useCompileEventStream(projectId: string | undefined, streamId: string | undefined) {
  return useMutation({
    mutationFn: async ({ revision, draft }: { revision: number; draft: EventStreamDraft }) => {
      if (!projectId || !streamId) throw new Error('缺少事件流')
      try { return (await http.post(`/projects/${encodeURIComponent(projectId)}/event-streams/${encodeURIComponent(streamId)}/compile`, { revision, draft })).data }
      catch (error) { throw requestError(error) }
    },
  })
}

export function usePublishEventStream(projectId: string | undefined, streamId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (revision: number) => {
      if (!projectId || !streamId) throw new Error('缺少事件流')
      try { return (await http.post<EventStreamRecord>(`/projects/${encodeURIComponent(projectId)}/event-streams/${encodeURIComponent(streamId)}/publish`, { revision })).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: detail => {
      queryClient.setQueryData(['projects', projectId, 'event-streams', streamId], detail)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'event-streams'] })
    },
  })
}
