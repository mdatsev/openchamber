import { getRuntimeUrlResolver } from './runtime-url';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';

type RuntimeNotificationListener = (payload: unknown) => void;

const listeners = new Set<RuntimeNotificationListener>();
let source: EventSource | null = null;

const connect = () => {
  if (source || listeners.size === 0 || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  source = new EventSource(getRuntimeUrlResolver().sse('/api/notifications/stream'));
  source.onmessage = (event) => {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    for (const listener of listeners) listener(payload);
  };
};

const resetRuntimeNotificationStream = () => {
  source?.close();
  source = null;
  connect();
};

export const subscribeRuntimeNotificationStream = (listener: RuntimeNotificationListener) => {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
};

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(resetRuntimeNotificationStream);
}
