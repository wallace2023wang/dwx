import { useQuery } from '@tanstack/react-query'
import type { AssetStatus, BomDataType } from '../types'
import { loadBom } from './bom'
import { loadEventStreams } from './eventStreams'
import { loadRulesets } from './flows'
import { loadPackages, loadProjects } from './projects'

export type ExploreKind = 'rule' | 'decision-table' | 'decision-tree' | 'scorecard' | 'rule-template' | 'flow' | 'event-stream' | 'bom'

export interface ExploreItem {
  id: string
  kind: ExploreKind
  name: string
  detail: string
  searchText: string
  projectId: string
  projectName: string
  projectSource: 'server'
  packageName: string
  status: AssetStatus | 'model'
  version: string
  modifiedBy: string
  href: string
  bomInvalid?: boolean
  dataType?: BomDataType
  references?: number
}

export interface ExploreCatalog {
  items: ExploreItem[]
  warnings: Array<{ projectId: string; projectName: string; message: string }>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '项目资产读取失败'
}

async function loadExploreCatalog(): Promise<ExploreCatalog> {
  const projects = await loadProjects(false)
  const catalogs = await Promise.allSettled(projects.map(async project => {
    if (project.engine === 'cep') {
      const [streams, bom] = await Promise.all([
        loadEventStreams(project.id),
        loadBom(project.id),
      ])
      const eventStreams: ExploreItem[] = streams.map(stream => ({
        id: stream.id,
        kind: 'event-stream',
        name: stream.name,
        detail: `${stream.statementCount} 条检测语句`,
        searchText: [
          stream.name,
          stream.description,
          ...(stream.statementLabels ?? []),
          project.name,
          project.description,
        ].filter(Boolean).join(' '),
        projectId: project.id,
        projectName: project.name,
        projectSource: project.source,
        packageName: stream.package || '事件流',
        status: stream.status,
        version: String(stream.version),
        modifiedBy: stream.modifiedBy || project.updatedBy || 'Team Server',
        href: `/projects/${encodeURIComponent(project.id)}/event-streams?stream=${encodeURIComponent(stream.id)}`,
      }))
      const fields = bom.factTypes.flatMap(fact => fact.fields.map(field => bomFieldItem(project, bom, fact, field)))
      return [...eventStreams, ...fields]
    }
    const [packages, rulesets, bom] = await Promise.all([
      loadPackages(project.id),
      loadRulesets(project.id),
      loadBom(project.id),
    ])
    const assets: ExploreItem[] = packages.flatMap(packageNode => packageNode.assets.map(asset => ({
      id: asset.id,
      kind: asset.type,
      name: asset.name,
      detail: `${packageNode.name} · ${packageNode.label}`,
      searchText: [asset.name, packageNode.name, packageNode.label, project.name, project.description, asset.modifiedBy].join(' '),
      projectId: project.id,
      projectName: project.name,
      projectSource: project.source,
      packageName: packageNode.name,
      status: asset.status,
      version: asset.version,
      modifiedBy: asset.modifiedBy,
      href: `/projects/${encodeURIComponent(project.id)}/assets?asset=${encodeURIComponent(asset.id)}`,
      bomInvalid: asset.bomInvalid,
    })))
    const flows: ExploreItem[] = rulesets.map(ruleset => ({
      id: ruleset.id,
      kind: 'flow',
      name: ruleset.flowName,
      detail: ruleset.packages.length ? ruleset.packages.join(' · ') : '未绑定规则包',
      searchText: [ruleset.name, ruleset.flowName, ...ruleset.packages, ...ruleset.inputs, ...ruleset.outputs, project.name].join(' '),
      projectId: project.id,
      projectName: project.name,
      projectSource: project.source,
      packageName: ruleset.packages.join(', ') || '-',
      status: ruleset.status || 'published',
      version: String(ruleset.version || 1),
      modifiedBy: 'Team Server',
      href: `/projects/${encodeURIComponent(project.id)}/flow?flow=${encodeURIComponent(ruleset.id)}`,
    }))
    const fields: ExploreItem[] = bom.factTypes.flatMap(fact => fact.fields.map(field => bomFieldItem(project, bom, fact, field)))
    return [...assets, ...flows, ...fields]
  }))
  const items = catalogs.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const warnings = catalogs.flatMap((result, index) => result.status === 'rejected' ? [{
    projectId: projects[index].id,
    projectName: projects[index].name,
    message: errorMessage(result.reason),
  }] : [])
  return { items, warnings }
}

function bomFieldItem(
  project: Awaited<ReturnType<typeof loadProjects>>[number],
  bom: Awaited<ReturnType<typeof loadBom>>,
  fact: Awaited<ReturnType<typeof loadBom>>['factTypes'][number],
  field: Awaited<ReturnType<typeof loadBom>>['factTypes'][number]['fields'][number],
): ExploreItem {
  return {
    id: `${fact.name}.${field.key}`,
    kind: 'bom',
    name: field.label,
    detail: `${fact.label}.${field.label} · ${field.key}`,
    searchText: [field.key, field.label, field.description, field.group, fact.name, fact.label, field.type, project.name].filter(Boolean).join(' '),
    projectId: project.id,
    projectName: project.name,
    projectSource: project.source,
    packageName: fact.label,
    status: 'model',
    version: String(bom.version),
    modifiedBy: bom.updatedBy,
    href: `/projects/${encodeURIComponent(project.id)}/bom?field=${encodeURIComponent(field.key)}`,
    dataType: field.type,
    references: field.references,
  }
}

export function useExploreCatalog() {
  return useQuery({
    queryKey: ['explore', 'catalog'],
    queryFn: loadExploreCatalog,
    staleTime: 30_000,
  })
}
