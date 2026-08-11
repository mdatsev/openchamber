import { create } from 'zustand';
import { z } from 'zod';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeNotificationStream } from '@/lib/runtime-notification-stream';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from './utils/safeStorage';

const PIN_STORAGE_KEY = 'oc.sessions.pinned.v2';
const LEGACY_PIN_STORAGE_KEY = 'oc.sessions.pinned';
const PIN_MIGRATION_STORAGE_KEY = 'oc.sessions.pinned.server-migration.v1';

const inboxRecordSchema = z.object({
  directory: z.string().min(1),
  sessionId: z.string().min(1),
  unreadToken: z.string().nullable(),
  pinned: z.boolean(),
  revision: z.number().int().nonnegative(),
});

const inboxSnapshotSchema = z.object({
  version: z.literal(1),
  exists: z.boolean(),
  revision: z.number().int().nonnegative(),
  records: z.array(inboxRecordSchema),
});

type SessionInboxRecord = z.infer<typeof inboxRecordSchema>;
export type SessionInboxTarget = { directory: string; sessionId: string };

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>;
    unseenHasError: Record<string, boolean>;
  };
  project: {
    unseenCount: Record<string, number>;
    unseenHasError: Record<string, boolean>;
  };
};

type SessionInboxStore = {
  records: Record<string, SessionInboxRecord>;
  recordRevisions: Record<string, number>;
  snapshotRevision: number;
  runtimeKey: string;
  hydrated: boolean;
  index: NotificationIndex;
  ids: Set<string>;
  touchedAt: Record<string, number>;
  setIds: (next: Set<string> | ((previous: Set<string>) => Set<string>)) => void;
  toggle: (target: SessionInboxTarget) => void;
  clearPinnedSession: (runtimeKey: string, directory: string, sessionId: string) => void;
  sessionUnseenCount: (sessionId: string) => number;
  sessionHasError: (sessionId: string) => boolean;
  projectUnseenCount: (directory: string) => number;
  projectHasError: (directory: string) => boolean;
};

type PersistedPins = { version: 2; sessions: Record<string, number> };
type PinMigrationRegistry = { version: 1; runtimes: string[] };

const emptyIndex = (): NotificationIndex => ({
  session: { unseenCount: {}, unseenHasError: {} },
  project: { unseenCount: {}, unseenHasError: {} },
});

const storage = getDeferredSafeStorage();

export const getSessionInboxKey = (directory: string, sessionId: string) => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory || !sessionId) return null;
  return JSON.stringify([normalizedDirectory, sessionId]);
};

export const getPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string) => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

const parsePinnedSessionKey = (key: string): [string, string, string] | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [runtimeKey, directory, sessionId] = parsed;
    if (typeof runtimeKey !== 'string' || typeof directory !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
    return [runtimeKey, normalizedDirectory, sessionId];
  } catch {
    return null;
  }
};

export const isSessionPinned = (ids: Set<string>, directory: string | null | undefined, sessionId: string) => {
  if (!directory) return false;
  const key = getPinnedSessionKey(getRuntimeKey(), directory, sessionId);
  return key ? ids.has(key) : false;
};

const readPinnedState = () => {
  storage.removeItem(LEGACY_PIN_STORAGE_KEY);
  const raw = storage.getItem(PIN_STORAGE_KEY);
  if (raw === null) return { ids: new Set<string>(), touchedAt: {} as Record<string, number> };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPins>;
    if (parsed.version !== 2 || !parsed.sessions || typeof parsed.sessions !== 'object') {
      return { ids: new Set<string>(), touchedAt: {} as Record<string, number> };
    }
    const entries = Object.entries(parsed.sessions)
      .filter(([key, touchedAt]) => parsePinnedSessionKey(key) && typeof touchedAt === 'number' && Number.isFinite(touchedAt));
    return {
      ids: new Set(entries.map(([key]) => key)),
      touchedAt: Object.fromEntries(entries),
    };
  } catch {
    storage.removeItem(PIN_STORAGE_KEY);
    return { ids: new Set<string>(), touchedAt: {} as Record<string, number> };
  }
};

