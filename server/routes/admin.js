import fs from 'node:fs/promises';
import { bodyOf, reply } from '../http-utils.js';

const ADMIN_ROLES = ['admin', 'author', 'cep-developer', 'reviewer', 'release-manager', 'viewer'];

function defaultAdminUsers() {
  return [
    { id: 'wallace', username: 'wallace', displayName: 'Wallace', email: 'wallace@company.com', role: 'admin', lastLogin: '2026-09-29 09:30', status: 'active' },
    { id: 'chen', username: 'chen', displayName: '陈分析师', email: 'chen@company.com', role: 'author', lastLogin: '2026-09-28 17:20', status: 'active' },
    { id: 'li', username: 'li', displayName: '李审核员', email: 'li@company.com', role: 'reviewer', lastLogin: '2026-09-28 14:05', status: 'active' },
    { id: 'ops', username: 'ops', displayName: '运维张', email: 'ops@company.com', role: 'release-manager', lastLogin: '2026-09-27 11:00', status: 'active' },
    { id: 'guest', username: 'guest', displayName: '访客账号', email: 'guest@company.com', role: 'viewer', lastLogin: '2026-09-15 08:42', status: 'disabled' },
  ];
}

function normalizeAdminUserPayload(payload, current = null) {
  const username = typeof payload?.username === 'string' ? payload.username.trim() : '';
  const displayName = typeof payload?.displayName === 'string' ? payload.displayName.trim() : username;
  const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
  const role = typeof payload?.role === 'string' ? payload.role : 'viewer';
  const status = payload?.status === 'disabled' ? 'disabled' : 'active';
  if (!/^[a-zA-Z0-9._-]{2,80}$/.test(username)) return { error: '用户名需为 2-80 位字母、数字、点、下划线或连字符' };
  if (!displayName || displayName.length > 80) return { error: '姓名需为 1-80 个字符' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '邮箱格式无效' };
  if (!ADMIN_ROLES.includes(role)) return { error: '角色无效' };
  return {
    id: current?.id || username,
    username,
    displayName,
    email,
    role,
    lastLogin: current?.lastLogin || '从未登录',
    status,
  };
}

export function createAdminHandler({ adminUsersFile, writeJsonFile, appendAuditEvent }) {
  async function readAdminUsers() {
    try { return JSON.parse(await fs.readFile(adminUsersFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const users = defaultAdminUsers();
      await writeJsonFile(adminUsersFile, users);
      return users;
    }
  }

  async function writeAdminUsers(users) {
    return writeJsonFile(adminUsersFile, users);
  }

  return async function handleAdmin(req, res, segments) {
    if (segments.length === 3 && segments[2] === 'roles' && req.method === 'GET') {
      return reply(res, 200, ADMIN_ROLES);
    }
    if (segments.length === 3 && segments[2] === 'users' && req.method === 'GET') {
      const users = await readAdminUsers();
      return reply(res, 200, users.map(user => ({ ...user, current: user.username === req.principal.name || user.id === req.principal.id })));
    }
    if (segments.length === 3 && segments[2] === 'users' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const users = await readAdminUsers();
      const normalized = normalizeAdminUserPayload(payload);
      if (normalized.error) return reply(res, 400, { error: normalized.error });
      if (users.some(user => user.id === normalized.id || user.username === normalized.username || user.email === normalized.email)) return reply(res, 409, { error: '用户名或邮箱已存在' });
      users.unshift(normalized);
      await writeAdminUsers(users);
      await appendAuditEvent('admin.user.created', 'user', normalized.id, `创建用户：${normalized.username}`, { role: normalized.role }, req);
      return reply(res, 201, { ...normalized, current: false });
    }
    if (segments.length === 4 && segments[2] === 'users' && req.method === 'PUT') {
      const id = decodeURIComponent(segments[3]);
      const payload = await bodyOf(req);
      const users = await readAdminUsers();
      const current = users.find(user => user.id === id);
      if (!current) return reply(res, 404, { error: '用户不存在' });
      const normalized = normalizeAdminUserPayload({ ...current, ...payload, username: current.username }, current);
      if (normalized.error) return reply(res, 400, { error: normalized.error });
      if (users.some(user => user.id !== id && user.email === normalized.email)) return reply(res, 409, { error: '邮箱已存在' });
      const next = users.map(user => user.id === id ? normalized : user);
      await writeAdminUsers(next);
      await appendAuditEvent('admin.user.updated', 'user', id, `更新用户：${normalized.username}`, { role: normalized.role, status: normalized.status }, req);
      return reply(res, 200, { ...normalized, current: normalized.username === req.principal.name || normalized.id === req.principal.id });
    }
    if (segments.length === 4 && segments[2] === 'users' && req.method === 'DELETE') {
      const id = decodeURIComponent(segments[3]);
      if (id === req.principal.id || id === req.principal.name) return reply(res, 400, { error: '不能删除当前登录用户' });
      const users = await readAdminUsers();
      const target = users.find(user => user.id === id);
      if (!target) return reply(res, 404, { error: '用户不存在' });
      await writeAdminUsers(users.filter(user => user.id !== id));
      await appendAuditEvent('admin.user.deleted', 'user', id, `删除用户：${target.username}`, {}, req);
      return reply(res, 204, '');
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
