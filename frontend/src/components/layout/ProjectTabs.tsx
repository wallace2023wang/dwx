import { NavLink, useParams } from 'react-router-dom'
import { useProject } from '../../api/projects'

const ruleTabs = [
  { label: '资产', path: 'assets' },
  { label: '规则流', path: 'flow' },
  { label: 'BOM / 词汇', path: 'bom' },
  { label: '测试套件', path: 'tests' },
  { label: '审核', path: 'reviews' },
  { label: '发布', path: 'releases' },
]

const cepTabs = [
  { label: '事件流', path: 'event-streams' },
  { label: 'BOM / 词汇', path: 'bom' },
  { label: '测试套件', path: 'tests' },
  { label: '发布', path: 'releases' },
]

const activeClasses = 'relative -mb-px rounded-t-[4px] border-ink-border border-b-white bg-white font-medium text-ink-1 shadow-[0_-1px_0_#fff_inset]'
const idleClasses = 'border-transparent text-ink-2 hover:bg-ink-bg hover:text-ink-1'

export default function ProjectTabs() {
  const { projectId } = useParams()
  const { data: project } = useProject(projectId)
  const tabs = project?.engine === 'cep' ? cepTabs : ruleTabs

  return (
    <nav className="mt-4 flex h-9 items-end gap-1 overflow-x-auto" aria-label="项目导航">
      {tabs.map((tab) => (
        <NavLink
          key={tab.path}
          to={`/projects/${projectId}/${tab.path}`}
          className={({ isActive }) => `flex h-9 shrink-0 items-center border px-4 text-xs transition-colors ${isActive ? activeClasses : idleClasses}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
