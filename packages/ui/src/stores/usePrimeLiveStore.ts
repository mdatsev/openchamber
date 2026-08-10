import { create } from 'zustand';

import type { PrimeIssue, PrimeLiveSnapshot, PrimeLiveStreamEvent, RuntimeAPIs } from '@/lib/api/types';
import { chatIdentitiesEqual, serializeChatIdentity, type ChatIdentity } from '@/lib/chat-identity';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import {
  beginPrimeLiveTranscript,
  commitPrimeLiveTranscript,
  endPrimeLiveTranscript,
  markPrimeLiveTranscriptStale,
  resumePrimePassiveTranscript,
} from '@/stores/usePrimeTranscriptStore';

export type PrimeLiveAvailability =
  | 'inactive'
  | 'activating'
  | 'connecting'
  | 'live'
  | 'stale'
  | 'unavailable'
  | 'deactivating';

export type PrimeLiveState = Readonly<{
  key: string;
  identity: ChatIdentity;
  desiredActive: boolean;
  availability: PrimeLiveAvailability;
  snapshot: PrimeLiveSnapshot | null;
  issues: PrimeIssue[];
}>;

type PrimeLiveStore = {
  byKey: ReadonlyMap<string, PrimeLiveState>;
};

const PRIME_LIVE_CACHE_LIMIT = 16;
const SNAPSHOT_REFRESH_DELAY_MS = 120;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;
const RETRY_BACKGROUND_MIN_MS = 15_000;
const RETRY_BACKGROUND_MAX_MS = 60_000;

export const getPrimeLiveKey = (identity: ChatIdentity): string => serializeChatIdentity(identity);

export const projectFreshPrimeActivityBySession = (
  runtimeKey: string,
  states: ReadonlyMap<string, PrimeLiveState>,
): ReadonlyMap<string, 'working' | 'idle'> => {
  const activity = new Map<string, 'working' | 'idle'>();
  for (const state of states.values()) {
    const snapshot = state.snapshot;
    if (state.identity.runtimeKey !== runtimeKey
      || !state.desiredActive
      || state.availability !== 'live'
      || snapshot?.freshness.state !== 'fresh'
      || (snapshot.status.activity !== 'working' && snapshot.status.activity !== 'idle')) continue;
    activity.set(state.identity.sessionId, snapshot.status.activity);
  }
  return activity;
};

const initialState = (identity: ChatIdentity): PrimeLiveState => ({
  key: getPrimeLiveKey(identity),
  identity,
  desiredActive: false,
  availability: 'inactive',
  snapshot: null,
  issues: [],
});

export const usePrimeLiveStore = create<PrimeLiveStore>()(() => ({ byKey: new Map() }));

const updateLiveState = (
  identity: ChatIdentity,
  update: (previous: PrimeLiveState) => PrimeLiveState,
) => {
  const key = getPrimeLiveKey(identity);
  usePrimeLiveStore.setState((state) => {
    const previous = state.byKey.get(key) ?? initialState(identity);
    const next = update(previous);
    if (next === previous) return state;
    const byKey = new Map(state.byKey);
    byKey.delete(key);
    byKey.set(key, next);
    if (byKey.size > PRIME_LIVE_CACHE_LIMIT) {
      for (const [candidateKey, candidate] of byKey) {
        if (byKey.size <= PRIME_LIVE_CACHE_LIMIT) break;
        if (!candidate.desiredActive && !pipelines.has(candidateKey)) byKey.delete(candidateKey);
      }
    }
    return { byKey };
  });
};

const issueFromError = (error: unknown): PrimeIssue => {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string') {
    return { code: error.code };
  }
  return { code: 'prime_live_request_failed' };
};

const isAbortError = (error: unknown): boolean => (
  (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
  || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
);

const errorStatus = (error: unknown): number | null => (
  typeof error === 'object' && error !== null && 'status' in error
    && typeof error.status === 'number'
    ? error.status
    : null
);

const isPrimeActivationLost = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && error.code === 'prime_runtime_not_activated'
);

const isBackgrounded = (): boolean => (
  (typeof navigator !== 'undefined' && navigator.onLine === false)
  || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
);

