const DEFAULT_TTL_MS = 12_000;
const DEFAULT_DOCUMENT_LIMIT = 4_000;

export function createCollaborationService({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const listeners = new Map();
  const documents = new Map();

  function assetKey(projectId, assetType, assetId) {
    return `${projectId}:${assetType}:${assetId}`;
  }

  function documentKey(key, documentId) {
    return `${key}:${documentId}`;
  }

  function present(member) {
    return {
      clientId: member.clientId,
      userId: member.userId,
      name: member.name,
      mode: member.mode,
      revision: member.revision,
      documentId: member.documentId || null,
      selection: member.selection || null,
      joinedAt: new Date(member.joinedAtMs).toISOString(),
      lastSeenAt: new Date(member.lastSeenAtMs).toISOString(),
    };
  }

  function documentState(document) {
    return {
      documentId: document.documentId,
      value: document.value,
      sequence: document.sequence,
      assetRevision: document.assetRevision,
      updatedBy: document.updatedBy,
      updatedAt: new Date(document.updatedAtMs).toISOString(),
    };
  }

  function membersFor(key) {
    return [...(sessions.get(key)?.values() || [])]
      .sort((left, right) => left.joinedAtMs - right.joinedAtMs)
      .map(present);
  }

  function publish(key, event) {
    for (const listener of listeners.get(key) || []) listener(event);
  }

  function cleanup(key) {
    const cutoff = now() - ttlMs;
    const members = sessions.get(key);
    if (!members) return false;
    let changed = false;
    for (const [clientId, member] of members) {
      if (member.lastSeenAtMs < cutoff) {
        members.delete(clientId);
        changed = true;
      }
    }
    if (!members.size) sessions.delete(key);
    return changed;
  }

  function snapshot({ projectId, assetType, assetId, currentRevision }) {
    const key = assetKey(projectId, assetType, assetId);
    cleanup(key);
    return { currentRevision, members: membersFor(key) };
  }

  function heartbeat({ projectId, assetType, assetId, clientId, principal, mode, revision, currentRevision }) {
    const key = assetKey(projectId, assetType, assetId);
    const expired = cleanup(key);
    const members = sessions.get(key) || new Map();
    const timestamp = now();
    const previous = members.get(clientId);
    members.set(clientId, {
      clientId,
      userId: principal.id,
      name: principal.name || principal.id,
      mode,
      revision,
      documentId: previous?.documentId || null,
      selection: previous?.selection || null,
      joinedAtMs: previous?.joinedAtMs || timestamp,
      lastSeenAtMs: timestamp,
    });
    sessions.set(key, members);
    const state = { currentRevision, members: membersFor(key) };
    if (!previous || expired || previous.mode !== mode || previous.revision !== revision) {
      publish(key, { type: 'presence', ...state });
    }
    return state;
  }

  function updateCursor({ projectId, assetType, assetId, clientId, documentId, selection, currentRevision }) {
    const key = assetKey(projectId, assetType, assetId);
    cleanup(key);
    const member = sessions.get(key)?.get(clientId);
    if (!member) return null;
    member.documentId = documentId;
    member.selection = selection;
    member.lastSeenAtMs = now();
    const state = { currentRevision, members: membersFor(key) };
    publish(key, { type: 'cursor', clientId, documentId, selection, members: state.members });
    return state;
  }

  function updateText({ projectId, assetType, assetId, clientId, documentId, baseSequence, value, currentRevision, limit = DEFAULT_DOCUMENT_LIMIT }) {
    const key = assetKey(projectId, assetType, assetId);
    cleanup(key);
    if (!sessions.get(key)?.has(clientId)) return { status: 409, error: '协作会话已过期，请重新连接' };
    if (value.length > limit) return { status: 400, error: `协作文档不能超过 ${limit} 个字符` };
    const keyForDocument = documentKey(key, documentId);
    const stored = documents.get(keyForDocument);
    const current = stored?.assetRevision === currentRevision ? stored : null;
    if (stored && !current) documents.delete(keyForDocument);
    const currentSequence = current?.sequence || 0;
    if (baseSequence !== currentSequence) {
      return {
        status: 409,
        error: `协作文档序列冲突：客户端 s${baseSequence}，服务器最新 s${currentSequence}`,
        current: current ? documentState(current) : { documentId, value: '', sequence: 0, updatedBy: null, updatedAt: null },
      };
    }
    const document = {
      documentId,
      value,
      sequence: currentSequence + 1,
      assetRevision: currentRevision,
      updatedBy: clientId,
      updatedAtMs: now(),
    };
    documents.set(keyForDocument, document);
    const state = documentState(document);
    publish(key, { type: 'text', ...state });
    return { status: 200, document: state };
  }

  function leave({ projectId, assetType, assetId, clientId, currentRevision }) {
    const key = assetKey(projectId, assetType, assetId);
    cleanup(key);
    const members = sessions.get(key);
    const removed = members?.delete(clientId) || false;
    if (members && !members.size) sessions.delete(key);
    const state = { currentRevision, members: membersFor(key) };
    if (removed) publish(key, { type: 'presence', ...state });
    return state;
  }

  function subscribe(input, listener) {
    const key = assetKey(input.projectId, input.assetType, input.assetId);
    const current = listeners.get(key) || new Set();
    current.add(listener);
    listeners.set(key, current);
    return () => {
      current.delete(listener);
      if (!current.size) listeners.delete(key);
    };
  }

  function getDocument({ projectId, assetType, assetId, documentId, currentRevision }) {
    const key = documentKey(assetKey(projectId, assetType, assetId), documentId);
    const document = documents.get(key);
    if (document && currentRevision != null && document.assetRevision !== currentRevision) {
      documents.delete(key);
      return null;
    }
    return document ? documentState(document) : null;
  }

  return { heartbeat, leave, snapshot, subscribe, updateCursor, updateText, getDocument };
}
