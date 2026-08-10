import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  useDirectorySync,
  useScopedBlockingPermissions,
  useScopedBlockingQuestions,
  useSessionMessages,
  useSessionStatus,
} from '@/sync/sync-context';
import { setGlobalSessionInterrupted } from '@/sync/global-session-status';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
  isInterrupted: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
  isInterrupted: false,
};

const INTERRUPTED_RESULT: SessionActivityResult = {
  ...IDLE_RESULT,
  isInterrupted: true,
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useScopedBlockingPermissions(sessionId ?? null, directory);
  const questions = useScopedBlockingQuestions(sessionId ?? null, directory);
  const statusSnapshotAt = useDirectorySync(
    React.useCallback((state) => state.sessionStatusSnapshotAt, []),
    directory,
  );

  const activity = React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    // Permissions or questions pending → idle (the blocking indicator takes
    // priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle.
    const lastMessage = messages[messages.length - 1];
    const hasPendingAssistant = Boolean(
      lastMessage
      && lastMessage.role === 'assistant'
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
    );
    const lastMessageCreatedAt = (lastMessage as { time?: { created?: number } } | undefined)?.time?.created;

    const statusWorking = status !== undefined && phase !== 'idle';
    if (statusWorking) {
      return {
        phase,
        isWorking: true,
        isBusy: phase === 'busy',
        isCooldown: false,
        isInterrupted: false,
      };
    }

    if (status !== undefined) return IDLE_RESULT;

    if (!hasPendingAssistant) return IDLE_RESULT;

    const predatesAuthoritativeSnapshot = typeof statusSnapshotAt === 'number'
      && (typeof lastMessageCreatedAt !== 'number' || lastMessageCreatedAt <= statusSnapshotAt);
    if (predatesAuthoritativeSnapshot) return INTERRUPTED_RESULT;

    return {
      phase: 'busy',
      isWorking: true,
      isBusy: true,
      isCooldown: false,
      isInterrupted: false,
    };
  }, [sessionId, status, messages, permissions, questions, statusSnapshotAt]);

  React.useEffect(() => {
    if (!sessionId) return;
    setGlobalSessionInterrupted(sessionId, activity.isInterrupted);
  }, [activity.isInterrupted, sessionId]);

  return activity;
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
