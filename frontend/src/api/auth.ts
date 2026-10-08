import { useMutation, useQuery } from '@tanstack/react-query'
import type { LoginCredentials, LoginResult, ServerPrincipal, User, UserRole } from '../types'
import { http } from './client'

const roleMap: Record<string, UserRole> = {
  admin: 'admin',
  author: 'author',
  'cep-developer': 'cep-developer',
  reviewer: 'reviewer',
  'release-manager': 'deployer',
  viewer: 'viewer',
}

export interface AuthConfig {
  mode: 'local' | 'oidc'
  loginUrl: string | null
}

function userFromPrincipal(principal: ServerPrincipal): User {
  const initials = principal.name.slice(0, 2).toUpperCase()
  const roles = principal.roles.map((role) => roleMap[role]).filter((role): role is UserRole => Boolean(role))
  return {
    id: principal.id,
    username: principal.name,
    displayName: principal.name,
    email: principal.email || `${principal.name}@company.com`,
    initials,
    roles: roles.length > 0 ? roles : ['viewer'],
    permissions: principal.permissions,
  }
}

async function fetchAuthConfig(): Promise<AuthConfig> {
  const { data } = await http.get<AuthConfig>('/auth/config')
  return data
}

async function fetchSession(): Promise<LoginResult> {
  const { data: principal } = await http.get<ServerPrincipal>('/session')
  return { token: principal.mode === 'local' ? 'local-session' : 'bff-session', user: userFromPrincipal(principal) }
}

async function login(credentials: LoginCredentials): Promise<LoginResult> {
  const config = await fetchAuthConfig()
  if (config.mode === 'oidc') {
    const returnTo = window.location.pathname === '/login' ? '/library' : `${window.location.pathname}${window.location.search}`
    window.location.assign(`${config.loginUrl || '/api/auth/login'}?returnTo=${encodeURIComponent(returnTo)}`)
    return new Promise(() => undefined)
  }
  if (!credentials.username.trim() || !credentials.password) throw new Error('请输入用户名和密码')

  const { data: principal } = await http.get<ServerPrincipal>('/session', {
    headers: { 'x-actor': credentials.username.trim() },
  })

  return {
    token: 'local-session',
    user: userFromPrincipal(principal),
  }
}

async function logout(): Promise<void> {
  await http.post('/auth/logout').catch(() => undefined)
}

export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: fetchAuthConfig, staleTime: 60_000 })
}

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: fetchSession, retry: false, staleTime: 60_000 })
}

export function useLogin() {
  return useMutation({ mutationFn: login })
}

export function useLogout() {
  return useMutation({ mutationFn: logout })
}
