import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from './types';

export type CollapsedActivityState = 'question' | 'active' | 'unread' | null;

const EMPTY_SESSION_IDS = new Set<string>();

export const mergeCollapsedActivityStates = (
  current: CollapsedActivityState,
  next: CollapsedActivityState,
): CollapsedActivityState => {
  if (current === 'question' || next === 'question') return 'question';
  if (current === 'active' || next === 'active') return 'active';
  if (current === 'unread' || next === 'unread') return 'unread';
  return null;
};

const getSessionNodeActivityState = (
  node: SessionNode,
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  includeUnreadSubtasks: boolean,
  pendingQuestionSessionIds: Set<string>,
): CollapsedActivityState => {
  if (pendingQuestionSessionIds.has(node.session.id)) {
    return 'question';
  }

  if (activeSessionIds.has(node.session.id)) {
    return 'active';
  }

  let state: CollapsedActivityState = null;
  const isSubtask = Boolean((node.session as Session & { parentID?: string | null }).parentID);
  if (unreadSessionIds.has(node.session.id) && (includeUnreadSubtasks || !isSubtask)) {
    state = 'unread';
  }

  for (const child of node.children) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(child, activeSessionIds, unreadSessionIds, includeUnreadSubtasks, pendingQuestionSessionIds),
    );
    if (state === 'question') return state;
  }

  return state;
};

export const getSessionNodesActivityState = (
  nodes: SessionNode[],
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  includeUnreadSubtasks: boolean,
  pendingQuestionSessionIds: Set<string> = EMPTY_SESSION_IDS,
): CollapsedActivityState => {
  let state: CollapsedActivityState = null;
  for (const node of nodes) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(node, activeSessionIds, unreadSessionIds, includeUnreadSubtasks, pendingQuestionSessionIds),
    );
    if (state === 'question') return state;
  }
  return state;
};
