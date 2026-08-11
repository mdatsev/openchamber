const SNAPSHOT_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;

const normalizeSessionId = (value) => typeof value === 'string' ? value.trim() : '';

const normalizeDirectory = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  return path.normalize(value.trim());
};

const recordKey = (directory, sessionId) => JSON.stringify([directory, sessionId]);

const normalizeRecord = (value, path) => {
  if (!isObjectRecord(value)) return null;
  const directory = normalizeDirectory(value.directory, path);
  const sessionId = normalizeSessionId(value.sessionId);
  const unreadToken = value.unreadToken === null || typeof value.unreadToken === 'string'
    ? value.unreadToken
    : undefined;
  if (!directory || !sessionId || unreadToken === undefined || typeof value.pinned !== 'boolean' || !isRevision(value.revision)) {
    return null;
  }
  return {
    directory,
    sessionId,
    unreadToken,
    pinned: value.pinned,
    revision: value.revision,
  };
};

const normalizeSnapshot = (value, path) => {
  if (!isObjectRecord(value) || value.version !== SNAPSHOT_VERSION || !isRevision(value.revision) || !Array.isArray(value.records)) {
    return null;
  }

  const records = new Map();
  for (const rawRecord of value.records) {
    const record = normalizeRecord(rawRecord, path);
    if (!record || record.revision > value.revision) return null;
    const key = recordKey(record.directory, record.sessionId);
    if (records.has(key)) return null;
    if (record.unreadToken !== null || record.pinned) records.set(key, record);
  }
  return { revision: value.revision, records };
};

const publicRecord = (record, revision, directory, sessionId) => record ?? {
  directory,
  sessionId,
  unreadToken: null,
  pinned: false,
  revision,
};

