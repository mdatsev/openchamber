import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
} from './session-activity-timing';

// Shared live busy/retry index for every directory. Global events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle status entries are kept; absence means idle. Entries carry
// their directory so a polled per-directory snapshot can authoritatively
// replace that directory's slice (the server omits idle sessions from
// snapshots). Interrupted markers are separate leaf state derived only after
// message history and an authoritative snapshot have both reconciled.

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
  interruptedIds: Set<string>;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
  interruptedIds: new Set(),
}));

export const setGlobalSessionInterrupted = (sessionId: string, interrupted: boolean): void => {
  useGlobalSessionStatusStore.setState((state) => {
    if (state.interruptedIds.has(sessionId) === interrupted) return state;
    const interruptedIds = new Set(state.interruptedIds);
    if (interrupted) interruptedIds.add(sessionId);
    else interruptedIds.delete(sessionId);
    return { interruptedIds };
  });
};

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const setStatus = (sessionId: string, directory: string, status: SessionStatus | { type: 'idle' }): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const current = state.statusById.get(sessionId);
    const wasInterrupted = state.interruptedIds.has(sessionId);
    const interruptedIds = wasInterrupted ? new Set(state.interruptedIds) : state.interruptedIds;
    if (wasInterrupted) interruptedIds.delete(sessionId);
    if (status.type === 'idle') {
      if (!current && !wasInterrupted) return state;
      const next = new Map(state.statusById);
      next.delete(sessionId);
      return { statusById: next, interruptedIds };
    }
    if (current && current.directory === directory && statusesEqual(current.status, status)) {
      return wasInterrupted ? { interruptedIds } : state;
    }
    const next = new Map(state.statusById);
    next.set(sessionId, { status, directory });
    return { statusById: next, interruptedIds };
  });
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        props.sessionID,
        normalizeDirectory(directory),
        type === 'idle' ? { type: 'idle' } : { ...(props.status ?? {}), type } as SessionStatus,
      );
      observeSessionActivityEvent(props.sessionID, type === 'idle' ? 'settled' : 'active');
      // `retry` is still a running turn, so the elapsed counter keeps going.
      observeSessionActivityTiming(props.sessionID, type === 'idle' ? 'settled' : 'active');
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(props.sessionID, 'settled');
        observeSessionActivityTiming(props.sessionID, 'settled');
      }
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        setGlobalSessionInterrupted(sessionId, false);
        removeSessionOrdering(sessionId);
        removeSessionActivityTiming(sessionId);
      }
      return;
    }
    default:
      return;
  }
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status?.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  reconcileSessionActivityTiming(
    activeSessionIds,
    (sessionId) => known.has(sessionId) || sessionId in raw,
  );
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
    const next = new Map(state.statusById);
    let interruptedIds = state.interruptedIds;

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          changed = true;
        }
        continue;
      }
      const normalizedStatus = { ...status, type } as SessionStatus;
      if (interruptedIds.has(sessionId)) {
        if (interruptedIds === state.interruptedIds) interruptedIds = new Set(interruptedIds);
        interruptedIds.delete(sessionId);
        changed = true;
      }
      if (!current || current.directory !== directory || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        changed = true;
      }
    }

    return changed ? { statusById: next, interruptedIds } : state;
  });
};
