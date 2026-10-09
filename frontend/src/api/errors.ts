import axios from 'axios'

export interface RequestError<TCurrent = unknown> extends Error {
  code?: string
  details?: unknown
  expectedRevision?: number
  currentRevision?: number
  current?: TCurrent
}

interface ErrorResponse<TCurrent> {
  error?: string
  code?: string
  details?: unknown
  expectedRevision?: number
  currentRevision?: number
  current?: TCurrent
}

export function requestError<TCurrent = unknown>(error: unknown, fallback = '操作失败'): RequestError<TCurrent> {
  if (axios.isAxiosError<ErrorResponse<TCurrent>>(error)) {
    const response = error.response?.data
    const next = new Error(response?.error || error.message || fallback) as RequestError<TCurrent>
    next.code = response?.code
    next.details = response?.details
    next.expectedRevision = response?.expectedRevision
    next.currentRevision = response?.currentRevision
    next.current = response?.current
    return next
  }
  return error instanceof Error ? error : new Error(fallback)
}

export function isRevisionConflict<TCurrent = unknown>(error: unknown): error is RequestError<TCurrent> {
  if (!(error instanceof Error)) return false
  const candidate = error as RequestError<TCurrent>
  return candidate.code === 'CONFLICT'
    && Number.isInteger(candidate.currentRevision)
    && candidate.current != null
}
