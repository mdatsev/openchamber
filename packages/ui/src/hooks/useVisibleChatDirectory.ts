import { getPrimeCatalogDirectory } from '@/components/session/sidebar/primeSessionAdapter';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizePath } from '@/lib/pathNormalization';
import { useChatSelectionStore } from '@/stores/useChatSelectionStore';
import { usePrimeCatalogRecord } from '@/stores/usePrimeCatalogStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Resolves a directory-scoped panel against the harness-neutral visible chat.
 * Prime placement remains adapter-private and never falls back to a stale
 * OpenCode selection when the catalog has no validated directory.
 */
export const useVisibleChatDirectory = () => {
  const visibleChatIdentity = useChatSelectionStore((state) => state.visibleChatIdentity);
  const openCodeDirectory = useEffectiveDirectory();
  const primeCatalogRecord = usePrimeCatalogRecord(visibleChatIdentity);
  const primeDraftDirectory = useSessionUIStore((state) => (
    state.newSessionDraft.open && state.newSessionDraft.harness === 'prime'
      ? normalizePath(
          state.newSessionDraft.bootstrapPendingDirectory
          ?? state.newSessionDraft.directoryOverride,
        )
      : null
  ));
  const primeDraftOpen = useSessionUIStore((state) => (
    state.newSessionDraft.open && state.newSessionDraft.harness === 'prime'
  ));

  if (primeDraftOpen) return primeDraftDirectory ?? undefined;
  if (visibleChatIdentity?.harness !== 'prime') {
    return openCodeDirectory;
  }
  if (!primeCatalogRecord) {
    return undefined;
  }
  return getPrimeCatalogDirectory(visibleChatIdentity);
};

/**
 * Keeps SDK-backed session and draft state out of harness-neutral surfaces.
 * Prime views may share directory-backed tools, but they never borrow the
 * previously selected OpenCode session as semantic context.
 */
export const useVisibleOpenCodeSessionContext = () => {
  const visibleChatHarness = useChatSelectionStore(
    (state) => state.visibleChatIdentity?.harness ?? null,
  );
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const primeDraftOpen = newSessionDraft.open && newSessionDraft.harness === 'prime';

  if (visibleChatHarness === 'prime' || primeDraftOpen) {
    return { isOpenCode: false, sessionId: null, newSessionDraft: null };
  }
  return { isOpenCode: true, sessionId, newSessionDraft };
};
