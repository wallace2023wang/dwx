export type ConflictChoice = 'local' | 'remote'

export interface MergeConflict {
  id: string
  path: string
  base: unknown
  local: unknown
  remote: unknown
}

export interface MergeResult<T> {
  value: T
  conflicts: MergeConflict[]
}

export interface DraftMergeConflict<T> {
  base: T
  local: T
  remote: T
  currentRevision: number
  result: MergeResult<T>
}

const missing = Symbol('missing')
type MergeValue = unknown | typeof missing

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function isRecord(value: MergeValue): value is Record<string, unknown> {
  return value !== missing && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function equal(left: MergeValue, right: MergeValue): boolean {
  if (left === missing || right === missing) return left === right
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]))
  }
  return false
}

function stableArrayKey(arrays: MergeValue[]): string | null {
  const candidates = ['nodeId', 'id', 'name', 'field']
  for (const candidate of candidates) {
    let found = false
    let valid = true
    for (const value of arrays) {
      if (value === missing) continue
      if (!Array.isArray(value)) { valid = false; break }
      const keys = value.map(item => isRecord(item) ? item[candidate] : undefined)
      if (keys.some(key => typeof key !== 'string' || !key)) { valid = false; break }
      if (new Set(keys).size !== keys.length) { valid = false; break }
      if (keys.length) found = true
    }
    if (valid && found) return candidate
  }
  return null
}

function pathFor(parent: string, segment: string | number) {
  if (typeof segment === 'number') return `${parent}[${segment}]`
  return parent ? `${parent}.${segment}` : segment
}

function keyedPath(parent: string, key: string, value: string) {
  return `${parent}[${key}=${value}]`
}

function conflictId(path: string) {
  return path || '$'
}

function stringArrayEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function threeWayMerge<T>(base: T, local: T, remote: T, choices: Record<string, ConflictChoice> = {}): MergeResult<T> {
  const conflicts: MergeConflict[] = []

  const merge = (baseValue: MergeValue, localValue: MergeValue, remoteValue: MergeValue, path: string): MergeValue => {
    if (equal(localValue, remoteValue)) return localValue === missing ? missing : clone(localValue)
    if (equal(localValue, baseValue)) return remoteValue === missing ? missing : clone(remoteValue)
    if (equal(remoteValue, baseValue)) return localValue === missing ? missing : clone(localValue)

    if (isRecord(baseValue) && isRecord(localValue) && isRecord(remoteValue)) {
      const result: Record<string, unknown> = {}
      const keys = new Set([...Object.keys(baseValue), ...Object.keys(localValue), ...Object.keys(remoteValue)])
      for (const key of keys) {
        const next = merge(
          Object.prototype.hasOwnProperty.call(baseValue, key) ? baseValue[key] : missing,
          Object.prototype.hasOwnProperty.call(localValue, key) ? localValue[key] : missing,
          Object.prototype.hasOwnProperty.call(remoteValue, key) ? remoteValue[key] : missing,
          pathFor(path, key),
        )
        if (next !== missing) result[key] = next
      }
      return result
    }

    if (Array.isArray(baseValue) && Array.isArray(localValue) && Array.isArray(remoteValue)) {
      const key = stableArrayKey([baseValue, localValue, remoteValue])
      if (key) {
        const maps = [baseValue, localValue, remoteValue].map(array => new Map(array.map(item => [(item as Record<string, unknown>)[key] as string, item])))
        const [baseOrder, localOrder, remoteOrder] = [baseValue, localValue, remoteValue].map(array => array.map(item => (item as Record<string, unknown>)[key] as string))
        let preferredOrder: string[]
        if (stringArrayEqual(localOrder, remoteOrder)) preferredOrder = localOrder
        else if (stringArrayEqual(localOrder, baseOrder)) preferredOrder = remoteOrder
        else if (stringArrayEqual(remoteOrder, baseOrder)) preferredOrder = localOrder
        else {
          const orderId = `${conflictId(path)}.$order`
          conflicts.push({ id: orderId, path: `${path || '数组'}（顺序）`, base: baseOrder, local: localOrder, remote: remoteOrder })
          preferredOrder = choices[orderId] === 'remote' ? remoteOrder : localOrder
        }
        const order = [...preferredOrder, ...localOrder, ...remoteOrder]
          .filter((value, index, values) => values.indexOf(value) === index)
        return order.flatMap(value => {
          const next = merge(maps[0].get(value) ?? missing, maps[1].get(value) ?? missing, maps[2].get(value) ?? missing, keyedPath(path, key, value))
          return next === missing ? [] : [next]
        })
      }
      const length = Math.max(baseValue.length, localValue.length, remoteValue.length)
      const result: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const next = merge(
          index < baseValue.length ? baseValue[index] : missing,
          index < localValue.length ? localValue[index] : missing,
          index < remoteValue.length ? remoteValue[index] : missing,
          pathFor(path, index),
        )
        if (next !== missing) result.push(next)
      }
      return result
    }

    const id = conflictId(path)
    conflicts.push({
      id,
      path: path || '整个草稿',
      base: baseValue === missing ? undefined : clone(baseValue),
      local: localValue === missing ? undefined : clone(localValue),
      remote: remoteValue === missing ? undefined : clone(remoteValue),
    })
    const selected = choices[id] === 'remote' ? remoteValue : localValue
    return selected === missing ? missing : clone(selected)
  }

  return { value: merge(base, local, remote, '') as T, conflicts }
}
