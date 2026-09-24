import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { GitWorktreeComparison } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getSessionGoal, type SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { useIsSessionWorktreeMovePending } from '@/lib/worktrees/sessionWorktreeMove';
import { useGitStore, useResolvedWorktreeComparisonSummary } from '@/stores/useGitStore';
import { getGitHubPrStatusKey, type PrVisualSummary, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import {
  useGlobalSessionInterrupted,
  useGlobalSessionStatus,
  useSessionPermissionCount,
  useSessionQuestionCount,
} from '@/sync/sync-context';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import type { SessionNode } from './types';
import { normalizePath } from './utils';
import { selectQuestionBadgeSessionScopes } from './sessions/sessionNodeItemUtils';

export type SessionLeadingIndicator = 'moving' | 'question' | 'active' | 'interrupted' | 'unread' | 'pinned' | null;

export type SessionRowIndicatorModel = {
  leading: SessionLeadingIndicator;
  isStreaming: boolean;
  showActivityDuration: boolean;
  unseenCount: number;
  pendingPermissionCount: number;
  pendingQuestionCount: number;
  hasPersistentError: boolean;
  goal: SessionGoalPayload | null;
  worktreeDirectory: string | null;
  worktreeComparison: GitWorktreeComparison | null;
  worktreeUpstreamAhead: number | null;
  rootUpstreamAhead: number | null;
  rootDirectory: string | null;
  rootIsClean: boolean | null;
  prSummary: PrVisualSummary | null;
  prStatusLabel: string | null;
};

export function useSessionRowIndicatorModel({
  node,
  directory,
  active,
  pinned,
  includeDescendants,
  includeUnreadSubtasks,
  projectRootDirectory,
  branch,
}: {
  node: SessionNode;
  directory: string | null;
  active: boolean;
  pinned: boolean;
  includeDescendants: boolean;
  includeUnreadSubtasks: boolean;
  projectRootDirectory: string | null;
  branch: string | null;
}): SessionRowIndicatorModel {
  const { t } = useI18n();
  const session = node.session;
  const status = useGlobalSessionStatus(session.id);
  const interrupted = useGlobalSessionInterrupted(session.id);
  const moving = useIsSessionWorktreeMovePending(session.id);
  const scopes = React.useMemo(
    () => selectQuestionBadgeSessionScopes(node, !includeDescendants, directory),
    [directory, includeDescendants, node],
  );
  const pendingQuestionCount = useSessionQuestionCount(scopes, includeDescendants);
  const pendingPermissionCount = useSessionPermissionCount(scopes, includeDescendants);
  const statusType = status?.type ?? 'idle';
  const isStreaming = pendingQuestionCount === 0 && (statusType === 'busy' || statusType === 'retry');
  const unseenCount = useSessionUnseenCount(directory, session.id);
  const isSubtask = Boolean((session as Session & { parentID?: string | null }).parentID);
  const showUnread = !moving
    && !isStreaming
    && pendingQuestionCount === 0
    && !interrupted
    && unseenCount > 0
    && (!isSubtask || includeUnreadSubtasks)
    && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const hasPersistentError = useViewportStore(
    React.useCallback(
      (state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie),
      [session.id],
    ),
  );
  const worktreeDirectory = normalizePath(node.worktree?.path ?? null);
  const worktreeComparison = useResolvedWorktreeComparisonSummary(worktreeDirectory);
  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectRoot = normalizePath(projectRootDirectory);
  const candidateRootDirectory = !worktreeDirectory && normalizedDirectory && normalizedDirectory === normalizedProjectRoot
    ? normalizedDirectory
    : null;
  const upstreamAhead = useGitStore((state) => {
    const statusDirectory = worktreeDirectory ?? candidateRootDirectory;
    return statusDirectory
      ? state.directories.get(statusDirectory)?.status?.ahead ?? null
      : null;
  });
  const rootIsClean = useGitStore((state) => {
    if (!candidateRootDirectory) return null;
    const directoryState = state.directories.get(candidateRootDirectory);
    if (directoryState?.isGitRepo !== true || directoryState.status?.isClean === undefined) return null;
    return directoryState.status.isClean;
  });
  const rootDirectory = rootIsClean === null ? null : candidateRootDirectory;
  const prLookupKey = React.useMemo(() => {
    const normalizedBranch = branch?.trim();
    return worktreeDirectory && normalizedBranch
      ? getGitHubPrStatusKey(worktreeDirectory, normalizedBranch)
      : null;
  }, [branch, worktreeDirectory]);
  const prSummary = usePrVisualSummary(prLookupKey);
  const prStatusLabel = React.useMemo(() => {
    if (!prSummary) return null;
    switch (prSummary.visualState) {
      case 'merged':
        return t('sessions.sidebar.group.pr.status.merged');
      case 'open':
        return (prSummary.canMerge === true || prSummary.mergeableState === 'clean' || prSummary.checks?.state === 'success')
          ? t('sessions.sidebar.group.pr.status.readyToMerge')
          : t('sessions.sidebar.group.pr.status.open');
      case 'blocked':
        return prSummary.mergeableState === 'dirty'
          ? t('sessions.sidebar.group.pr.status.mergeConflicts')
          : t('sessions.sidebar.group.pr.status.mergeBlocked');
      case 'draft':
        return t('sessions.sidebar.group.pr.status.draft');
      case 'closed':
        return t('sessions.sidebar.group.pr.status.closed');
      default:
        return null;
    }
  }, [prSummary, t]);

  let leading: SessionLeadingIndicator = null;
  if (moving) leading = 'moving';
  else if (pendingQuestionCount > 0) leading = 'question';
  else if (isStreaming) leading = 'active';
  else if (interrupted) leading = 'interrupted';
  else if (showUnread) leading = 'unread';
  else if (pinned) leading = 'pinned';

  return {
    leading,
    isStreaming,
    showActivityDuration: (isStreaming || showUnread) && hasActivityDuration,
    unseenCount,
    pendingPermissionCount,
    pendingQuestionCount,
    hasPersistentError,
    goal: getSessionGoal(session),
    worktreeDirectory,
    worktreeComparison,
    worktreeUpstreamAhead: worktreeDirectory ? upstreamAhead : null,
    rootUpstreamAhead: candidateRootDirectory ? upstreamAhead : null,
    rootDirectory,
    rootIsClean,
    prSummary,
    prStatusLabel,
  };
}
