import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PrimeSessionsResult, PrimeSessionSummary } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

type PrimeSessionsCatalogState = {
  sessions: readonly PrimeSessionSummary[];
  loadFailed: boolean;
  retry: () => void;
};

const reconcileCatalog = (current: PrimeSessionsResult | null, incoming: PrimeSessionsResult): PrimeSessionsResult => {
  if (incoming.status !== 'partial') return incoming;
  if (current?.status !== 'ready' && current?.status !== 'partial') return incoming;

  const failedSessionIDs = new Set(incoming.failedSessionIDs);
  const sessionsByID = new Map(incoming.sessions.map((session) => [session.id, session]));
  current.sessions.forEach((session) => {
    if (failedSessionIDs.has(session.id) && !sessionsByID.has(session.id)) {
      sessionsByID.set(session.id, session);
    }
  });
  return {
    ...incoming,
    sessions: [...sessionsByID.values()].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    ),
  };
};

export function usePrimeSessionsCatalog(isVisible: boolean): PrimeSessionsCatalogState {
  const primeAPI = useRuntimeAPIs().prime;
  const runtimeKey = getRuntimeKey();
  const [catalogState, setCatalogState] = React.useState<{ runtimeKey: string; catalog: PrimeSessionsResult } | null>(null);
  const [failedRuntimeKey, setFailedRuntimeKey] = React.useState<string | null>(null);
  const [loadRevision, setLoadRevision] = React.useState(0);
  const refresh = React.useCallback(() => setLoadRevision((revision) => revision + 1), []);
  const catalog = catalogState?.runtimeKey === runtimeKey ? catalogState.catalog : null;

  React.useEffect(() => {
    if (!isVisible || !primeAPI) return;
    const abortController = new AbortController();
    let cancelled = false;
    setFailedRuntimeKey((current) => current === runtimeKey ? null : current);
    void primeAPI.listSessions(abortController.signal).then((result) => {
      if (cancelled) return;
      setCatalogState((current) => ({
        runtimeKey,
        catalog: reconcileCatalog(current?.runtimeKey === runtimeKey ? current.catalog : null, result),
      }));
      setFailedRuntimeKey(result.status === 'partial' ? runtimeKey : null);
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
      setFailedRuntimeKey(runtimeKey);
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [isVisible, loadRevision, primeAPI, runtimeKey]);

  React.useEffect(() => {
    if (!isVisible || !primeAPI) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [isVisible, primeAPI, refresh]);

  React.useEffect(() => {
    if (!isVisible || !primeAPI) return;
    const subscription = primeAPI.subscribe((event) => {
      if (event.type === 'runtime-changed' || event.type === 'stream-ready') {
        refresh();
        return;
      }
      setCatalogState((current) => {
        if (current?.runtimeKey !== runtimeKey) return current;
        if (current.catalog.status !== 'ready' && current.catalog.status !== 'partial') return current;
        let changed = false;
        const sessions = current.catalog.sessions.map((session) => {
          if (session.id !== event.sessionID || session.activity === event.activity) return session;
          changed = true;
          return { ...session, activity: event.activity };
        });
        return changed ? { ...current, catalog: { ...current.catalog, sessions } } : current;
      });
      if (event.catalogChanged) refresh();
    });
    return () => subscription.close();
  }, [isVisible, primeAPI, refresh, runtimeKey]);

  const sessions = primeAPI && (catalog?.status === 'ready' || catalog?.status === 'partial')
    ? catalog.sessions
    : [];
  return {
    sessions,
    loadFailed: failedRuntimeKey === runtimeKey,
    retry: refresh,
  };
}
