import { useQuery } from '@tanstack/react-query'
import { http } from './client'

export interface ActivityRecord {
  id: string
  project: { id: string; name: string; engine: 'rules' | 'cep' }
  actor: string
  action: string
  resourceType: string
  resourceId: string
  summary: string
  details: Record<string, unknown>
  occurredAt: string
}

async function loadActivity(limit = 20): Promise<ActivityRecord[]> {
  return (await http.get<ActivityRecord[]>('/activity', { params: { limit } })).data
}

export function useActivity(limit = 20) {
  return useQuery({
    queryKey: ['activity', limit],
    queryFn: () => loadActivity(limit),
    staleTime: 30_000,
  })
}
