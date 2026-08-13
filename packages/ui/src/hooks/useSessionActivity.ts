import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  useDirectorySync,
  useScopedBlockingPermissions,
  useScopedBlockingQuestions,
  useSessionMessages,
  useSessionParts,
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
  const trailingMessageID = messages[messages.length - 1]?.id ?? '';
  const trailingParts = useSessionParts(trailingMessageID, directory);
  const permissions = useScopedBlockingPermissions(sessionId ?? null, directory);
  const questions = useScopedBlockingQuestions(sessionId ?? null, directory);
  const inactiveStatusSnapshotAt = useDirectorySync(
    React.useCallback((state) => {
      if (
        !sessionId
        || !state.sessionStatusSnapshotActiveIds
      ) return undefined;
      return state.sessionStatusSnapshotActiveIds.has(sessionId)
        ? undefined
        : state.sessionStatusSnapshotAt;
    }, [sessionId]),
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
    const hasLocallyInterruptedTool = hasPendingAssistant && trailingParts.some((part) => {
      if (part.type !== 'tool') return false;
      const partState = (part as { state?: { status?: unknown; error?: unknown } }).state;
      return partState?.status === 'error' && partState.error === 'Interrupted';
    });
    const hasTerminalTool = hasPendingAssistant && trailingParts.some((part) => {
      if (part.type !== 'tool') return false;
      const partState = (part as { state?: { status?: unknown; error?: unknown } }).state;
      return typeof partState?.status === 'string'
        && partState.status !== 'pending'
        && partState.status !== 'running'
        && !(partState.status === 'error' && partState.error === 'Interrupted');
    });

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

    if (hasLocallyInterruptedTool) return INTERRUPTED_RESULT;
    if (!hasPendingAssistant) return IDLE_RESULT;

    const predatesAuthoritativeSnapshot = typeof inactiveStatusSnapshotAt === 'number'
      && (typeof lastMessageCreatedAt !== 'number' || lastMessageCreatedAt <= inactiveStatusSnapshotAt);
    if (predatesAuthoritativeSnapshot) return INTERRUPTED_RESULT;
    if (hasTerminalTool) return IDLE_RESULT;

    if (status !== undefined) return IDLE_RESULT;

    return {
      phase: 'busy',
      isWorking: true,
      isBusy: true,
      isCooldown: false,
      isInterrupted: false,
    };
  }, [sessionId, status, messages, trailingParts, permissions, questions, inactiveStatusSnapshotAt]);

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
