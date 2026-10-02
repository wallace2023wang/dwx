import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ROLE_PERMISSIONS = {
  viewer: ['view'],
  author: ['view', 'author'],
  reviewer: ['view', 'review'],
  'release-manager': ['view', 'release'],
  admin: ['*'],
};

const jwksCache = new Map();
const discoveryCache = new Map();
const loginStates = new Map();
const browserSessions = new Map();
const SESSION_COOKIE = 'rts_sid';
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authMode() {
  return (process.env.AUTH_MODE || 'local').trim().toLowerCase();
}

function oidcSettings() {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, '');
  const audience = process.env.OIDC_AUDIENCE;
  const configuredJwks = process.env.OIDC_JWKS_URI;
  const jwksUri = configuredJwks && configuredJwks !== 'undefined' ? configuredJwks : null;
  const clientId = process.env.OIDC_CLIENT_ID || audience;
  const clientSecret = process.env.OIDC_CLIENT_SECRET || null;
  const scope = process.env.OIDC_SCOPE || 'openid profile email';
  if (!issuer || !audience) throw new AuthError(500, 'OIDC 配置不完整');
  return { issuer, audience, jwksUri, clientId, clientSecret, scope };
}

async function discoverOidc(settings) {
  let discovered = discoveryCache.get(settings.issuer);
  if (!discovered) {
    discovered = fetch(`${settings.issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    }).then(async response => {
      if (!response.ok) throw new Error(`OIDC discovery 返回 ${response.status}`);
      const metadata = await response.json();
      if (metadata.issuer !== settings.issuer || typeof metadata.jwks_uri !== 'string') {
        throw new Error('OIDC discovery 元数据无效');
      }
      return metadata;
    });
    discoveryCache.set(settings.issuer, discovered);
  }
  try { return await discovered; }
  catch {
    discoveryCache.delete(settings.issuer);
    throw new AuthError(503, 'OIDC 身份服务暂时不可用');
  }
}

async function resolveJwks(settings) {
  let jwksUri = settings.jwksUri;
  if (!jwksUri) jwksUri = (await discoverOidc(settings)).jwks_uri;
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

function rolesFromClaims(claims) {
  const configuredClaim = process.env.OIDC_ROLES_CLAIM || 'roles';
  const configured = configuredClaim.split('.').reduce((value, key) => value?.[key], claims);
  const clientRoles = process.env.OIDC_CLIENT_ID
    ? claims.resource_access?.[process.env.OIDC_CLIENT_ID]?.roles
    : [];
  const values = [configured, claims.realm_access?.roles, clientRoles]
    .flatMap(value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[ ,]+/) : []);
  return [...new Set(values.filter(role => ROLE_PERMISSIONS[role]))];
}

function permissionsFor(roles) {
  return [...new Set(roles.flatMap(role => ROLE_PERMISSIONS[role] || []))];
}

function localPrincipal(req) {
  const actorHeader = req.headers['x-actor'];
  const actor = typeof actorHeader === 'string' && actorHeader.trim()
    ? actorHeader.trim().slice(0, 80)
    : 'local-user';
  return { id: actor, name: actor, roles: ['admin'], permissions: ['*'], mode: 'local' };
}

function cookieMap(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  res.setHeader('set-cookie', parts.join('; '));
}

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/library';
}

function base64url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

async function principalFromToken(token) {
  const settings = oidcSettings();
  const jwks = await resolveJwks(settings);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: settings.issuer,
      audience: settings.audience,
      algorithms: ['RS256', 'PS256', 'ES256'],
      clockTolerance: 5,
    }));
  } catch {
    throw new AuthError(401, '访问令牌无效或已过期');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError(401, '访问令牌缺少用户标识');
  const roles = rolesFromClaims(payload);
  return {
    id: String(payload.sub),
    name: String(payload.preferred_username || payload.email || payload.name || payload.sub),
    email: payload.email ? String(payload.email) : null,
    roles,
    permissions: permissionsFor(roles),
    mode: 'oidc',
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
  };
}

function cleanup() {
  const now = Date.now();
  for (const [state, entry] of loginStates) if (now - entry.createdAt > STATE_TTL_MS) loginStates.delete(state);
  for (const [sid, entry] of browserSessions) if (entry.expiresAt <= now) browserSessions.delete(sid);
}

export async function handleAuthRequest(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const action = segments[2];
  if (action === 'config' && req.method === 'GET') {
    return { status: 200, body: { mode: authMode(), loginUrl: authMode() === 'oidc' ? '/api/auth/login' : null } };
  }
  if (action === 'login' && req.method === 'GET') {
    if (authMode() !== 'oidc') return { status: 302, location: safeReturnTo(url.searchParams.get('returnTo')) };
    cleanup();
    const settings = oidcSettings();
    const metadata = await discoverOidc(settings);
    if (typeof metadata.authorization_endpoint !== 'string') throw new AuthError(503, 'OIDC 登录端点不可用');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const redirectUri = process.env.OIDC_REDIRECT_URI || `${originOf(req)}/api/auth/callback`;
    loginStates.set(state, { verifier, returnTo: safeReturnTo(url.searchParams.get('returnTo')), redirectUri, createdAt: Date.now() });
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', settings.clientId);
    authorization.searchParams.set('redirect_uri', redirectUri);
    authorization.searchParams.set('scope', settings.scope);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', base64url(verifier));
    authorization.searchParams.set('code_challenge_method', 'S256');
    return { status: 302, location: authorization.toString() };
  }
  if (action === 'callback' && req.method === 'GET') {
    cleanup();
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const pending = state && loginStates.get(state);
    if (!pending || !code) throw new AuthError(400, '登录回调无效或已过期');
    loginStates.delete(state);
    const settings = oidcSettings();
    const metadata = await discoverOidc(settings);
    if (typeof metadata.token_endpoint !== 'string') throw new AuthError(503, 'OIDC 令牌端点不可用');
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri,
      client_id: settings.clientId, code_verifier: pending.verifier,
    });
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (settings.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}`;
    }
    const response = await fetch(metadata.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
    const tokenSet = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokenSet.access_token !== 'string') throw new AuthError(401, 'OIDC 授权码交换失败');
    const principal = await principalFromToken(tokenSet.access_token);
    const sid = crypto.randomBytes(32).toString('base64url');
    const tokenExpiry = tokenSet.expires_in ? Date.now() + Number(tokenSet.expires_in) * 1000 : Date.now() + SESSION_TTL_MS;
    const expiresAt = Math.min(tokenExpiry, Date.now() + SESSION_TTL_MS);
    browserSessions.set(sid, { principal, accessToken: tokenSet.access_token, expiresAt });
    setCookie(res, SESSION_COOKIE, sid, { maxAge: Math.ceil((expiresAt - Date.now()) / 1000) });
    return { status: 302, location: pending.returnTo };
  }
  if (action === 'logout' && ['GET', 'POST'].includes(req.method)) {
    const sid = cookieMap(req)[SESSION_COOKIE];
    if (sid) browserSessions.delete(sid);
    setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
    return req.method === 'GET' ? { status: 302, location: '/login?logout=1' } : { status: 204, body: '' };
  }
  return null;
}

