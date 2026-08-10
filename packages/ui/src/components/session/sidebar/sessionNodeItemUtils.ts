import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import type { CatalogSessionNode, SessionNode } from './types';
import { getOpenCodeSourceSession } from './openCodeSessionAdapter';

type AnySessionNode = CatalogSessionNode | SessionNode;

export type SessionNodeChildRenderExtras = {
  subtreeContainsEditing: Set<string>;
  menuOpenSessionId: string | null;
  nodeStructureKey: string;
};

export type SessionNodeRenderExtras<TNode = CatalogSessionNode> = SessionNodeChildRenderExtras & {
  childRenderExtrasFor?: (child: TNode) => SessionNodeChildRenderExtras;
};

const isCatalogNode = (node: AnySessionNode): node is CatalogSessionNode => 'controller' in node;
const getOpenCodeId = (node: AnySessionNode) => (
  isCatalogNode(node) ? node.controller.getOpenCodeSessionId() : node.session.id
);
const getParentId = (node: AnySessionNode) => (
  isCatalogNode(node)
    ? node.session.parentIdentity?.sessionId ?? null
    : (node.session as typeof node.session & { parentID?: string | null }).parentID ?? null
);
const getNodeDirectory = (node: AnySessionNode, fallback?: string | null) => {
  const session = isCatalogNode(node) ? getOpenCodeSourceSession(node.session) : node.session;
  return (session as typeof session & { directory?: string | null }).directory ?? fallback ?? '';
};
const getNodeRuntimeKey = (node: AnySessionNode) => (
  isCatalogNode(node) ? node.session.identity.runtimeKey : getRuntimeKey()
);
const getNodeStructureId = (node: AnySessionNode) => (
  isCatalogNode(node)
    ? `${node.session.identity.runtimeKey}:${node.session.identity.harness}:${node.session.identity.sessionId}`
    : node.session.id
);

export const collectSubtreeContainingId = (
  nodes: AnySessionNode[],
  targetId: string | null,
  result: Set<string>,
): void => {
  if (!targetId) return;
  const visit = (node: AnySessionNode): boolean => {
    let containsTarget = getOpenCodeId(node) === targetId;
    for (const child of node.children) containsTarget = visit(child) || containsTarget;
    const sessionId = getOpenCodeId(node);
    if (containsTarget && sessionId) result.add(sessionId);
    return containsTarget;
  };
  for (const node of nodes) visit(node);
};

export const nodeContainsSessionId = (node: AnySessionNode, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  if (getOpenCodeId(node) === sessionId) return true;
  return node.children.some((child) => nodeContainsSessionId(child, sessionId));
};

export const selectFolderRootNodes = <TNode extends AnySessionNode>(
  sessionIds: string[],
  nodeBySessionId: ReadonlyMap<string, TNode>,
): TNode[] => {
  const assignedSessionIds = new Set(sessionIds);
  return sessionIds
    .map((sessionId) => nodeBySessionId.get(sessionId))
    .filter((node): node is TNode => {
      if (!node) return false;
      const visited = new Set<string>();
      let parentID = getParentId(node);
      while (parentID && !visited.has(parentID)) {
        if (assignedSessionIds.has(parentID) && nodeBySessionId.has(parentID)) return false;
        visited.add(parentID);
        const parentNode = nodeBySessionId.get(parentID);
        parentID = parentNode ? getParentId(parentNode) : null;
      }
      return true;
    });
};

const sessionObjectVersions = new WeakMap<object, number>();
let nextSessionObjectVersion = 1;
const getSessionObjectVersion = (session: object): number => {
  const existing = sessionObjectVersions.get(session);
  if (existing !== undefined) return existing;
  const version = nextSessionObjectVersion;
  nextSessionObjectVersion += 1;
  sessionObjectVersions.set(session, version);
  return version;
};

export const computeNodeStructureKey = (node: AnySessionNode): string => {
  if (node.children.length === 0) return '';
  return node.children.map((child) => {
    const childVersion = getSessionObjectVersion(child.session);
    const prefix = `${getNodeStructureId(child)}@${childVersion}`;
    return child.children.length === 0 ? prefix : `${prefix}:${computeNodeStructureKey(child)}`;
  }).join('|');
};

export const nodeHasPinnedMembershipChange = (
  prevNode: AnySessionNode,
  nextNode: AnySessionNode,
  prevPinnedSessionIds: Set<string>,
  nextPinnedSessionIds: Set<string>,
  prevGroupDirectory?: string | null,
  nextGroupDirectory?: string | null,
): boolean => {
  const visit = (previous: AnySessionNode, current: AnySessionNode): boolean => {
    const previousId = getOpenCodeId(previous);
    const currentId = getOpenCodeId(current);
    if (previousId !== currentId || previous.children.length !== current.children.length) return true;
    if (previousId && currentId) {
      const previousKey = getPinnedSessionKey(
        getNodeRuntimeKey(previous),
        getNodeDirectory(previous, prevGroupDirectory),
        previousId,
      );
      const currentKey = getPinnedSessionKey(
        getNodeRuntimeKey(current),
        getNodeDirectory(current, nextGroupDirectory),
        currentId,
      );
      if (
        (previousKey ? prevPinnedSessionIds.has(previousKey) : false)
        !== (currentKey ? nextPinnedSessionIds.has(currentKey) : false)
      ) return true;
    }
    return previous.children.some((child, index) => visit(child, current.children[index]));
  };
  return visit(prevNode, nextNode);
};

export const resolveMenuOpenSessionId = (
  nodes: AnySessionNode[],
  menuKey: string | null,
  renderContext: 'project' | 'recent',
  archivedBucket: boolean,
): string | null => {
  if (!menuKey) return null;
  const bucketTag = archivedBucket ? 'archived' : 'active';
  let result: string | null = null;
  const visit = (node: AnySessionNode): boolean => {
    const sessionId = getOpenCodeId(node) ?? getNodeStructureId(node);
    if (`${renderContext}:${bucketTag}:${sessionId}` === menuKey) {
      result = sessionId;
      return true;
    }
    return node.children.some(visit);
  };
  nodes.forEach((node) => visit(node));
  return result;
};
