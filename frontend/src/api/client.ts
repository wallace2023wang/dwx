import axios from 'axios'
import { useSessionStore } from '../store/session'

export const http = axios.create({
  baseURL: '/api',
  timeout: 10_000,
  headers: { 'content-type': 'application/json' },
  withCredentials: true,
})

http.interceptors.request.use((config) => {
  const { user } = useSessionStore.getState()
  if (user) config.headers.set('x-actor', user.username)
  return config
})