export async function authenticateRequest(req) {
  const mode = authMode();
  if (mode === 'local') return localPrincipal(req);
  if (mode !== 'oidc') throw new AuthError(500, `不支持的 AUTH_MODE：${mode}`);

  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return principalFromToken(match[1]);

  cleanup();
  const sid = cookieMap(req)[SESSION_COOKIE];
  const session = sid && browserSessions.get(sid);
  if (session && session.expiresAt > Date.now()) return { ...session.principal, mode: 'oidc' };
  if (sid) browserSessions.delete(sid);
  throw new AuthError(401, '需要 Bearer 访问令牌或浏览器登录会话');
}

export function requiredPermission(req, url) {
  if (url.pathname.startsWith('/api/auth/')) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[1] === 'admin') return 'manage';
  if (req.method === 'GET') return url.pathname === '/api/audit-events'
    || (segments[1] === 'projects' && segments[3] === 'audit-events') ? 'review' : 'view';
  if (segments[1] === 'change-sets' && ['approve', 'reject'].includes(segments[3])) return 'review';
  if (segments[1] === 'projects' && segments[3] === 'change-sets' && ['approve', 'reject'].includes(segments[5])) return 'review';
  if (segments[1] === 'projects' && ['rules', 'flows'].includes(segments[3]) && segments[5] === 'publish') return 'review';
  if (segments[1] === 'projects' && segments[3] === 'releases' && (segments.length === 4 || segments[5] === 'deploy')) return 'release';
  if (segments[1] === 'projects' && segments[3] === 'releases' && segments[5] === 'execute') return 'view';
  if (segments[1] === 'releases' && (segments.length === 2 || segments[3] === 'deploy')) return 'release';
  if (segments[1] === 'releases' && segments[3] === 'execute') return 'view';
  return 'author';
}

export function authorizeRequest(principal, req, url) {
  const required = requiredPermission(req, url);
  if (!required || principal.permissions.includes('*') || principal.permissions.includes(required)) return;
  throw new AuthError(403, `当前角色缺少 ${required} 权限`);
}

function authzPolicy() {
  if (!process.env.AUTHZ_POLICY) return null;
  try { return JSON.parse(process.env.AUTHZ_POLICY); }
  catch { throw new AuthError(500, 'AUTHZ_POLICY 配置无效'); }
}

function grantsFor(principal, policy) {
  const grants = [];
  const byUser = policy.users?.[principal.id] || policy.users?.[principal.name];
  if (byUser) grants.push(byUser);
  for (const role of principal.roles || []) if (policy.roles?.[role]) grants.push(policy.roles[role]);
  return grants;
}

function includesGrant(values, id) {
  return values?.includes('*') || (id != null && values?.includes(id));
}

export function canAccessProject(principal, project) {
  const policy = authzPolicy();
  if (!policy || principal.permissions?.includes('*')) return true;
  const grants = grantsFor(principal, policy);
  return grants.some(grant => includesGrant(grant.projects, project.id) || includesGrant(grant.workspaces, project.workspaceId || 'default'));
}

export function canAccessAsset(principal, assetId) {
  const policy = authzPolicy();
  if (!policy || principal.permissions?.includes('*')) return true;
  const grants = grantsFor(principal, policy);
  const assetScoped = grants.some(grant => Array.isArray(grant.assets));
  if (!assetScoped) return true;
  return grants.some(grant => includesGrant(grant.assets, assetId));
}

export function authorizeProject(principal, project) {
  if (canAccessProject(principal, project)) return;
  throw new AuthError(403, '当前用户无权访问该项目');
}

export function authorizeAsset(principal, assetId) {
  if (canAccessAsset(principal, assetId)) return;
  throw new AuthError(403, '当前用户无权访问该资产');
}

export function publicPrincipal(principal) {
  return {
    id: principal.id,
    name: principal.name,
    email: principal.email || null,
    roles: principal.roles,
    permissions: principal.permissions,
    mode: principal.mode,
    expiresAt: principal.expiresAt || null,
  };
}
