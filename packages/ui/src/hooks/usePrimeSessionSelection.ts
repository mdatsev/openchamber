import React from 'react';

import type { RuntimeAPIs } from '@/lib/api/types';
import type { ChatIdentity } from '@/lib/chat-identity';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { activatePrimeSessionFromUserSelection } from '@/stores/usePrimeLiveStore';
import { selectChatIdentity } from '@/sync/session-navigation';

export const selectPrimeSessionFromUser = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  if (identity.harness !== 'prime') return Promise.resolve();
  selectChatIdentity(identity);
  return activatePrimeSessionFromUserSelection(identity, apis);
};

/**
 * The Prime identity-selection activation edge. Call this from a direct user
 * selection handler or after an explicitly submitted creation is accepted.
 * Read-only reconnect and draft option loading have separate direct-user edges;
 * none may run from render, routing, passive loads, or reconnect effects.
 */
export const usePrimeSessionSelection = () => {
  const apis = useRuntimeAPIs();
  return React.useCallback((identity: ChatIdentity) => (
    selectPrimeSessionFromUser(identity, apis)
  ), [apis]);
};
