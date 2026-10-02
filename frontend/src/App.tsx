import { lazy, Suspense, type PropsWithChildren, useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import TopBar from './components/layout/TopBar'
import { useAuthConfig, useSession } from './api/auth'
import { useProject } from './api/projects'
import { useSessionStore } from './store/session'
import Explore from './routes/Explore'
import Home from './routes/Home'
import Library from './routes/Library'
import Login from './routes/Login'
import ProjectShell from './routes/project/ProjectShell'

const Admin = lazy(() => import('./routes/Admin'))
const AssetsTab = lazy(() => import('./routes/project/AssetsTab'))
const BomTab = lazy(() => import('./routes/project/BomTab'))
const FlowTab = lazy(() => import('./routes/project/FlowTab'))
const EventStreamsTab = lazy(() => import('./routes/project/EventStreamsTab'))
const ReleasesTab = lazy(() => import('./routes/project/ReleasesTab'))
const ReviewsTab = lazy(() => import('./routes/project/ReviewsTab'))
const TestsTab = lazy(() => import('./routes/project/TestsTab'))
const Report = lazy(() => import('./routes/project/Report'))

function RequireSession({ children }: PropsWithChildren) {
  const user = useSessionStore((state) => state.user)
  const setSession = useSessionStore((state) => state.setSession)
  const location = useLocation()
  const authConfig = useAuthConfig()
  const session = useSession()

  useEffect(() => {
    if (!user && authConfig.data?.mode === 'oidc' && session.data) setSession(session.data.token, session.data.user)
  }, [authConfig.data?.mode, session.data, setSession, user])

  if (!user && (authConfig.isLoading || (authConfig.data?.mode === 'oidc' && session.isLoading))) return <div className="p-6 text-xs text-ink-3">正在恢复登录会话...</div>
  if (!user && (authConfig.data?.mode !== 'oidc' || !session.data)) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
  return children
}

function ProjectIndex() {
  const { projectId } = useParams()
  const { data: project } = useProject(projectId)
  return <Navigate to={project?.engine === 'cep' ? 'event-streams' : 'assets'} replace />
}

function ApplicationShell() {
  const location = useLocation()
  const reportMode = location.pathname.endsWith('/report')
  const shellClass = reportMode
    ? 'application-shell min-h-screen overflow-visible bg-ink-bg text-ink-1'
    : 'application-shell flex h-dvh min-h-[560px] flex-col overflow-hidden bg-ink-bg text-ink-1'
  const mainClass = reportMode ? 'min-h-0 overflow-visible' : 'min-h-0 flex-1 overflow-auto'
  return (
    <RequireSession>
      <div className={`${shellClass}${reportMode ? ' report-mode' : ''}`}>
        <TopBar />
        <main className={mainClass}>
          <Suspense fallback={<div className="p-6 text-xs text-ink-3">正在加载工作区...</div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </RequireSession>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ApplicationShell />}>
        <Route index element={<Navigate to="/library" replace />} />
        <Route path="home" element={<Home />} />
        <Route path="library" element={<Library />} />
        <Route path="explore" element={<Explore />} />
        <Route path="admin" element={<Admin />} />
        <Route path="projects/:projectId" element={<ProjectShell />}>
          <Route index element={<ProjectIndex />} />
          <Route path="assets" element={<AssetsTab />} />
          <Route path="flow" element={<FlowTab />} />
          <Route path="event-streams" element={<EventStreamsTab />} />
          <Route path="bom" element={<BomTab />} />
          <Route path="tests" element={<TestsTab />} />
          <Route path="reviews" element={<ReviewsTab />} />
          <Route path="releases" element={<ReleasesTab />} />
          <Route path="report" element={<Report />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/library" replace />} />
    </Routes>
  )
}
