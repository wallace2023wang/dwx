import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollaborationService } from '../server/collaboration-service.js'

test('collaboration service tracks viewers, editors and leave', () => {
  let time = Date.parse('2026-10-09T01:00:00.000Z')
  const service = createCollaborationService({ now: () => time })
  const base = { projectId: 'default', assetType: 'rule', assetId: 'rule-1', currentRevision: 4 }
  service.heartbeat({ ...base, clientId: 'client-a', principal: { id: 'user-a', name: '用户 A' }, mode: 'editing', revision: 3 })
  time += 1_000
  const state = service.heartbeat({ ...base, clientId: 'client-b', principal: { id: 'user-b', name: '用户 B' }, mode: 'viewing', revision: 4 })

  assert.equal(state.currentRevision, 4)
  assert.deepEqual(state.members.map(member => ({ userId: member.userId, mode: member.mode, revision: member.revision })), [
    { userId: 'user-a', mode: 'editing', revision: 3 },
    { userId: 'user-b', mode: 'viewing', revision: 4 },
  ])
  const left = service.leave({ ...base, clientId: 'client-a' })
  assert.deepEqual(left.members.map(member => member.userId), ['user-b'])
})

test('collaboration service expires stale sessions', () => {
  let time = 1_000
  const service = createCollaborationService({ ttlMs: 12_000, now: () => time })
  const base = { projectId: 'default', assetType: 'flow', assetId: 'flow-1', currentRevision: 2 }
  service.heartbeat({ ...base, clientId: 'old', principal: { id: 'old-user', name: '旧用户' }, mode: 'editing', revision: 1 })
  time += 12_001
  const state = service.heartbeat({ ...base, clientId: 'current', principal: { id: 'current-user', name: '当前用户' }, mode: 'viewing', revision: 2 })

  assert.deepEqual(state.members.map(member => member.userId), ['current-user'])
})

test('collaboration service broadcasts presence, text and cursor updates', () => {
  let time = Date.parse('2026-10-09T02:00:00.000Z')
  const service = createCollaborationService({ now: () => time })
  const base = { projectId: 'default', assetType: 'event-stream', assetId: 'stream-1', currentRevision: 3 }
  const events = []
  const unsubscribe = service.subscribe(base, event => events.push(event))
  service.heartbeat({ ...base, clientId: 'client-a', principal: { id: 'user-a', name: '用户 A' }, mode: 'editing', revision: 3 })

  const text = service.updateText({ ...base, clientId: 'client-a', documentId: 'statement:0:epl', baseSequence: 0, value: 'select * from Event' })
  assert.equal(text.status, 200)
  assert.equal(text.document.sequence, 1)
  time += 20
  const cursor = service.updateCursor({
    ...base,
    clientId: 'client-a',
    documentId: 'statement:0:epl',
    selection: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 8 },
  })
  assert.equal(cursor.members[0].documentId, 'statement:0:epl')
  assert.equal(cursor.members[0].selection.startColumn, 8)
  assert.deepEqual(events.map(event => event.type), ['presence', 'text', 'cursor'])
  assert.equal(service.getDocument({ ...base, documentId: 'statement:0:epl' }).value, 'select * from Event')
  unsubscribe()
})

test('collaboration service rejects a stale text sequence without overwriting', () => {
  const service = createCollaborationService()
  const base = { projectId: 'default', assetType: 'event-stream', assetId: 'stream-1', currentRevision: 3 }
  for (const clientId of ['client-a', 'client-b']) {
    service.heartbeat({ ...base, clientId, principal: { id: clientId, name: clientId }, mode: 'editing', revision: 3 })
  }
  assert.equal(service.updateText({ ...base, clientId: 'client-a', documentId: 'statement:0:epl', baseSequence: 0, value: 'select A' }).status, 200)
  const conflict = service.updateText({ ...base, clientId: 'client-b', documentId: 'statement:0:epl', baseSequence: 0, value: 'select B' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.current.sequence, 1)
  assert.equal(conflict.current.value, 'select A')
  assert.equal(service.getDocument({ ...base, documentId: 'statement:0:epl' }).value, 'select A')
})

test('cursor updates do not advance the text sequence', () => {
  const service = createCollaborationService()
  const base = { projectId: 'default', assetType: 'event-stream', assetId: 'stream-1', currentRevision: 3, clientId: 'client-a' }
  service.heartbeat({ ...base, principal: { id: 'user-a', name: '用户 A' }, mode: 'editing', revision: 3 })
  service.updateText({ ...base, documentId: 'statement:0:epl', baseSequence: 0, value: 'select * from Event' })
  service.updateCursor({ ...base, documentId: 'statement:0:epl', selection: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 } })
  assert.equal(service.getDocument({ ...base, documentId: 'statement:0:epl' }).sequence, 1)
})