const retryDelay = (failures: number, error: unknown): number => {
  const status = errorStatus(error);
  const permanentClientFailure = status !== null
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429;
  const foreground = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures, 5), RETRY_MAX_MS);
  if (!isBackgrounded() && !permanentClientFailure) return foreground;
  return Math.min(Math.max(foreground, RETRY_BACKGROUND_MIN_MS), RETRY_BACKGROUND_MAX_MS);
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted || delayMs <= 0) {
    resolve();
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', finish);
    if (typeof window !== 'undefined') window.removeEventListener('online', finish);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
  };
  const finish = () => {
    cleanup();
    resolve();
  };
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') finish();
  };
  timeout = setTimeout(finish, delayMs);
  signal.addEventListener('abort', finish, { once: true });
  if (typeof window !== 'undefined') window.addEventListener('online', finish, { once: true });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);
});

type PrimeLivePipeline = {
  identity: ChatIdentity;
  apis: RuntimeAPIs;
  lifecycle: AbortController;
  connection: AbortController | null;
  generation: string | null;
  revision: number | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  snapshotRequest: Promise<void> | null;
  recoveryRequired: boolean;
  terminal: boolean;
  lastError: unknown;
};

const pipelines = new Map<string, PrimeLivePipeline>();
const activationByKey = new Map<string, Promise<void>>();

const markStale = (pipeline: PrimeLivePipeline, code: string) => {
  markPrimeLiveTranscriptStale(pipeline.identity, code);
  updateLiveState(pipeline.identity, (previous) => ({
    ...previous,
    availability: 'stale',
    issues: [...previous.issues.filter((issue) => issue.code !== code), {
      code,
      sessionId: pipeline.identity.sessionId,
    }],
  }));
};

const acceptSnapshot = (pipeline: PrimeLivePipeline, snapshot: PrimeLiveSnapshot): boolean => {
  if (snapshot.sessionId !== pipeline.identity.sessionId) return false;
  if (pipeline.generation === snapshot.generation
    && pipeline.revision !== null
    && snapshot.revision < pipeline.revision) return false;
  pipeline.generation = snapshot.generation;
  pipeline.revision = snapshot.revision;
  commitPrimeLiveTranscript(pipeline.identity, snapshot);
  updateLiveState(pipeline.identity, (previous) => ({
    ...previous,
    desiredActive: snapshot.freshness.state !== 'stale'
      || snapshot.freshness.reason !== 'deactivated',
    availability: snapshot.freshness.state === 'fresh' ? 'live' : 'stale',
    snapshot,
    issues: snapshot.freshness.state === 'fresh'
      ? []
      : [{ code: `prime_live_${snapshot.freshness.reason}`, sessionId: pipeline.identity.sessionId }],
  }));
  if (snapshot.freshness.state === 'stale' && snapshot.freshness.reason === 'deactivated') {
    pipeline.terminal = true;
  }
  return true;
};

const requestSnapshotCatchup = (pipeline: PrimeLivePipeline): Promise<void> => {
  if (pipeline.snapshotRequest) return pipeline.snapshotRequest;
  const request = (async () => {
    let regressedSnapshots = 0;
    while (!pipeline.lifecycle.signal.aborted && !pipeline.terminal) {
      try {
        const snapshot = await pipeline.apis.prime.getSnapshot(pipeline.identity.sessionId);
        if (pipeline.lifecycle.signal.aborted) return;
        if (snapshot.generation === pipeline.generation
          && pipeline.revision !== null
          && snapshot.revision < pipeline.revision) {
          regressedSnapshots += 1;
          if (regressedSnapshots >= 3) {
            throw Object.assign(new Error('prime_live_snapshot_regressed'), {
              code: 'prime_live_snapshot_regressed',
            });
          }
          await waitForRetry(SNAPSHOT_REFRESH_DELAY_MS, pipeline.lifecycle.signal);
          continue;
        }
        if (!acceptSnapshot(pipeline, snapshot)) {
          throw Object.assign(new Error('prime_live_snapshot_regressed'), {
            code: 'prime_live_snapshot_regressed',
          });
        }
        return;
      } catch (error) {
        if (pipeline.lifecycle.signal.aborted || isAbortError(error)) return;
        pipeline.lastError = error;
        if (isPrimeActivationLost(error)) pipeline.terminal = true;
        else {
          pipeline.recoveryRequired = true;
          markStale(pipeline, issueFromError(error).code);
        }
        pipeline.connection?.abort();
        return;
      }
    }
  })();
  pipeline.snapshotRequest = request;
  void request.finally(() => {
    if (pipeline.snapshotRequest === request) pipeline.snapshotRequest = null;
  });
  return request;
};

