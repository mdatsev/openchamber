import type { PrimeRuntimeStatus } from './api/types';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

type SessionCreatedEvent = {
  type: 'session-created';
  sessionId: string;
  directory: string;
  projectId?: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
};

type PrimeRuntimeChangedEvent = {
  type: 'prime-runtime-changed';
  status: PrimeRuntimeStatus;
};

type PrimeSessionChangedEvent = {
  type: 'prime-session-changed';
  sessionID: string;
  activity: 'working' | 'idle';
  catalogChanged: boolean;
};

type EventStreamReadyEvent = {
  type: 'event-stream-ready';
};

export type OpenChamberEvent = ScheduledTaskRanEvent | SessionCreatedEvent | PrimeRuntimeChangedEvent | PrimeSessionChangedEvent | EventStreamReadyEvent;
type Listener = (event: OpenChamberEvent) => void;

let streamController: AbortController | null = null;
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();

const emitOpenChamberEvent = (event: OpenChamberEvent) => {
  for (const listener of listeners) listener(event);
};

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupSource = () => {
  clearHeartbeatTimer();
  streamController?.abort();
  streamController = null;
  eventSource?.close();
  eventSource = null;
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) {
    return;
  }
  heartbeatTimer = setTimeout(() => {
    cleanupSource();
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const parseEnvelope = (raw: string): { type: string; properties: unknown } | null => {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const type = typeof parsed?.type === 'string' ? parsed.type : '';
    const properties = parsed?.properties;
    if (!type) {
      return null;
    }
    return { type, properties };
  } catch {
    return null;
  }
};

const getEventProperties = (properties: unknown): Record<string, unknown> | null => {
  if (!properties || typeof properties !== 'object') {
    return null;
  }
  return properties as Record<string, unknown>;
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  if (envelope.type === 'openchamber:event-stream-ready') {
    reconnectAttempt = 0;
    for (const listener of listeners) listener({ type: 'event-stream-ready' });
    return;
  }

  if (envelope.type === 'openchamber:heartbeat') {
    return;
  }

  if (envelope.type === 'openchamber:prime-runtime-changed') {
    const properties = getEventProperties(envelope.properties);
    const status = properties?.status;
    if (!status || typeof status !== 'object') return;
    const candidate = status as Record<string, unknown>;
    const state = candidate.state;
    if (
      candidate.schemaVersion !== 1
      || (state !== 'starting' && state !== 'ready' && state !== 'not-configured' && state !== 'unavailable' && state !== 'incompatible' && state !== 'unsupported')
    ) return;
    const nextEvent: PrimeRuntimeChangedEvent = {
      type: 'prime-runtime-changed',
      status: {
        schemaVersion: 1,
        state,
        interactive: candidate.interactive === true,
        authentication: candidate.authentication === 'authenticated' || candidate.authentication === 'unauthenticated'
          ? candidate.authentication
          : 'unknown',
        binarySource: candidate.binarySource === 'settings' || candidate.binarySource === 'environment' || candidate.binarySource === 'path'
          ? candidate.binarySource
          : null,
        version: typeof candidate.version === 'string' ? candidate.version : null,
        message: typeof candidate.message === 'string' ? candidate.message : null,
      },
    };
    emitOpenChamberEvent(nextEvent);
    return;
  }

  if (envelope.type === 'openchamber:prime-session-changed') {
    const properties = getEventProperties(envelope.properties);
    const sessionID = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    if (!sessionID) return;
    const nextEvent: PrimeSessionChangedEvent = {
      type: 'prime-session-changed',
      sessionID,
      activity: properties?.activity === 'working' ? 'working' : 'idle',
      catalogChanged: properties?.catalogChanged === true,
    };
    emitOpenChamberEvent(nextEvent);
    return;
  }

  if (envelope.type === 'openchamber:session-created') {
    const properties = getEventProperties(envelope.properties);
    const sessionId = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    const directory = typeof properties?.directory === 'string' ? properties.directory : '';
    if (!sessionId || !directory) {
      return;
    }

    const nextEvent: SessionCreatedEvent = {
      type: 'session-created',
      sessionId,
      directory,
      createdAt: typeof properties?.createdAt === 'number' ? properties.createdAt : Date.now(),
      promptDispatched: properties?.promptDispatched === true,
      dispatchedAsCommand: properties?.dispatchedAsCommand === true,
      ...(typeof properties?.projectId === 'string' && properties.projectId.length > 0
        ? { projectId: properties.projectId }
        : {}),
    };
    emitOpenChamberEvent(nextEvent);
    return;
  }

  if (envelope.type !== 'openchamber:scheduled-task-ran') {
    return;
  }

  const properties = getEventProperties(envelope.properties);
  const projectId = typeof properties?.projectId === 'string' ? properties.projectId : '';
  const taskId = typeof properties?.taskId === 'string' ? properties.taskId : '';
  const ranAt = typeof properties?.ranAt === 'number' ? properties.ranAt : Date.now();
  const rawStatus = properties?.status;
  const status = rawStatus === 'running' || rawStatus === 'error' ? rawStatus : 'success';
  if (!projectId || !taskId) {
    return;
  }

  const nextEvent: ScheduledTaskRanEvent = {
    type: 'scheduled-task-ran',
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof properties?.sessionId === 'string' && properties.sessionId.length > 0
      ? { sessionId: properties.sessionId }
      : {}),
  };
  emitOpenChamberEvent(nextEvent);
};

const connect = () => {
  if (typeof window === 'undefined' || listeners.size === 0) {
    return;
  }
  if (streamController || (eventSource && eventSource.readyState !== EventSource.CLOSED)) return;

  cleanupSource();
  const eventUrl = getRuntimeUrlResolver().sse('/api/openchamber/events');
  if (typeof EventSource === 'function' && /^https?:\/\//i.test(eventUrl)) {
    const source = new EventSource(eventUrl);
    source.onopen = () => resetHeartbeatTimer();
    source.onmessage = (event) => {
      resetHeartbeatTimer();
      const envelope = parseEnvelope(event.data);
      if (envelope) dispatchFromEnvelope(envelope);
    };
    source.onerror = () => {
      cleanupSource();
      scheduleReconnect();
    };
    eventSource = source;
    return;
  }

  const controller = new AbortController();
  streamController = controller;
  void (async () => {
    try {
      const response = await runtimeFetch('/api/openchamber/events', {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`OpenChamber event stream returned ${response.status}`);
      resetHeartbeatTimer();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 1_000_000) throw new Error('OpenChamber event stream buffer exceeded its limit');
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const raw = block.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          resetHeartbeatTimer();
          const envelope = parseEnvelope(raw);
          if (envelope) dispatchFromEnvelope(envelope);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.warn('[openchamber-events] stream disconnected', error);
    } finally {
      if (streamController === controller) {
        streamController = null;
        clearHeartbeatTimer();
        scheduleReconnect();
      }
    }
  })();
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || typeof window === 'undefined') return;
  runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
    cleanupSource();
    reconnectAttempt = 0;
    connect();
  });
};

const cleanupRuntimeChangeSubscription = () => {
  runtimeChangeUnsubscribe?.();
  runtimeChangeUnsubscribe = null;
};

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupSource();
      cleanupRuntimeChangeSubscription();
    }
  };
};
