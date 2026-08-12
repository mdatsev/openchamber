import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { getGitStatus } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';
import { createQuickWorktree, resolveProjectRef } from '@/lib/worktreeSessionCreator';
import {
  getLatestWorktreeMetadata,
  removeProjectWorktree,
  validateWorktreeCreate,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { moveSessionToDirectory } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getDirectoryState } from '@/sync/sync-refs';
import type { WorktreeMetadata } from '@/types/worktree';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import { create } from 'zustand';

type SessionTreeWorktreeMoveInput = {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  successMessage: string;
  failureMessage: string;
  onSuccess?: (worktreePath: string) => void;
};

type SessionWorktreeMoveTarget = {
  branchName: string;
  worktreeName: string;
};

type SessionWorktreeMoveRequest = {
  input: SessionTreeWorktreeMoveInput;
  project: ProjectRef;
  target: SessionWorktreeMoveTarget;
};

type SessionWorktreeMoveState = {
  pendingSessionIds: Set<string>;
  confirmationQueue: SessionWorktreeMoveRequest[];
};

const useSessionMoveState = create<SessionWorktreeMoveState>(() => ({
  pendingSessionIds: new Set(),
  confirmationQueue: [],
}));

export const useIsSessionWorktreeMovePending = (sessionId: string): boolean =>
  useSessionMoveState((state) => state.pendingSessionIds.has(sessionId));

export const useSessionWorktreeMoveConfirmation = (): SessionWorktreeMoveTarget | null =>
  useSessionMoveState((state) => state.confirmationQueue[0]?.target ?? null);

export const normalizeSessionWorktreeBranchName = (value: string): string =>
  value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');

export const normalizeSessionWorktreeName = (value: string): string =>
  value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const normalizeSessionWorktreeMoveTarget = (
  target: SessionWorktreeMoveTarget,
): SessionWorktreeMoveTarget => ({
  branchName: normalizeSessionWorktreeBranchName(target.branchName),
  worktreeName: normalizeSessionWorktreeName(target.worktreeName),
});

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const setSessionMovePending = (sessionId: string, pending: boolean): void => {
  useSessionMoveState.setState((state) => {
    if (state.pendingSessionIds.has(sessionId) === pending) return state;
    const pendingSessionIds = new Set(state.pendingSessionIds);
    if (pending) pendingSessionIds.add(sessionId);
    else pendingSessionIds.delete(sessionId);
    return { pendingSessionIds };
  });
};

const resolveSourceBranch = async (directory: string, projectDirectory: string): Promise<string> => {
  try {
    const status = await getGitStatus(directory, { mode: 'light' });
    const currentBranch = status.current?.trim();
    if (currentBranch) return currentBranch;
  } catch {
    // Fall back to discovered worktree metadata below.
  }

  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectDirectory = normalizePath(projectDirectory) ?? projectDirectory;
  const worktrees = useSessionUIStore.getState().availableWorktreesByProject;
  const metadata = (worktrees.get(normalizedProjectDirectory) ?? worktrees.get(projectDirectory) ?? [])
    .find((worktree) => normalizePath(worktree.path) === normalizedDirectory);
  const mappedBranch = metadata?.branch?.trim();
  if (mappedBranch) return mappedBranch;

  throw new Error('Unable to determine the current branch');
};

const assertSessionsIdle = (sessions: Session[], sourceDirectory: string): void => {
  const directoryState = getDirectoryState(sourceDirectory);
  if (!directoryState) throw new Error('Session status is unavailable');

  const statuses = directoryState.session_status;
  const hasActiveSession = sessions.some((session) => {
    const status = statuses[session.id]?.type;
    return status === 'busy' || status === 'retry';
  });
  if (hasActiveSession) throw new Error('Session is not idle');
};