const scheduleSnapshotCatchup = (pipeline: PrimeLivePipeline) => {
  if (pipeline.snapshotTimer || pipeline.snapshotRequest || pipeline.lifecycle.signal.aborted) return;
  pipeline.snapshotTimer = setTimeout(() => {
    pipeline.snapshotTimer = null;
    void requestSnapshotCatchup(pipeline);
  }, SNAPSHOT_REFRESH_DELAY_MS);
};

const handleStreamEvent = (
  pipeline: PrimeLivePipeline,
  event: PrimeLiveStreamEvent,
) => {
  if (pipeline.lifecycle.signal.aborted || pipeline.terminal) return;
  if (event.type === 'closed') {
    pipeline.terminal = true;
    pipeline.connection?.abort();
    return;
  }
  if (event.type === 'snapshot') {
    if (!acceptSnapshot(pipeline, event.snapshot)) {
      pipeline.recoveryRequired = true;
      markStale(pipeline, 'prime_live_snapshot_regressed');
      pipeline.connection?.abort();
    }
    return;
  }
  if (pipeline.generation === event.generation
    && pipeline.revision !== null
    && event.revision <= pipeline.revision) {
    return;
  }
  if (pipeline.generation !== event.generation
    || pipeline.revision === null
    || event.revision !== pipeline.revision + 1) {
    pipeline.recoveryRequired = true;
    markStale(pipeline, 'prime_live_event_gap');
    pipeline.connection?.abort();
    return;
  }
  pipeline.revision = event.revision;
  if (event.freshness.state === 'stale') {
    pipeline.recoveryRequired = true;
    markStale(pipeline, `prime_live_${event.freshness.reason}`);
    if (event.freshness.reason === 'deactivated') pipeline.terminal = true;
    pipeline.connection?.abort();
    return;
  }
  scheduleSnapshotCatchup(pipeline);
};

const recoverSnapshot = async (pipeline: PrimeLivePipeline): Promise<boolean> => {
  try {
    const snapshot = await pipeline.apis.prime.getSnapshot(pipeline.identity.sessionId);
    if (pipeline.lifecycle.signal.aborted) return false;
    if (!acceptSnapshot(pipeline, snapshot)) {
      throw Object.assign(new Error('prime_live_snapshot_regressed'), {
        code: 'prime_live_snapshot_regressed',
      });
    }
    pipeline.recoveryRequired = false;
    return true;
  } catch (error) {
    pipeline.lastError = error;
    if (!pipeline.lifecycle.signal.aborted && !isAbortError(error)) {
      if (isPrimeActivationLost(error)) pipeline.terminal = true;
      else markStale(pipeline, issueFromError(error).code);
    }
    return false;
  }
};