export const createSessionInboxRuntime = ({
  fsPromises,
  path,
  storePath,
  globalEventHub,
  broadcastGlobalUiEvent,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) => {
  let revision = 0;
  let records = new Map();
  let exists = false;
  let loaded = false;
  let loadPromise = null;
  let operationQueue = Promise.resolve();
  let unsubscribeEvent = null;
  const sessionParents = new Map();

  const serialize = (operation) => {
    const pending = operationQueue.then(operation, operation);
    operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const snapshotPayload = () => ({
    version: SNAPSHOT_VERSION,
    exists,
    revision,
    records: [...records.values()]
      .sort((left, right) => recordKey(left.directory, left.sessionId).localeCompare(recordKey(right.directory, right.sessionId)))
      .map((record) => ({ ...record })),
  });

  const load = async () => {
    if (loaded) return snapshotPayload();
    if (!loadPromise) {
      loadPromise = fsPromises.readFile(storePath, 'utf8')
        .then((raw) => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error('Stored session inbox is malformed');
          }
          const snapshot = normalizeSnapshot(parsed, path);
          if (!snapshot) throw new Error('Stored session inbox has an invalid shape');
          revision = snapshot.revision;
          records = snapshot.records;
          exists = true;
          loaded = true;
          return snapshotPayload();
        })
        .catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
          revision = 0;
          records = new Map();
          exists = false;
          loaded = true;
          return snapshotPayload();
        })
        .finally(() => {
          loadPromise = null;
        });
    }
    return loadPromise;
  };

  const writeSnapshot = async (nextRevision, nextRecords) => {
    const serialized = JSON.stringify({
      version: SNAPSHOT_VERSION,
      revision: nextRevision,
      records: [...nextRecords.values()]
        .sort((left, right) => recordKey(left.directory, left.sessionId).localeCompare(recordKey(right.directory, right.sessionId))),
    }, null, 2);
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${storePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let renamed = false;
    try {
      await fsPromises.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(temporaryPath, storePath);
      renamed = true;
    } finally {
      if (!renamed) await fsPromises.unlink(temporaryPath).catch(() => undefined);
    }
  };

  const broadcastRecord = (record) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-inbox.updated',
      properties: record,
    }, { directory: record.directory });
  };

  const commit = async (directory, sessionId, update) => {
    const key = recordKey(directory, sessionId);
    const current = records.get(key) ?? {
      directory,
      sessionId,
      unreadToken: null,
      pinned: false,
      revision,
    };
    const nextValues = update(current);
    if (nextValues.unreadToken === current.unreadToken && nextValues.pinned === current.pinned) {
      return { ...current };
    }

    const nextRevision = revision + 1;
    const nextRecord = {
      directory,
      sessionId,
      unreadToken: nextValues.unreadToken,
      pinned: nextValues.pinned,
      revision: nextRevision,
    };
    const nextRecords = new Map(records);
    if (nextRecord.unreadToken === null && !nextRecord.pinned) {
      nextRecords.delete(key);
    } else {
      nextRecords.set(key, nextRecord);
    }

    await writeSnapshot(nextRevision, nextRecords);
    revision = nextRevision;
    records = nextRecords;
    exists = true;
    broadcastRecord(nextRecord);
    return { ...nextRecord };
  };

  const rememberSession = (info, directoryHint) => {
    if (!isObjectRecord(info)) return null;
    const sessionId = normalizeSessionId(info.id ?? info.sessionID);
    const directory = normalizeDirectory(info.directory ?? directoryHint, path);
    if (!sessionId || !directory) return null;
    const parentId = normalizeSessionId(info.parentID) || null;
    sessionParents.set(recordKey(directory, sessionId), parentId);
    return { directory, sessionId, parentId };
  };

  const fetchSession = async (sessionId, directory) => {
    const url = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, ''));
    url.searchParams.set('directory', directory);
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`OpenCode session request failed (${response.status})`);
    const payload = await response.json();
    return rememberSession(payload?.data ?? payload, directory);
  };

  const getSessionIdentity = async (sessionId, directory) => {
    const key = recordKey(directory, sessionId);
    if (sessionParents.has(key)) {
      return { directory, sessionId, parentId: sessionParents.get(key) };
    }
    return fetchSession(sessionId, directory);
  };

  const processEvent = (event) => {
    const raw = event?.payload;
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!isObjectRecord(payload)) return;
    const properties = isObjectRecord(payload.properties) ? payload.properties : {};
    const eventDirectory = normalizeDirectory(
      event?.directory !== 'global' ? event?.directory : properties.directory ?? properties.info?.directory,
      path,
    );

    if (payload.type === 'session.created' || payload.type === 'session.updated') {
      rememberSession(properties.info, eventDirectory);
      return;
    }

    if (payload.type === 'session.deleted') {
      const sessionId = normalizeSessionId(properties.sessionID ?? properties.info?.id);
      if (!sessionId || !eventDirectory) return;
      sessionParents.delete(recordKey(eventDirectory, sessionId));
      void serialize(() => commit(eventDirectory, sessionId, () => ({ unreadToken: null, pinned: false })))
        .catch((error) => console.warn('[session-inbox] failed to remove deleted session:', error?.message ?? error));
      return;
    }

    if (payload.type !== 'message.updated') return;
    const info = isObjectRecord(properties.info) ? properties.info : {};
    const sessionId = normalizeSessionId(info.sessionID);
    const messageId = normalizeSessionId(info.id);
    if (!sessionId || !messageId || !eventDirectory || info.role !== 'assistant' || info.finish !== 'stop') return;

    void serialize(async () => {
      const identity = await getSessionIdentity(sessionId, eventDirectory);
      if (!identity || identity.parentId) return null;
      return commit(identity.directory, sessionId, (current) => ({
        unreadToken: `message:${messageId}`,
        pinned: current.pinned,
      }));
    }).catch((error) => console.warn('[session-inbox] failed to record completed response:', error?.message ?? error));
  };

  const start = async () => {
    await load();
    if (!unsubscribeEvent) unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    return snapshotPayload();
  };

  const stop = async () => {
    unsubscribeEvent?.();
    unsubscribeEvent = null;
    await operationQueue;
  };

  const getSnapshot = async () => {
    await load();
    await operationQueue;
    return snapshotPayload();
  };

  const mutate = async (sessionIdValue, input) => {
    await load();
    const sessionId = normalizeSessionId(sessionIdValue);
    const directory = normalizeDirectory(input?.directory, path);
    const action = input?.action;
    if (!sessionId) throw new TypeError('sessionId is required');
    if (!directory) throw new TypeError('directory is required');
    if (!['read', 'unread', 'pin', 'unpin', 'delete'].includes(action)) throw new TypeError('action is invalid');
    if (action === 'read' && (typeof input?.unreadToken !== 'string' || !input.unreadToken)) {
      throw new TypeError('unreadToken is required');
    }

    return serialize(async () => {
      const key = recordKey(directory, sessionId);
      const current = records.get(key);
      if (action === 'read' && current?.unreadToken !== input.unreadToken) {
        return publicRecord(current && { ...current }, revision, directory, sessionId);
      }
      if (action === 'delete') {
        return commit(directory, sessionId, () => ({ unreadToken: null, pinned: false }));
      }
      return commit(directory, sessionId, (record) => {
        let unreadToken = record.unreadToken;
        let pinned = record.pinned;

        switch (action) {
          case 'read':
            unreadToken = null;
            break;
          case 'unread':
            unreadToken = `manual:${revision + 1}`;
            break;
          case 'pin':
            pinned = true;
            break;
          case 'unpin':
            pinned = false;
            break;
        }

        return { unreadToken, pinned };
      });
    });
  };

  return {
    start,
    stop,
    getSnapshot,
    mutate,
  };
};
