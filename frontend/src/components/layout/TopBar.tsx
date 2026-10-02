import { Bell, LogOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useLogout } from '../../api/auth'
import { useSessionStore } from '../../store/session'

const navigation = [
  { label: '主页', to: '/home' },
  { label: '库', to: '/library' },
  { label: '浏览', to: '/explore' },
  { label: '管理', to: '/admin' },
]

export default function TopBar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const user = useSessionStore((state) => state.user)
  const logout = useSessionStore((state) => state.logout)
  const navigate = useNavigate()
  const location = useLocation()
  const navigationRef = useRef<HTMLElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const serverLogout = useLogout()

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      navigationRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname])

  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const signOut = () => {
    serverLogout.mutate()
    logout()
    setMenuOpen(false)
    navigate('/login', { replace: true })
  }

  return (
    <header className="application-topbar relative z-30 flex h-11 shrink-0 items-center bg-[#1d365d] px-5 text-white">
      <button
        className="flex h-full shrink-0 items-center gap-[10px] text-[13px] font-medium"
        onClick={() => navigate('/library')}
        aria-label="进入决策服务库"
      >
        <span className="flex h-[22px] min-w-[28px] items-center justify-center rounded-[2px] bg-brand-primary px-1 text-[10px] font-bold">DW</span>
        <span className="whitespace-nowrap">Decision Workbench</span>
      </button>

      <nav ref={navigationRef} className="ml-10 flex h-full min-w-0 items-stretch overflow-x-auto" aria-label="全局导航">
        {navigation.map((item) => {
          const active = item.to === '/library'
            ? location.pathname === '/library' || location.pathname.startsWith('/projects/')
            : location.pathname === item.to
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex min-w-14 items-center justify-center border-b-2 px-4 text-xs transition-colors ${
                active ? 'border-[#78a9ff] bg-white/[0.07] text-white' : 'border-transparent text-[#c7d2e1] hover:bg-white/[0.05] hover:text-white'
              }`}
            >
              {item.label}
            </NavLink>
          )
        })}
      </nav>

      <div className="ml-auto flex h-full items-center gap-1 pl-3">
        <button className="icon-button" title="通知" aria-label="通知">
          <Bell size={15} strokeWidth={1.8} />
        </button>
        <div className="relative" ref={userMenuRef}>
          <button
            className="flex size-8 items-center justify-center"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="用户菜单"
            aria-expanded={menuOpen}
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-brand-primary text-[10px] font-semibold">{user?.initials}</span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-50 w-[190px] rounded-[3px] border border-ink-border bg-white text-ink-1 shadow-menu">
              <div className="border-b border-[#e8e8e8] px-[14px] py-[10px]">
                <b className="block text-xs font-semibold">{user?.username}</b>
                <span className="mt-0.5 block text-[11px] text-ink-3">管理员 · {user?.email}</span>
              </div>
              <button className="flex w-full items-center gap-2 px-[14px] py-2 text-left text-xs text-[#c62828] hover:bg-[#ffebee]" onClick={signOut}>
                <LogOut size={14} />退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
