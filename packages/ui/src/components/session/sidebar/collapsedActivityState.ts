import type { CatalogSessionNode, SessionNode } from './types';

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
  node: CatalogSessionNode | SessionNode,
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  includeUnreadSubtasks: boolean,
  pendingQuestionSessionIds: Set<string>,
): CollapsedActivityState => {
  const isCatalogNode = 'controller' in node;
  const openCodeId = isCatalogNode ? node.controller.getOpenCodeSessionId() : node.session.id;
  if (openCodeId && pendingQuestionSessionIds.has(openCodeId)) return 'question';
  if ((openCodeId && activeSessionIds.has(openCodeId)) || isCatalogNode && node.session.activity === 'working') return 'active';

  let state: CollapsedActivityState = null;
  const isSubtask = isCatalogNode
    ? node.session.parentIdentity !== null
    : Boolean((node.session as typeof node.session & { parentID?: string | null }).parentID);
  if (openCodeId && unreadSessionIds.has(openCodeId) && (includeUnreadSubtasks || !isSubtask)) {
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
  nodes: Array<CatalogSessionNode | SessionNode>,
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
