import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { http } from './client'

export type CollaborationAssetType = 'rule' | 'table' | 'flow' | 'event-stream'
export type CollaborationMode = 'viewing' | 'editing'

export interface CollaborationSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface CollaborationMember {
  clientId: string
  userId: string
  name: string
  mode: CollaborationMode
  revision: number | null
  documentId: string | null
  selection: CollaborationSelection | null
  joinedAt: string
  lastSeenAt: string
}

export interface CollaborationState {
  currentRevision: number
  members: CollaborationMember[]
}

interface CollaborationDocument {
  documentId: string
  value: string
  sequence: number
  assetRevision: number
  updatedBy: string | null
  updatedAt: string | null
}

type SyncState = 'idle' | 'syncing' | 'synced' | 'conflict'

function createClientId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function singleChange(base: string, next: string) {
  let start = 0
  while (start < base.length && start < next.length && base[start] === next[start]) start += 1
  let baseEnd = base.length
  let nextEnd = next.length
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) { baseEnd -= 1; nextEnd -= 1 }
  return { start, end: baseEnd, insert: next.slice(start, nextEnd) }
}

function mergeText(base: string, local: string, remote: string) {
  if (local === remote) return local
  if (local === base) return remote
  if (remote === base) return local
  const localChange = singleChange(base, local)
  const remoteChange = singleChange(base, remote)
  if (localChange.start === remoteChange.start && localChange.end === remoteChange.end && localChange.insert === remoteChange.insert) return local
  const overlap = localChange.start < remoteChange.end && remoteChange.start < localChange.end
  const sameInsertionPoint = localChange.start === localChange.end && remoteChange.start === remoteChange.end && localChange.start === remoteChange.start
  if (overlap || sameInsertionPoint) return null
  return [localChange, remoteChange]
    .sort((left, right) => right.start - left.start)
    .reduce((value, change) => `${value.slice(0, change.start)}${change.insert}${value.slice(change.end)}`, base)
}

