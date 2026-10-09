import test from 'node:test'
import assert from 'node:assert/strict'
import { threeWayMerge } from '../frontend/src/lib/threeWayMerge.ts'

test('three-way merge combines non-overlapping object changes', () => {
  const base = { name: '规则', description: '原说明', priority: 10 }
  const local = { ...base, description: '我的说明' }
  const remote = { ...base, priority: 20 }
  const result = threeWayMerge(base, local, remote)

  assert.deepEqual(result.value, { name: '规则', description: '我的说明', priority: 20 })
  assert.deepEqual(result.conflicts, [])
})

test('three-way merge exposes same-field conflicts and applies choices', () => {
  const base = { priority: 10 }
  const local = { priority: 16 }
  const remote = { priority: 26 }
  const result = threeWayMerge(base, local, remote)

  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, 'priority')
  assert.deepEqual(result.value, local)
  assert.deepEqual(threeWayMerge(base, local, remote, { priority: 'remote' }).value, remote)
})

test('three-way merge matches array entries by stable identity', () => {
  const base = {
    statements: [
      { name: 'highValue', label: '高值', epl: 'select * from Event' },
      { name: 'rapid', label: '快速', epl: 'select * from Event#time(1 min)' },
    ],
  }
  const local = {
    statements: [
      { name: 'highValue', label: '高额交易', epl: 'select * from Event' },
      { name: 'rapid', label: '快速', epl: 'select * from Event#time(1 min)' },
    ],
  }
  const remote = {
    statements: [
      { name: 'rapid', label: '快速', epl: 'select * from Event#time(30 sec)' },
      { name: 'highValue', label: '高值', epl: 'select * from Event' },
    ],
  }
  const result = threeWayMerge(base, local, remote)

  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.value.statements, [
    { name: 'rapid', label: '快速', epl: 'select * from Event#time(30 sec)' },
    { name: 'highValue', label: '高额交易', epl: 'select * from Event' },
  ])
})

test('three-way merge makes incompatible reorders explicit', () => {
  const base = { steps: [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }] }
  const local = { steps: [{ nodeId: 'b' }, { nodeId: 'a' }, { nodeId: 'c' }] }
  const remote = { steps: [{ nodeId: 'a' }, { nodeId: 'c' }, { nodeId: 'b' }] }
  const result = threeWayMerge(base, local, remote)

  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, 'steps（顺序）')
  assert.deepEqual(result.value, local)
  assert.deepEqual(threeWayMerge(base, local, remote, { 'steps.$order': 'remote' }).value, remote)
})

test('three-way merge reports edit-versus-delete conflicts', () => {
  const base = { steps: [{ nodeId: 'step-1', type: 'rule', id: 'rule-1' }] }
  const local = { steps: [{ nodeId: 'step-1', type: 'rule', id: 'rule-2' }] }
  const remote = { steps: [] }
  const result = threeWayMerge(base, local, remote)

  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, 'steps[nodeId=step-1]')
  assert.deepEqual(result.value, local)
  assert.deepEqual(threeWayMerge(base, local, remote, { 'steps[nodeId=step-1]': 'remote' }).value, remote)
})
