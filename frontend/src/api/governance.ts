import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { ChangeSet } from '../types'
import { http } from './client'

function errorOf(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('审核操作失败')
}

async function loadChangeSets(projectId: string): Promise<ChangeSet[]> {
  try {
    return (await http.get<ChangeSet[]>(`/projects/${encodeURIComponent(projectId)}/change-sets`)).data
  } catch (error) {
    throw errorOf(error)
  }
}

async function decideChangeSet(projectId: string, id: string, action: 'approve' | 'reject' | 'reopen', revision: number, comment: string): Promise<ChangeSet> {
  try {
    return (await http.post<ChangeSet>(
      `/projects/${encodeURIComponent(projectId)}/change-sets/${encodeURIComponent(id)}/${action}`,
      { revision, comment },
    )).data
  } catch (error) {
    throw errorOf(error)
  }
}

export function useChangeSets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'change-sets'],
    queryFn: () => loadChangeSets(projectId ?? ''),
    enabled: Boolean(projectId && !['miniloan', 'grain-temperature'].includes(projectId)),
  })
}

export function useChangeSetDecision(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action, revision, comment = '' }: { id: string; action: 'approve' | 'reject' | 'reopen'; revision: number; comment?: string }) => {
      if (!projectId) throw new Error('项目不存在')
      return decideChangeSet(projectId, id, action, revision, comment)
    },
    onSuccess: async updated => {
      queryClient.setQueryData<ChangeSet[]>(['projects', projectId, 'change-sets'], current =>
        current?.map(item => item.id === updated.id ? updated : item) ?? [updated])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
        queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'assets'] }),
        queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'flows'] }),
      ])
    },
  })
}