const persistPinnedState = (state: Pick<SessionInboxStore, 'ids' | 'touchedAt'>) => {
  const sessions = Object.fromEntries([...state.ids].map((key) => [key, state.touchedAt[key] ?? Date.now()]));
  storage.setItem(PIN_STORAGE_KEY, JSON.stringify({ version: 2, sessions }));
};

const readMigratedRuntimeKeys = () => {
  const raw = storage.getItem(PIN_MIGRATION_STORAGE_KEY);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw) as Partial<PinMigrationRegistry>;
    return parsed.version === 1 && Array.isArray(parsed.runtimes)
      ? new Set(parsed.runtimes.filter((value): value is string => typeof value === 'string' && value.length > 0))
      : new Set<string>();
  } catch {
    storage.removeItem(PIN_MIGRATION_STORAGE_KEY);
    return new Set<string>();
  }
};

const markRuntimePinsMigrated = (runtimeKey: string) => {
  const runtimes = readMigratedRuntimeKeys();
  runtimes.add(runtimeKey);
  storage.setItem(PIN_MIGRATION_STORAGE_KEY, JSON.stringify({ version: 1, runtimes: [...runtimes].sort() }));
};

const buildIndex = (records: Record<string, SessionInboxRecord>) => {
  const index = emptyIndex();
  for (const record of Object.values(records)) {
    if (record.unreadToken === null) continue;
    index.session.unseenCount[record.sessionId] = (index.session.unseenCount[record.sessionId] ?? 0) + 1;
    index.project.unseenCount[record.directory] = (index.project.unseenCount[record.directory] ?? 0) + 1;
  }
  return index;
};

const initialPins = readPinnedState();
let mutationRevision = 0;
let hydrationGeneration = 0;
let hydrationOwner = '';
let hydrationPromise: Promise<void> | null = null;
let shouldRehydrate = false;
let localUnreadSequence = 0;
let inboxStreamUnsubscribe: (() => void) | null = null;

const applyLocalRecord = (target: SessionInboxTarget, update: (current: SessionInboxRecord) => SessionInboxRecord) => {
  const key = getSessionInboxKey(target.directory, target.sessionId);
  if (!key) return;
  useSessionInboxStore.setState((state) => {
    const current = state.records[key] ?? {
      directory: normalizePath(target.directory) ?? target.directory,
      sessionId: target.sessionId,
      unreadToken: null,
      pinned: false,
      revision: state.recordRevisions[key] ?? 0,
    };
    const next = update(current);
    const records = { ...state.records };
    if (next.unreadToken === null && !next.pinned) delete records[key];
    else records[key] = next;

    const ids = new Set(state.ids);
    const touchedAt = { ...state.touchedAt };
    const pinKey = getPinnedSessionKey(state.runtimeKey, next.directory, next.sessionId);
    if (pinKey) {
      if (next.pinned) {
        ids.add(pinKey);
        touchedAt[pinKey] = touchedAt[pinKey] ?? Date.now();
      } else {
        ids.delete(pinKey);
        delete touchedAt[pinKey];
      }
    }
    return { records, index: buildIndex(records), ids, touchedAt };
  });
  mutationRevision += 1;
  persistPinnedState(useSessionInboxStore.getState());
};

