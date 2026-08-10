import { create } from 'zustand';

import type {
  PrimeCatalogResponse,
  PrimeCatalogSession,
  PrimeIssue,
  RuntimeAPIs,
} from '@/lib/api/types';
import type { ChatIdentity } from '@/lib/chat-identity';
import { removePrimeCatalogDirectories, replacePrimeCatalogDirectories } from '@/components/session/sidebar/primeSessionAdapter';

export type PrimeCatalogAvailability = 'unresolved' | 'loading' | 'ready' | 'unavailable' | 'unsupported';

export type PrimeCatalogRecord = Readonly<Omit<PrimeCatalogSession, 'workingDirectory'>>;

export type PrimeCatalogSnapshot = Readonly<{
  runtimeKey: string;
  availability: PrimeCatalogAvailability;
  revision: string | null;
  complete: boolean;
  records: PrimeCatalogRecord[];
  issues: PrimeIssue[];
}>;

type PrimeCatalogStore = {
  byRuntime: ReadonlyMap<string, PrimeCatalogSnapshot>;
};

const EMPTY_SNAPSHOT_BY_RUNTIME = new Map<string, PrimeCatalogSnapshot>();
const PRIME_CATALOG_RUNTIME_LIMIT = 8;
const requestRevisionByRuntime = new Map<string, number>();
const inFlightByRuntime = new Map<string, Promise<void>>();

const initialSnapshot = (runtimeKey: string): PrimeCatalogSnapshot => ({
  runtimeKey,
  availability: 'unresolved',
  revision: null,
  complete: false,
  records: [],
  issues: [],
});

export const usePrimeCatalogStore = create<PrimeCatalogStore>()(() => ({
  byRuntime: EMPTY_SNAPSHOT_BY_RUNTIME,
}));

const updateSnapshot = (
  runtimeKey: string,
  update: (previous: PrimeCatalogSnapshot) => PrimeCatalogSnapshot,
) => {
  usePrimeCatalogStore.setState((state) => {
    const previous = state.byRuntime.get(runtimeKey) ?? initialSnapshot(runtimeKey);
    const next = update(previous);
    if (next === previous) return state;
    const byRuntime = new Map(state.byRuntime);
    byRuntime.delete(runtimeKey);
    byRuntime.set(runtimeKey, next);
    while (byRuntime.size > PRIME_CATALOG_RUNTIME_LIMIT) {
      const oldestRuntimeKey = byRuntime.keys().next().value;
      if (typeof oldestRuntimeKey !== 'string') break;
      byRuntime.delete(oldestRuntimeKey);
      removePrimeCatalogDirectories(oldestRuntimeKey);
      requestRevisionByRuntime.delete(oldestRuntimeKey);
    }
    return { byRuntime };
  });
};

const errorIssue = (error: unknown): PrimeIssue => {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string') {
    return { code: error.code };
  }
  return { code: 'prime_request_failed' };
};

const isUnsupportedError = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'status' in error && error.status === 501
);

const commitCatalog = (runtimeKey: string, response: PrimeCatalogResponse) => {
  replacePrimeCatalogDirectories(runtimeKey, response.sessions);
  updateSnapshot(runtimeKey, () => ({
    runtimeKey,
    availability: 'ready',
    revision: response.revision,
    complete: response.complete,
    records: response.sessions.map((record) => {
      const publicRecord = { ...record };
      delete publicRecord.workingDirectory;
      return publicRecord;
    }),
    issues: response.issues,
  }));
};

export const refreshPrimeCatalog = (runtimeKey: string, apis: RuntimeAPIs): Promise<void> => {
  const existing = inFlightByRuntime.get(runtimeKey);
  if (existing) return existing;
  const requestRevision = (requestRevisionByRuntime.get(runtimeKey) ?? 0) + 1;
  requestRevisionByRuntime.set(runtimeKey, requestRevision);
  updateSnapshot(runtimeKey, (previous) => ({
    ...previous,
    availability: 'loading',
    issues: [],
  }));

  const request = (async () => {
    try {
      const status = await apis.prime.getStatus();
      if (requestRevisionByRuntime.get(runtimeKey) !== requestRevision) return;
      if (!status.supported) {
        updateSnapshot(runtimeKey, (previous) => ({
          ...previous,
          availability: 'unsupported',
          complete: false,
          issues: status.issues.length > 0 ? status.issues : [{ code: 'prime_unsupported' }],
        }));
        return;
      }
      if (status.availability !== 'ready') {
        updateSnapshot(runtimeKey, (previous) => ({
          ...previous,
          availability: 'unavailable',
          complete: false,
          issues: status.issues,
        }));
        return;
      }

      const response = await apis.prime.getCatalog();
      if (requestRevisionByRuntime.get(runtimeKey) !== requestRevision) return;
      commitCatalog(runtimeKey, response);
    } catch (error) {
      if (requestRevisionByRuntime.get(runtimeKey) !== requestRevision) return;
      updateSnapshot(runtimeKey, (previous) => ({
        ...previous,
        availability: isUnsupportedError(error) ? 'unsupported' : 'unavailable',
        complete: false,
        issues: [errorIssue(error)],
      }));
    }
  })();
  inFlightByRuntime.set(runtimeKey, request);
  void request.finally(() => {
    if (inFlightByRuntime.get(runtimeKey) === request) {
      inFlightByRuntime.delete(runtimeKey);
    }
  });
  return request;
};

export const refreshPrimeCatalogAfterCreation = async (
  runtimeKey: string,
  apis: RuntimeAPIs,
): Promise<void> => {
  const existing = inFlightByRuntime.get(runtimeKey);
  if (existing) await existing;
  await refreshPrimeCatalog(runtimeKey, apis);
};

export const ensurePrimeCatalog = (runtimeKey: string, apis: RuntimeAPIs): Promise<void> => {
  const existing = inFlightByRuntime.get(runtimeKey);
  if (existing) return existing;
  const snapshot = usePrimeCatalogStore.getState().byRuntime.get(runtimeKey);
  if (snapshot && (snapshot.availability === 'ready' || snapshot.availability === 'unsupported')) {
    return Promise.resolve();
  }
  return refreshPrimeCatalog(runtimeKey, apis);
};

export const getPrimeCatalogSnapshot = (runtimeKey: string): PrimeCatalogSnapshot => (
  usePrimeCatalogStore.getState().byRuntime.get(runtimeKey) ?? initialSnapshot(runtimeKey)
);

export const usePrimeCatalogRecord = (identity: ChatIdentity | null): PrimeCatalogRecord | null => (
  usePrimeCatalogStore((state) => {
    if (!identity || identity.harness !== 'prime') return null;
    const snapshot = state.byRuntime.get(identity.runtimeKey);
    return snapshot?.records.find((record) => record.sessionId === identity.sessionId) ?? null;
  })
);
