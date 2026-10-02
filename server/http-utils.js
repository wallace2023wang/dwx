export function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

export async function bodyOf(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1048576) throw new Error('请求内容过大');
  }
  return JSON.parse(data || '{}');
}

export function expectedRevision(req, body) {
  const header = req.headers['if-match'];
  const raw = body?.revision ?? (typeof header === 'string' ? header.replace(/^W\//, '').replaceAll('"', '') : null);
  if (raw == null || raw === '') return null;
  const revision = Number(raw);
  return Number.isInteger(revision) && revision >= 1 ? revision : NaN;
}

export function revisionConflict(item, expected) {
  const current = item.revision || 1;
  return expected != null && expected !== current
    ? { status: 409, error: `资产修订冲突：客户端 r${expected}，服务器最新 r${current}，请刷新后重试`, expectedRevision: expected, currentRevision: current, current: item }
    : null;
}

export function operationError(result) {
  const body = { error: result.error };
  if (result.expectedRevision != null) body.expectedRevision = result.expectedRevision;
  if (result.currentRevision != null) body.currentRevision = result.currentRevision;
  if (result.current != null) body.current = result.current;
  return body;
}