const applySessionInboxRecord = (record: SessionInboxRecord, expectedRuntimeKey = getRuntimeKey()) => {
  const parsed = inboxRecordSchema.safeParse(record);
  if (!parsed.success || expectedRuntimeKey !== getRuntimeKey()) return false;
  const key = getSessionInboxKey(parsed.data.directory, parsed.data.sessionId);
  if (!key) return false;
  let changed = false;
  useSessionInboxStore.setState((state) => {
    if (state.runtimeKey !== expectedRuntimeKey) return state;
    const currentRevision = state.recordRevisions[key] ?? 0;
    if (parsed.data.revision <= currentRevision || parsed.data.revision <= state.snapshotRevision) return state;
    const records = { ...state.records };
    if (parsed.data.unreadToken === null && !parsed.data.pinned) delete records[key];
    else records[key] = parsed.data;
    const recordRevisions = { ...state.recordRevisions, [key]: parsed.data.revision };

    const ids = new Set(state.ids);
    const touchedAt = { ...state.touchedAt };
    const pinKey = getPinnedSessionKey(expectedRuntimeKey, parsed.data.directory, parsed.data.sessionId);
    if (pinKey) {
      if (parsed.data.pinned) {
        ids.add(pinKey);
        touchedAt[pinKey] = touchedAt[pinKey] ?? Date.now();
      } else {
        ids.delete(pinKey);
        delete touchedAt[pinKey];
      }
    }
    changed = true;
    return {
      records,
      recordRevisions,
      index: buildIndex(records),
      ids,
      touchedAt,
    };
  });
  if (changed) {
    mutationRevision += 1;
    persistPinnedState(useSessionInboxStore.getState());
  }
  return changed;
};

export const applySessionInboxEventPayload = (payload: unknown, expectedRuntimeKey = getRuntimeKey()) => {
  const parsed = inboxRecordSchema.safeParse(payload);
  return parsed.success && applySessionInboxRecord(parsed.data, expectedRuntimeKey);
};

const applySessionInboxSnapshot = (snapshot: z.infer<typeof inboxSnapshotSchema>, runtimeKey: string) => {
  const records: Record<string, SessionInboxRecord> = {};
  const recordRevisions: Record<string, number> = {};
  for (const record of snapshot.records) {
    const key = getSessionInboxKey(record.directory, record.sessionId);
    if (!key) continue;
    records[key] = record;
    recordRevisions[key] = record.revision;
  }

  useSessionInboxStore.setState((state) => {
    if (state.runtimeKey !== runtimeKey) return state;
    const ids = new Set([...state.ids].filter((key) => parsePinnedSessionKey(key)?.[0] !== runtimeKey));
    const touchedAt = Object.fromEntries(
      Object.entries(state.touchedAt).filter(([key]) => parsePinnedSessionKey(key)?.[0] !== runtimeKey),
    );
    for (const record of snapshot.records) {
      if (!record.pinned) continue;
      const pinKey = getPinnedSessionKey(runtimeKey, record.directory, record.sessionId);
      if (!pinKey) continue;
      ids.add(pinKey);
      touchedAt[pinKey] = state.touchedAt[pinKey] ?? Date.now();
    }
    return {
      records,
      recordRevisions,
      snapshotRevision: snapshot.revision,
      hydrated: true,
      index: buildIndex(records),
      ids,
      touchedAt,
    };
  });
  mutationRevision += 1;
  persistPinnedState(useSessionInboxStore.getState());
};

const fetchSnapshot = async () => {
  const response = await runtimeFetch('/api/session-inbox');
  if (!response.ok) throw new Error(`Session inbox request failed (${response.status})`);
  const parsed = inboxSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Session inbox response has an invalid shape');
  return parsed.data;
};