export function useAssetCollaboration({ projectId, assetType, assetId, revision, mode, documentId, documentValue = '', onDocumentChange, enabled = true }: {
  projectId?: string
  assetType?: CollaborationAssetType
  assetId?: string
  revision?: number
  mode: CollaborationMode
  documentId?: string
  documentValue?: string
  onDocumentChange?: (value: string) => void
  enabled?: boolean
}) {
  const sessionId = useRef(createClientId())
  const [state, setState] = useState<CollaborationState | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const onDocumentChangeRef = useRef(onDocumentChange)
  const documentRef = useRef({ id: '', revision: 0, value: '', base: '', sequence: 0, pending: null as string | null, sending: false })
  const textTimer = useRef<number | null>(null)
  const cursorTimer = useRef<number | null>(null)
  const queuedSelection = useRef<CollaborationSelection | null>(null)

  onDocumentChangeRef.current = onDocumentChange
  if (documentRef.current.id !== (documentId || '') || documentRef.current.revision !== (revision || 0)) {
    documentRef.current = { id: documentId || '', revision: revision || 0, value: documentValue, base: documentValue, sequence: 0, pending: null, sending: false }
  } else {
    documentRef.current.value = documentValue
  }

  const collaborationUrl = projectId ? `/projects/${encodeURIComponent(projectId)}/collaboration` : ''

  const sendPendingText = useCallback(async () => {
    const current = documentRef.current
    if (!enabled || !projectId || !assetType || !assetId || !revision || !current.id || current.sending || current.pending == null) return
    const value = current.pending
    const base = current.base
    const baseSequence = current.sequence
    current.pending = null
    current.sending = true
    let retryDelay = 0
    setSyncState('syncing')
    try {
      const response = await http.post<CollaborationDocument>(collaborationUrl, {
        assetType, assetId, clientId: sessionId.current, revision, mode, action: 'text', documentId: current.id, baseSequence, value,
      })
      if (documentRef.current.id !== current.id) return
      current.sequence = response.data.sequence
      current.base = response.data.value
      setError(null)
      setSyncState(current.pending == null ? 'synced' : 'syncing')
    } catch (cause) {
      if (documentRef.current.id !== current.id) return
      const conflict = axios.isAxiosError(cause) && cause.response?.status === 409
        ? (cause.response.data as { current?: CollaborationDocument }).current
        : null
      if (conflict) {
        const local = current.pending ?? value
        const merged = mergeText(base, local, conflict.value)
        current.sequence = conflict.sequence
        current.base = conflict.value
        if (merged != null) {
          current.value = merged
          current.pending = merged
          onDocumentChangeRef.current?.(merged)
          setSyncState('syncing')
        } else {
          current.value = local
          current.pending = null
          setSyncState('conflict')
          setError(new Error('同一段 EPL 被其他协作者同时修改；已保留本地内容，请保存时选择合并结果。'))
        }
      } else {
        const retryable = !axios.isAxiosError(cause) || !cause.response || cause.response.status === 409 || cause.response.status >= 500
        if (retryable) { current.pending = value; retryDelay = 500 }
        setSyncState('idle')
        setError(cause instanceof Error ? cause : new Error('协作文档同步失败'))
      }
    } finally {
      current.sending = false
      if (current.pending != null && documentRef.current.id === current.id) window.setTimeout(() => void sendPendingText(), retryDelay)
    }
  }, [assetId, assetType, collaborationUrl, enabled, mode, projectId, revision])

  const publishText = useCallback((value: string) => {
    const current = documentRef.current
    current.value = value
    current.pending = value
    setSyncState('syncing')
    if (textTimer.current != null) window.clearTimeout(textTimer.current)
    textTimer.current = window.setTimeout(() => void sendPendingText(), 80)
  }, [sendPendingText])

  const publishSelection = useCallback((selection: CollaborationSelection) => {
    if (!documentId) return
    queuedSelection.current = selection
    if (cursorTimer.current != null) window.clearTimeout(cursorTimer.current)
    cursorTimer.current = window.setTimeout(() => {
      const next = queuedSelection.current
      if (!next || !projectId || !assetType || !assetId || !revision) return
      void http.post(collaborationUrl, {
        assetType, assetId, clientId: sessionId.current, revision, mode, action: 'cursor', documentId, selection: next,
      }).catch(() => undefined)
    }, 100)
  }, [assetId, assetType, collaborationUrl, documentId, mode, projectId, revision])

  useEffect(() => {
    if (!enabled || !projectId || !assetType || !assetId || !revision) { setState(null); setSyncState('idle'); return }
    let active = true
    const payload = { assetType, assetId, clientId: sessionId.current, revision, mode }
    const heartbeat = async () => {
      try {
        const { data } = await http.post<CollaborationState>(collaborationUrl, payload)
        if (active) { setState(data); setError(null) }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error('协作状态连接失败'))
      }
    }
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 4_000)
    const params = new URLSearchParams({ assetType, assetId, clientId: sessionId.current, revision: String(revision), mode })
    if (documentId) params.set('documentId', documentId)
    const events = new EventSource(`/api${collaborationUrl}/events?${params}`)
    const handleEvent = (message: MessageEvent<string>) => {
      if (!active) return
      const event = JSON.parse(message.data) as {
        type: string
        currentRevision?: number
        members?: CollaborationMember[]
        document?: CollaborationDocument | null
        documentId?: string
        value?: string
        sequence?: number
        updatedBy?: string
      }
      if (event.members) setState(previous => ({ currentRevision: event.currentRevision ?? previous?.currentRevision ?? revision, members: event.members || [] }))
      const incoming = event.type === 'snapshot' ? event.document : event.type === 'text' && event.documentId && event.value != null && event.sequence != null
        ? { documentId: event.documentId, value: event.value, sequence: event.sequence, updatedBy: event.updatedBy || null } as CollaborationDocument
        : null
      if (!incoming || incoming.documentId !== documentRef.current.id) return
      const current = documentRef.current
      if (incoming.updatedBy === sessionId.current) { current.sequence = Math.max(current.sequence, incoming.sequence); current.base = incoming.value; return }
      if (current.sending || current.pending != null) return
      current.sequence = incoming.sequence
      current.base = incoming.value
      current.value = incoming.value
      onDocumentChangeRef.current?.(incoming.value)
      setSyncState('synced')
    }
    for (const eventName of ['snapshot', 'presence', 'cursor', 'text']) events.addEventListener(eventName, handleEvent as EventListener)
    events.onopen = () => { if (active) setError(null) }
    events.onerror = () => { if (active) setError(new Error('实时协作连接中断，正在自动重连')) }
    return () => {
      active = false
      window.clearInterval(timer)
      if (textTimer.current != null) window.clearTimeout(textTimer.current)
      if (cursorTimer.current != null) window.clearTimeout(cursorTimer.current)
      events.close()
      void http.delete(collaborationUrl, { data: payload }).catch(() => undefined)
    }
  }, [assetId, assetType, collaborationUrl, documentId, enabled, mode, projectId, revision])

  return { state, error, clientId: sessionId.current, syncState, publishText, publishSelection }
}