const runPipeline = async (pipeline: PrimeLivePipeline) => {
  let failures = 0;
  while (!pipeline.lifecycle.signal.aborted && !pipeline.terminal) {
    if (pipeline.recoveryRequired) {
      const recovered = await recoverSnapshot(pipeline);
      if (!recovered) {
        if (pipeline.terminal) break;
        failures += 1;
        await waitForRetry(retryDelay(failures, pipeline.lastError), pipeline.lifecycle.signal);
        continue;
      }
    }
    const connection = new AbortController();
    pipeline.connection = connection;
    const abortConnection = () => connection.abort();
    pipeline.lifecycle.signal.addEventListener('abort', abortConnection, { once: true });
    let receivedFreshSnapshot = false;
    updateLiveState(pipeline.identity, (previous) => ({
      ...previous,
      availability: previous.snapshot ? previous.availability : 'connecting',
    }));
    try {
      await pipeline.apis.prime.openEvents(pipeline.identity.sessionId, {
        signal: connection.signal,
        onEvent: (event) => {
          if (event.type === 'snapshot' && event.snapshot.freshness.state === 'fresh') {
            receivedFreshSnapshot = true;
          }
          handleStreamEvent(pipeline, event);
        },
      });
      if (!pipeline.lifecycle.signal.aborted && !pipeline.terminal) {
        pipeline.recoveryRequired = true;
        markStale(pipeline, 'prime_live_stream_closed');
      }
    } catch (error) {
      pipeline.lastError = error;
      if (!pipeline.lifecycle.signal.aborted && !pipeline.terminal && !isAbortError(error)) {
        if (isPrimeActivationLost(error)) pipeline.terminal = true;
        else {
          pipeline.recoveryRequired = true;
          markStale(pipeline, issueFromError(error).code);
        }
      }
    } finally {
      pipeline.lifecycle.signal.removeEventListener('abort', abortConnection);
      if (pipeline.connection === connection) pipeline.connection = null;
      connection.abort();
    }
    if (receivedFreshSnapshot) failures = 0;
    else failures += 1;
    if (!pipeline.lifecycle.signal.aborted && !pipeline.terminal) {
      await waitForRetry(retryDelay(failures, pipeline.lastError), pipeline.lifecycle.signal);
    }
  }
  if (pipeline.snapshotTimer) clearTimeout(pipeline.snapshotTimer);
  pipeline.snapshotTimer = null;
  pipeline.connection?.abort();
  pipeline.connection = null;
  if (pipeline.terminal && !pipeline.lifecycle.signal.aborted) {
    updateLiveState(pipeline.identity, (previous) => ({
      ...previous,
      desiredActive: false,
      availability: 'inactive',
    }));
    await resumePrimePassiveTranscript(pipeline.identity, pipeline.apis);
  }
};

const startPipeline = (identity: ChatIdentity, apis: RuntimeAPIs, snapshot: PrimeLiveSnapshot) => {
  const key = getPrimeLiveKey(identity);
  pipelines.get(key)?.lifecycle.abort();
  const pipeline: PrimeLivePipeline = {
    identity,
    apis,
    lifecycle: new AbortController(),
    connection: null,
    generation: snapshot.generation,
    revision: snapshot.revision,
    snapshotTimer: null,
    snapshotRequest: null,
    recoveryRequired: false,
    terminal: false,
    lastError: null,
  };
  pipelines.set(key, pipeline);
  const task = runPipeline(pipeline);
  void task.finally(() => {
    if (pipelines.get(key) === pipeline) pipelines.delete(key);
  });
};

const activateFromUserSelection = (identity: ChatIdentity, apis: RuntimeAPIs): Promise<void> => {
  const key = getPrimeLiveKey(identity);
  const existing = activationByKey.get(key);
  if (existing) {
    beginPrimeLiveTranscript(identity);
    updateLiveState(identity, (previous) => ({
      ...previous,
      desiredActive: true,
      availability: 'activating',
      issues: [],
    }));
    return existing;
  }
  const liveState = usePrimeLiveStore.getState().byKey.get(key);
  const pipeline = pipelines.get(key);
  if (liveState?.desiredActive
    && liveState.availability !== 'inactive'
    && liveState.availability !== 'unavailable'
    && liveState.availability !== 'deactivating'
    && pipeline
    && !pipeline.terminal
    && !pipeline.lifecycle.signal.aborted) {
    return Promise.resolve();
  }
  const request = (async () => {
    beginPrimeLiveTranscript(identity);
    updateLiveState(identity, (previous) => ({
      ...previous,
      desiredActive: true,
      availability: 'activating',
      issues: [],
    }));
    try {
      const response = await apis.prime.activate(identity.sessionId);
      if (response.sessionId !== identity.sessionId) {
        throw Object.assign(new Error('prime_response_session_mismatch'), {
          code: 'prime_response_session_mismatch',
        });
      }
      if (usePrimeLiveStore.getState().byKey.get(key)?.desiredActive !== true) return;
      commitPrimeLiveTranscript(identity, response.snapshot);
      updateLiveState(identity, (previous) => ({
        ...previous,
        desiredActive: true,
        availability: response.snapshot.freshness.state === 'fresh' ? 'live' : 'stale',
        snapshot: response.snapshot,
        issues: [],
      }));
      startPipeline(identity, apis, response.snapshot);
    } catch (error) {
      if (usePrimeLiveStore.getState().byKey.get(key)?.desiredActive !== true) return;
      const issue = issueFromError(error);
      updateLiveState(identity, (previous) => ({
        ...previous,
        desiredActive: false,
        availability: 'unavailable',
        issues: [issue],
      }));
      await resumePrimePassiveTranscript(identity, apis);
    }
  })();
  activationByKey.set(key, request);
  void request.finally(() => {
    if (activationByKey.get(key) === request) activationByKey.delete(key);
  });
  return request;
};