const rollbackMovedSessions = async (
  sessions: Session[],
  rootSessionId: string,
  sourceDirectory: string,
  worktreeDirectory: string,
  moveChanges: boolean,
  previousMetadata: ReadonlyMap<string, WorktreeMetadata | undefined>,
): Promise<unknown[]> => {
  const failures: unknown[] = [];
  for (const session of [...sessions].reverse()) {
    try {
      await moveSessionToDirectory(
        session,
        worktreeDirectory,
        sourceDirectory,
        moveChanges && session.id === rootSessionId,
      );
      useSessionUIStore.getState().setWorktreeMetadata(session.id, previousMetadata.get(session.id) ?? null);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

const removeFailedWorktree = async (
  project: ProjectRef,
  worktree: WorktreeMetadata,
  moveError: unknown,
): Promise<never> => {
  try {
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: true });
  } catch {
    throw new Error(`Session move failed and the new worktree could not be removed: ${getErrorMessage(moveError)}`);
  }
  throw moveError;
};

const moveSessionTreeToQuickWorktree = async (
  input: {
    root: Session;
    descendants: Session[];
    sourceDirectory: string;
  },
  moveChanges: boolean,
  target?: SessionWorktreeMoveTarget,
): Promise<string> => {
  try {
    const project = resolveProjectRef(input.sourceDirectory);
    if (!project) throw new Error('Unable to find the project for this session');

    const sessions = [input.root, ...input.descendants];
    const previousMetadata = new Map(
      sessions.map((session) => [
        session.id,
        useSessionUIStore.getState().getWorktreeMetadata(session.id),
      ]),
    );
    assertSessionsIdle(sessions, input.sourceDirectory);

    const sourceBranch = await resolveSourceBranch(input.sourceDirectory, project.path);
    const worktreeOptions = target
      ? { startRef: sourceBranch, ...normalizeSessionWorktreeMoveTarget(target) }
      : { startRef: sourceBranch };
    const worktree = await createQuickWorktree(project, worktreeOptions);

    const moved: Session[] = [];
    try {
      await waitForWorktreeGitReady(worktree.path);
      // Branch/status discovery and worktree creation can take long enough for a
      // session to start running, so verify the whole tree again before moving.
      assertSessionsIdle(sessions, input.sourceDirectory);
      for (const [index, session] of sessions.entries()) {
        // If chosen, transfer checkout changes once with the root. Descendants
        // only need their execution location updated.
        await moveSessionToDirectory(session, input.sourceDirectory, worktree.path, moveChanges && index === 0);
        moved.push(session);
        useSessionUIStore.getState().setWorktreeMetadata(session.id, getLatestWorktreeMetadata(worktree));
      }
    } catch (error) {
      const rollbackFailures = await rollbackMovedSessions(
        moved,
        input.root.id,
        input.sourceDirectory,
        worktree.path,
        moveChanges,
        previousMetadata,
      );
      if (rollbackFailures.length > 0) {
        throw new Error(`Session move partially failed and could not be fully rolled back: ${getErrorMessage(error)}`);
      }
      return removeFailedWorktree(project, worktree, error);
    }

    try {
      await refreshGlobalSessionsForDirectories([input.sourceDirectory, worktree.path]);
    } catch (error) {
      // Direct action updates already reconciled both stores. Keep the move
      // successful if this best-effort authoritative refresh is unavailable.
      console.warn('[session-worktree-move] Failed to refresh moved sessions', error);
    }
    return worktree.path;
  } finally {
    setSessionMovePending(input.root.id, false);
  }
};

const executeSessionTreeWorktreeMove = (
  input: SessionTreeWorktreeMoveInput,
  moveChanges: boolean,
  target?: SessionWorktreeMoveTarget,
): void => {
  void moveSessionTreeToQuickWorktree(input, moveChanges, target)
    .then(
      (worktreePath) => {
        toast.success(input.successMessage);
        input.onSuccess?.(worktreePath);
      },
      (error) => toast.error(input.failureMessage, {
        description: getErrorMessage(error),
      }),
    );
};

export const startSessionTreeWorktreeMove = (input: SessionTreeWorktreeMoveInput): void => {
  if (useSessionMoveState.getState().pendingSessionIds.has(input.root.id)) return;
  setSessionMovePending(input.root.id, true);

  void (async () => {
    try {
      const status = await getGitStatus(input.sourceDirectory, { mode: 'light' });
      if (status.isClean) {
        executeSessionTreeWorktreeMove(input, false);
        return;
      }
      const project = resolveProjectRef(input.sourceDirectory);
      if (!project) throw new Error('Unable to find the project for this session');
      const generatedName = generateBranchName();
      const request: SessionWorktreeMoveRequest = {
        input,
        project,
        target: { branchName: generatedName, worktreeName: generatedName },
      };
      useSessionMoveState.setState((state) => ({
        confirmationQueue: [...state.confirmationQueue, request],
      }));
    } catch (error) {
      setSessionMovePending(input.root.id, false);
      toast.error(input.failureMessage, {
        description: getErrorMessage(error),
      });
    }
  })();
};

export const validateSessionWorktreeMoveTarget = async (target: SessionWorktreeMoveTarget) => {
  const request = useSessionMoveState.getState().confirmationQueue[0];
  if (!request) throw new Error('Session worktree move confirmation is unavailable');

  const normalizedTarget = normalizeSessionWorktreeMoveTarget(target);
  const sourceBranch = await resolveSourceBranch(request.input.sourceDirectory, request.project.path);
  return validateWorktreeCreate(request.project, {
    mode: 'new',
    ...normalizedTarget,
    startRef: sourceBranch,
  });
};

export const resolveSessionWorktreeMoveConfirmation = (
  choice: { moveChanges: boolean; target: SessionWorktreeMoveTarget } | null,
): void => {
  const request = useSessionMoveState.getState().confirmationQueue[0];
  if (!request) return;

  useSessionMoveState.setState((state) => ({
    confirmationQueue: state.confirmationQueue.slice(1),
  }));
  if (choice === null) {
    setSessionMovePending(request.input.root.id, false);
    return;
  }
  executeSessionTreeWorktreeMove(request.input, choice.moveChanges, choice.target);
};
