import assert from 'node:assert/strict'
import test from 'node:test'
import { startTestEnv } from './helpers.js'

async function nextSseEvent(reader, pending) {
  const decoder = new TextDecoder()
  while (true) {
    const separator = pending.value.indexOf('\n\n')
    if (separator >= 0) {
      const raw = pending.value.slice(0, separator)
      pending.value = pending.value.slice(separator + 2)
      const event = raw.match(/^event: (.+)$/m)?.[1]
      const data = raw.match(/^data: (.+)$/m)?.[1]
      if (event && data) return { event, data: JSON.parse(data) }
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error('SSE connection closed before the expected event')
    pending.value += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
  }
}

test('collaboration API streams EPL text and cursor updates with sequence conflicts', async () => {
  const env = await startTestEnv({ cepApiKey: 'cep-test-key' })
  const abort = new AbortController()
  try {
    const project = await env.request('/api/projects', 'POST', {
      name: '实时协作回归', description: 'SSE 协作', icon: 'warehouse', engine: 'cep', bomTemplate: 'blank',
    })
    await env.request(`/api/projects/${project.body.id}/bom`, 'PUT', {
      version: 1,
      fields: [
        { key: 'eventId', label: '事件 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '事件信封', control: 'text' },
        { key: 'sampledAt', label: '采样时间', type: 'String', semanticType: 'Date', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '事件信封', control: 'date' },
        { key: 'deviceId', label: '设备 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '事件信封', control: 'text' },
        { key: 'sensorId', label: '传感器 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '事件信封', control: 'text' },
        { key: 'averageTemperature', label: '平均温度', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '环境监测', unit: '°C', min: -50, max: 80, control: 'number' },
        { key: 'humidity', label: '湿度', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'DeviceReading', factTypeLabel: '设备采样事件', group: '环境监测', unit: '%', min: 0, max: 100, control: 'number' },
        { key: 'controlRequired', label: '是否干预', type: 'Boolean', semanticType: 'Boolean', kind: 'output', factType: 'ControlDecision', factTypeLabel: '调控决策', group: '结果输出', control: 'boolean' },
      ],
      eventTypes: [{
        name: 'DeviceReading', label: '设备采样事件', version: 1,
        keyField: 'deviceId', timeField: 'sampledAt', sourceField: 'sensorId', duplicateKey: ['eventId'],
        retention: '24h', allowedLateness: '5m',
        fields: [
          { field: 'eventId', required: true },
          { field: 'deviceId', required: true },
          { field: 'sensorId', required: true },
          { field: 'sampledAt', required: true },
          { field: 'averageTemperature', required: true },
          { field: 'humidity', required: false },
        ],
      }],
      domains: [],
      methods: [],
    })
    const stream = await env.request(`/api/projects/${project.body.id}/event-streams`, 'POST', {
      name: '协作事件流', statements: [{ name: 'RawEpl', mode: 'advanced', epl: 'select * from DeviceReading' }],
    })
    const path = `/api/projects/${project.body.id}/collaboration`
    const common = { assetType: 'event-stream', assetId: stream.body.id, revision: stream.body.revision, mode: 'editing' }
    assert.equal((await env.request(path, 'POST', { ...common, clientId: 'client-a' })).status, 200)
    assert.equal((await env.request(path, 'POST', { ...common, clientId: 'client-b' })).status, 200)

    const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(common).map(([key, value]) => [key, String(value)])), clientId: 'client-b', documentId: 'statement:0:epl' })
    const response = await fetch(`${env.base}${path}/events?${params}`, { signal: abort.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const pending = { value: '' }
    assert.equal((await nextSseEvent(reader, pending)).event, 'snapshot')

    const text = await env.request(path, 'POST', {
      ...common, clientId: 'client-a', action: 'text', documentId: 'statement:0:epl', baseSequence: 0, value: 'select temperature from DeviceReading',
    })
    assert.equal(text.status, 200)
    assert.equal(text.body.sequence, 1)
    const textEvent = await nextSseEvent(reader, pending)
    assert.equal(textEvent.event, 'text')
    assert.equal(textEvent.data.value, 'select temperature from DeviceReading')

    const cursor = await env.request(path, 'POST', {
      ...common, clientId: 'client-a', action: 'cursor', documentId: 'statement:0:epl',
      selection: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 19 },
    })
    assert.equal(cursor.status, 200)
    const cursorEvent = await nextSseEvent(reader, pending)
    assert.equal(cursorEvent.event, 'cursor')
    assert.equal(cursorEvent.data.selection.startColumn, 8)

    const stale = await env.request(path, 'POST', {
      ...common, clientId: 'client-b', action: 'text', documentId: 'statement:0:epl', baseSequence: 0, value: 'select * from OtherEvent',
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.current.sequence, 1)
    assert.equal(stale.body.current.value, 'select temperature from DeviceReading')

    const saved = await env.request(`/api/projects/${project.body.id}/event-streams/${stream.body.id}`, 'PUT', {
      revision: stream.body.revision, draft: stream.body.draft,
    })
    assert.equal(saved.status, 200)
    const staleRevision = await env.request(path, 'POST', {
      ...common, clientId: 'client-a', action: 'text', documentId: 'statement:0:epl', baseSequence: 1, value: 'select * from OldRevision',
    })
    assert.equal(staleRevision.status, 409)
    assert.equal(staleRevision.body.currentRevision, saved.body.revision)
    await reader.cancel()
  } finally {
    abort.abort()
    await env.stop()
  }
})
