import { create } from 'zustand';

import { getPrimeCatalogDirectory } from '@/components/session/sidebar/primeSessionAdapter';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { ChatIdentity } from '@/lib/chat-identity';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { createPrimeChatIdentity } from '@/lib/prime/identity';
import {
  getPrimeCatalogSnapshot,
  refreshPrimeCatalog,
} from '@/stores/usePrimeCatalogStore';
import {
  getPrimeLiveKey,
  activatePrimeSessionFromUserSelection,
  usePrimeLiveStore,
} from '@/stores/usePrimeLiveStore';
import { initializePrimeDraftConfiguration } from '@/stores/usePrimeComposerStore';

type PrimeDraftSourceStore = {
  loadingDraftKeys: ReadonlySet<string>;
  missingSourceDraftKeys: ReadonlySet<string>;
  sourceByDraftKey: ReadonlyMap<string, ChatIdentity>;
};

const DRAFT_STATUS_LIMIT = 50;
const activationByDraft = new Map<string, Promise<void>>();

export const usePrimeDraftSourceStore = create<PrimeDraftSourceStore>()(() => ({
  loadingDraftKeys: new Set(),
  missingSourceDraftKeys: new Set(),
  sourceByDraftKey: new Map(),
}));

const updateDraftStatus = (
  draftKey: string,
  status: 'loading' | 'missing-source',
  enabled: boolean,
) => {
  usePrimeDraftSourceStore.setState((state) => {
    const key = status === 'loading' ? 'loadingDraftKeys' : 'missingSourceDraftKeys';
    const values = new Set(state[key]);
    if (enabled) {
      values.delete(draftKey);
      values.add(draftKey);
      while (values.size > DRAFT_STATUS_LIMIT) {
        const oldest = values.values().next().value;
        if (typeof oldest !== 'string') break;
        values.delete(oldest);
      }
    } else {
      values.delete(draftKey);
    }
    return { ...state, [key]: values };
  });
};

const setDraftSource = (draftKey: string, source: ChatIdentity | null) => {
  usePrimeDraftSourceStore.setState((state) => {
    const sourceByDraftKey = new Map(state.sourceByDraftKey);
    sourceByDraftKey.delete(draftKey);
    if (source) sourceByDraftKey.set(draftKey, source);
    while (sourceByDraftKey.size > DRAFT_STATUS_LIMIT) {
      const oldest = sourceByDraftKey.keys().next().value;
      if (typeof oldest !== 'string') break;
      sourceByDraftKey.delete(oldest);
    }
    return { ...state, sourceByDraftKey };
  });
};

export const loadPrimeDraftOptionsFromUserAction = (
  identity: ChatDraftIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  if (identity.harness !== 'prime' || identity.sessionId !== null) return Promise.resolve();
  const draftKey = getChatDraftIdentityKey(identity);
  const existing = activationByDraft.get(draftKey);
  if (existing) return existing;
  updateDraftStatus(draftKey, 'loading', true);
  updateDraftStatus(draftKey, 'missing-source', false);
  const request = (async () => {
    await refreshPrimeCatalog(identity.runtimeKey, apis);
    const catalog = getPrimeCatalogSnapshot(identity.runtimeKey);
    if (catalog.availability !== 'ready') return;
    const candidates = catalog.records
      .filter((record) => record.availability === 'ready')
      .map((record) => {
        const sourceIdentity = createPrimeChatIdentity(identity.runtimeKey, record.sessionId);
        return {
          identity: sourceIdentity,
          inDraftDirectory: getPrimeCatalogDirectory(sourceIdentity) === identity.directory,
          updatedAt: record.updatedAt ?? record.createdAt ?? 0,
          createdAt: record.createdAt ?? 0,
        };
      })
      .sort((left, right) => (
        Number(right.inDraftDirectory) - Number(left.inDraftDirectory)
        || right.updatedAt - left.updatedAt
        || right.createdAt - left.createdAt
        || left.identity.sessionId.localeCompare(right.identity.sessionId)
      ));
    const source = candidates[0]?.identity;
    if (!source) {
      if (catalog.complete) {
        setDraftSource(draftKey, null);
        updateDraftStatus(draftKey, 'missing-source', true);
      }
      return;
    }
    setDraftSource(draftKey, source);
    await activatePrimeSessionFromUserSelection(source, apis);
    const live = usePrimeLiveStore.getState().byKey.get(getPrimeLiveKey(source));
    const snapshot = live?.snapshot;
    if (live?.desiredActive === true
      && live.availability === 'live'
      && snapshot?.sessionId === source.sessionId
      && snapshot.freshness.state === 'fresh') {
      initializePrimeDraftConfiguration(identity, snapshot);
    }
  })();
  activationByDraft.set(draftKey, request);
  void request.finally(() => {
    if (activationByDraft.get(draftKey) === request) activationByDraft.delete(draftKey);
    updateDraftStatus(draftKey, 'loading', false);
  });
  return request;
};
