import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthConfig, useLogin, useSession } from '../api/auth'
import { useSessionStore } from '../store/session'

interface LoginLocationState {
  from?: string
}

export default function Login() {
  const [username, setUsername] = useState('wallace')
  const [password, setPassword] = useState('rules123')
  const [remember, setRemember] = useState(true)
  const [message, setMessage] = useState('')
  const user = useSessionStore((state) => state.user)
  const setSession = useSessionStore((state) => state.setSession)
  const login = useLogin()
  const authConfig = useAuthConfig()
  const session = useSession()
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (!user && authConfig.data?.mode === 'oidc' && session.data) {
      setSession(session.data.token, session.data.user)
      const state = location.state as LoginLocationState | null
      navigate(state?.from || '/library', { replace: true })
    }
  }, [authConfig.data?.mode, location.state, navigate, session.data, setSession, user])

  if (user) return <Navigate to="/library" replace />

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    login.mutate({ username, password }, {
      onSuccess: ({ token, user: authenticatedUser }) => {
        setSession(token, authenticatedUser)
        const state = location.state as LoginLocationState | null
        navigate(state?.from || '/library', { replace: true })
      },
    })
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-[#1d365d] to-brand-primary px-4 py-8">
      <section className="w-full max-w-[360px] rounded-[6px] bg-white p-9 shadow-[0_8px_32px_rgba(0,0,0,0.2)]">
        <div className="mb-6 flex items-center gap-[10px]">
          <span className="flex h-9 min-w-11 items-center justify-center rounded-[4px] bg-brand-primary px-1.5 text-xs font-bold text-white">DW</span>
          <div>
            <h1 className="text-[15px] font-semibold leading-5">Decision Workbench</h1>
            <p className="text-[11px] text-ink-3">规则团队管理控制台</p>
          </div>
        </div>

        <form onSubmit={submit}>
          {authConfig.data?.mode === 'oidc' ? (
            <>
              <p className="mb-5 text-xs leading-5 text-ink-2">当前启用 OIDC 单点登录。点击后将跳转到企业身份提供方，登录成功后由 BFF 会话接管浏览器访问。</p>
              {(login.error || message) && <p className="mb-3 text-[11px] text-[#c62828]" role="alert">{login.error?.message || message}</p>}
              <button className="primary-button w-full" type="submit" disabled={login.isPending || authConfig.isLoading}>
                {login.isPending ? '跳转中...' : '使用 OIDC 登录'}
              </button>
            </>
          ) : (
            <>
              <label className="mb-1 block text-[11px] text-ink-2" htmlFor="username">用户名</label>
              <input id="username" className="control-input mb-[14px]" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />

              <label className="mb-1 block text-[11px] text-ink-2" htmlFor="password">密码</label>
              <input id="password" type="password" className="control-input mb-[10px]" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />

              <div className="mb-5 flex items-center justify-between text-[11px]">
                <label className="flex items-center gap-1 text-ink-2">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住我
                </label>
                <button type="button" className="text-brand-primary hover:underline" onClick={() => setMessage('请联系系统管理员重置密码')}>忘记密码？</button>
              </div>

              {(login.error || message) && <p className="mb-3 text-[11px] text-[#c62828]" role="alert">{login.error?.message || message}</p>}
              <button className="primary-button w-full" type="submit" disabled={login.isPending}>
                {login.isPending ? '登录中...' : '登 录'}
              </button>
            </>
          )}
        </form>

        <p className="mt-4 text-center text-[10px] text-ink-3">© 2026 规则平台 · v2.1</p>
      </section>
    </main>
  )
}