/**
 * Stop this tab's live work without deactivating the server runtime. Another
 * tab may still own the runtime, so selection changes must never POST a global
 * deactivation without a lease.
 */
export const suspendPrimeLiveSession = (identity: ChatIdentity) => {
  if (identity.harness !== 'prime') return;
  const key = getPrimeLiveKey(identity);
  const pipeline = pipelines.get(key);
  pipeline?.lifecycle.abort();
  pipeline?.connection?.abort();
  if (pipeline?.snapshotTimer) clearTimeout(pipeline.snapshotTimer);
  pipelines.delete(key);
  endPrimeLiveTranscript(identity);
  updateLiveState(identity, (previous) => ({
    ...previous,
    desiredActive: false,
    availability: 'inactive',
    issues: [],
  }));
};

export const suspendHiddenPrimeLiveSessions = (visibleIdentity: ChatIdentity | null) => {
  const candidates = new Map<string, ChatIdentity>();
  for (const state of usePrimeLiveStore.getState().byKey.values()) {
    if (state.desiredActive) candidates.set(state.key, state.identity);
  }
  for (const [key, pipeline] of pipelines) candidates.set(key, pipeline.identity);
  for (const identity of candidates.values()) {
    if (!chatIdentitiesEqual(identity, visibleIdentity)) suspendPrimeLiveSession(identity);
  }
};

/** Refreshes an already-authorized live pipeline without activating a session. */
export const catchUpPrimeLiveSession = (identity: ChatIdentity): Promise<void> => {
  if (identity.harness !== 'prime') return Promise.resolve();
  const pipeline = pipelines.get(getPrimeLiveKey(identity));
  return pipeline ? requestSnapshotCatchup(pipeline) : Promise.resolve();
};

export const activatePrimeSessionFromUserSelection = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  if (identity.harness !== 'prime') return Promise.resolve();
  return activateFromUserSelection(identity, apis);
};

export const deactivatePrimeLiveSession = async (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  if (identity.harness !== 'prime') return;
  const key = getPrimeLiveKey(identity);
  const pipeline = pipelines.get(key);
  pipeline?.lifecycle.abort();
  pipelines.delete(key);
  updateLiveState(identity, (previous) => ({
    ...previous,
    desiredActive: false,
    availability: 'deactivating',
  }));
  try {
    const response = await apis.prime.deactivate(identity.sessionId);
    if (response.snapshot) {
      // Keep the final bounded transcript until the passive refresh succeeds.
      beginPrimeLiveTranscript(identity);
      commitPrimeLiveTranscript(identity, response.snapshot);
    }
    updateLiveState(identity, (previous) => ({
      ...previous,
      desiredActive: false,
      availability: 'inactive',
      snapshot: response.snapshot ?? previous.snapshot,
      issues: [],
    }));
  } catch (error) {
    updateLiveState(identity, (previous) => ({
      ...previous,
      desiredActive: false,
      availability: 'unavailable',
      issues: [issueFromError(error)],
    }));
  }
  await resumePrimePassiveTranscript(identity, apis);
};

subscribeRuntimeEndpointWillChange(({ previousRuntimeKey }) => {
  for (const [key, pipeline] of pipelines) {
    if (pipeline.identity.runtimeKey !== previousRuntimeKey) continue;
    pipeline.lifecycle.abort();
    pipelines.delete(key);
    endPrimeLiveTranscript(pipeline.identity);
    updateLiveState(pipeline.identity, (previous) => ({
      ...previous,
      desiredActive: false,
      availability: 'stale',
      issues: [{ code: 'prime_live_runtime_changed', sessionId: pipeline.identity.sessionId }],
    }));
  }
});