const requestMutation = async (target: SessionInboxTarget, action: 'read' | 'unread' | 'pin' | 'unpin' | 'delete', unreadToken?: string) => {
  const response = await runtimeFetch(`/api/session-inbox/sessions/${encodeURIComponent(target.sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: target.directory, action, ...(unreadToken ? { unreadToken } : {}) }),
  });
  if (!response.ok) throw new Error(`Session inbox mutation failed (${response.status})`);
  const parsed = inboxRecordSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Session inbox mutation response has an invalid shape');
  return parsed.data;
};

const ensureInboxRealtime = () => {
  if (inboxStreamUnsubscribe) return;
  inboxStreamUnsubscribe = subscribeRuntimeNotificationStream((payload) => {
    if (!payload || typeof payload !== 'object') return;
    const envelope = payload as { type?: unknown; properties?: unknown };
    if (envelope.type !== 'openchamber:session-inbox.updated') return;
    applySessionInboxEventPayload(envelope.properties);
  });
};

const migrateLocalPins = async (snapshot: z.infer<typeof inboxSnapshotSchema>, runtimeKey: string) => {
  if (readMigratedRuntimeKeys().has(runtimeKey)) return false;
  const serverPins = new Set(snapshot.records.filter((record) => record.pinned).map((record) => getSessionInboxKey(record.directory, record.sessionId)));
  const targets = [...useSessionInboxStore.getState().ids]
    .map(parsePinnedSessionKey)
    .filter((entry): entry is [string, string, string] => entry?.[0] === runtimeKey)
    .map(([, directory, sessionId]) => ({ directory, sessionId }))
    .filter((target) => !serverPins.has(getSessionInboxKey(target.directory, target.sessionId)));
  await Promise.all(targets.map((target) => requestMutation(target, 'pin')));
  markRuntimePinsMigrated(runtimeKey);
  return targets.length > 0;
};

export const hydrateSessionInbox = () => {
  ensureInboxRealtime();
  const runtimeKey = getRuntimeKey();
  if (hydrationPromise && hydrationOwner === runtimeKey) return hydrationPromise;
  const generation = ++hydrationGeneration;
  hydrationOwner = runtimeKey;
  hydrationPromise = (async () => {
    let baselineMutationRevision = mutationRevision;
    let snapshot = await fetchSnapshot();
    if (generation !== hydrationGeneration || runtimeKey !== getRuntimeKey()) return;
    if (baselineMutationRevision !== mutationRevision) {
      shouldRehydrate = true;
      return;
    }
    if (await migrateLocalPins(snapshot, runtimeKey)) {
      baselineMutationRevision = mutationRevision;
      snapshot = await fetchSnapshot();
    }
    if (generation !== hydrationGeneration || runtimeKey !== getRuntimeKey()) return;
    if (baselineMutationRevision !== mutationRevision) {
      shouldRehydrate = true;
      return;
    }
    applySessionInboxSnapshot(snapshot, runtimeKey);
  })().finally(() => {
    if (generation !== hydrationGeneration) return;
    hydrationPromise = null;
    hydrationOwner = '';
    if (shouldRehydrate) {
      shouldRehydrate = false;
      queueMicrotask(() => void hydrateSessionInbox().catch(() => undefined));
    }
  });
  return hydrationPromise;
};

export const markSessionInboxRead = async (target: SessionInboxTarget, expectedUnreadToken?: string) => {
  const key = getSessionInboxKey(target.directory, target.sessionId);
  if (!key) return false;
  const runtimeKey = getRuntimeKey();
  const current = useSessionInboxStore.getState().records[key];
  const unreadToken = expectedUnreadToken ?? current?.unreadToken;
  if (!unreadToken) return true;
  const baselineRevision = useSessionInboxStore.getState().recordRevisions[key] ?? 0;
  if (current?.unreadToken === unreadToken) {
    applyLocalRecord(target, (record) => ({ ...record, unreadToken: null }));
  }
  try {
    const record = await requestMutation(target, 'read', unreadToken);
    if (runtimeKey === getRuntimeKey()) applySessionInboxRecord(record, runtimeKey);
    return true;
  } catch {
    const state = useSessionInboxStore.getState();
    const latest = state.records[key];
    if (runtimeKey === getRuntimeKey() && (state.recordRevisions[key] ?? 0) === baselineRevision && (latest?.unreadToken ?? null) === null) {
      applyLocalRecord(target, (record) => ({ ...record, unreadToken }));
    }
    return false;
  }
};

export const markSessionInboxUnread = async (target: SessionInboxTarget) => {
  const key = getSessionInboxKey(target.directory, target.sessionId);
  if (!key) return false;
  if (useSessionInboxStore.getState().records[key]?.unreadToken) return true;
  const runtimeKey = getRuntimeKey();
  const baselineRevision = useSessionInboxStore.getState().recordRevisions[key] ?? 0;
  const localToken = `local:${++localUnreadSequence}`;
  applyLocalRecord(target, (record) => ({ ...record, unreadToken: localToken }));
  try {
    const record = await requestMutation(target, 'unread');
    if (runtimeKey === getRuntimeKey()) applySessionInboxRecord(record, runtimeKey);
    return true;
  } catch {
    const state = useSessionInboxStore.getState();
    if (runtimeKey === getRuntimeKey() && (state.recordRevisions[key] ?? 0) === baselineRevision && state.records[key]?.unreadToken === localToken) {
      applyLocalRecord(target, (record) => ({ ...record, unreadToken: null }));
    }
    return false;
  }
};

const setSessionInboxPinned = async (target: SessionInboxTarget, pinned: boolean) => {
  const key = getSessionInboxKey(target.directory, target.sessionId);
  if (!key) return false;
  const runtimeKey = getRuntimeKey();
  const current = useSessionInboxStore.getState().records[key];
  const previousPinned = current?.pinned ?? isSessionPinned(useSessionInboxStore.getState().ids, target.directory, target.sessionId);
  if (previousPinned === pinned) return true;
  const baselineRevision = useSessionInboxStore.getState().recordRevisions[key] ?? 0;
  applyLocalRecord(target, (record) => ({ ...record, pinned }));
  try {
    const record = await requestMutation(target, pinned ? 'pin' : 'unpin');
    if (runtimeKey === getRuntimeKey()) applySessionInboxRecord(record, runtimeKey);
    return true;
  } catch {
    const state = useSessionInboxStore.getState();
    if (runtimeKey === getRuntimeKey() && (state.recordRevisions[key] ?? 0) === baselineRevision && (state.records[key]?.pinned ?? false) === pinned) {
      applyLocalRecord(target, (record) => ({ ...record, pinned: previousPinned }));
    }
    return false;
  }
};

export const deleteSessionInboxRecord = (target: SessionInboxTarget) => {
  applyLocalRecord(target, (record) => ({ ...record, unreadToken: null, pinned: false }));
  void requestMutation(target, 'delete').catch(() => undefined);
};

export const resetSessionInboxForRuntimeSwitch = (runtimeKey: string) => {
  hydrationGeneration += 1;
  hydrationPromise = null;
  hydrationOwner = '';
  shouldRehydrate = false;
  mutationRevision += 1;
  useSessionInboxStore.setState({
    records: {},
    recordRevisions: {},
    snapshotRevision: 0,
    runtimeKey,
    hydrated: false,
    index: emptyIndex(),
  });
};

export const useSessionInboxStore = create<SessionInboxStore>((set, get) => ({
  records: {},
  recordRevisions: {},
  snapshotRevision: 0,
  runtimeKey: getRuntimeKey(),
  hydrated: false,
  index: emptyIndex(),
  ids: initialPins.ids,
  touchedAt: initialPins.touchedAt,
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current) return;
    const touchedAt = Object.fromEntries([...resolved].map((key) => [key, get().touchedAt[key] ?? Date.now()]));
    set({ ids: new Set(resolved), touchedAt });
    persistPinnedState(get());
  },
  toggle: (target) => {
    const key = getSessionInboxKey(target.directory, target.sessionId);
    const pinned = key ? get().records[key]?.pinned ?? isSessionPinned(get().ids, target.directory, target.sessionId) : false;
    void setSessionInboxPinned(target, !pinned);
  },
  clearPinnedSession: (runtimeKey, directory, sessionId) => {
    const key = getPinnedSessionKey(runtimeKey, directory, sessionId);
    if (!key || !get().ids.has(key)) return;
    const ids = new Set(get().ids);
    ids.delete(key);
    const touchedAt = { ...get().touchedAt };
    delete touchedAt[key];
    set({ ids, touchedAt });
    persistPinnedState(get());
    if (runtimeKey === getRuntimeKey()) void setSessionInboxPinned({ directory, sessionId }, false);
  },
  sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
  sessionHasError: () => false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: () => false,
}));
