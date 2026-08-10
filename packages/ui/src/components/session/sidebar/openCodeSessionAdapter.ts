import type { Session } from '@opencode-ai/sdk/v2';
import { serializeChatIdentityParts } from '@/lib/chat-identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { createOpenCodeChatIdentity } from '@/sync/opencode-chat-selection';
import { registerChatIdentitySelectionHandler } from '@/sync/session-navigation';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from './sessionOwnership';
import type { CatalogSessionNode, SessionNodeController } from './types';
import {
  createSessionCatalogGraph,
  type SessionCatalogEntry,
  type SessionCatalogGraph,
  type SessionCatalogNode,
} from './sessionCatalog';

const sourceSessionByCatalogEntry = new WeakMap<SessionCatalogEntry, Session>();
const worktreeByCatalogEntry = new WeakMap<SessionCatalogEntry, WorktreeMetadata | null>();
const directoryByIdentityKey = new Map<string, string | null>();

const getIdentityKey = (runtimeKey: string, sessionId: string): string => (
  serializeChatIdentityParts(runtimeKey, 'opencode', sessionId)
);

registerChatIdentitySelectionHandler('opencode', (identity) => {
  useSessionUIStore.getState().setCurrentSession(
    identity.sessionId,
    directoryByIdentityKey.get(getIdentityKey(identity.runtimeKey, identity.sessionId)) ?? null,
  );
});

const adaptOpenCodeSession = (
  session: Session,
  runtimeKey: string,
  ownership: DirectoryOwner | null,
): SessionCatalogEntry => {
  const parentID = (session as Session & { parentID?: string | null }).parentID ?? null;
  const entry: SessionCatalogEntry = {
    identity: createOpenCodeChatIdentity(runtimeKey, session.id),
    title: session.title ?? null,
    parentIdentity: parentID ? createOpenCodeChatIdentity(runtimeKey, parentID) : null,
    createdAt: session.time?.created ?? 0,
    updatedAt: session.time?.updated ?? session.time?.created ?? 0,
    archivedAt: session.time?.archived || null,
    activity: null,
    availability: 'ready',
    ownership: ownership ? { projectId: ownership.projectId, kind: ownership.kind } : null,
  };
  sourceSessionByCatalogEntry.set(entry, session);
  directoryByIdentityKey.set(
    getIdentityKey(runtimeKey, session.id),
    resolveGlobalSessionDirectory(session),
  );
  return entry;
};

export const getOpenCodeSourceSession = (entry: SessionCatalogEntry): Session => {
  const source = sourceSessionByCatalogEntry.get(entry);
  if (!source) {
    throw new Error(`Missing OpenCode source for session ${entry.identity.sessionId}`);
  }
  return source;
};

const getCatalogRevision = (
  runtimeKey: string,
  sessions: Session[],
  ownerBySessionId: ReadonlyMap<string, DirectoryOwner>,
): string => JSON.stringify([
  runtimeKey,
  sessions.map((session) => {
    const parentID = (session as Session & { parentID?: string | null }).parentID ?? null;
    const owner = ownerBySessionId.get(session.id);
    return [
      session.id,
      parentID,
      session.title ?? null,
      session.time?.created ?? 0,
      session.time?.updated ?? 0,
      session.time?.archived ?? null,
      owner?.projectId ?? null,
      owner?.kind ?? null,
    ];
  }),
]);

export const createOpenCodeSessionCatalog = (input: {
  sessions: Session[];
  ownerBySessionId: ReadonlyMap<string, DirectoryOwner>;
  compareSessions: (left: Session, right: Session) => number;
  runtimeKey?: string;
}): SessionCatalogGraph => {
  const runtimeKey = input.runtimeKey ?? getRuntimeKey();
  const entries = input.sessions.map((session) => {
    const parentID = (session as Session & { parentID?: string | null }).parentID ?? null;
    return adaptOpenCodeSession(
      session,
      runtimeKey,
      parentID ? null : (input.ownerBySessionId.get(session.id) ?? null),
    );
  });
  return createSessionCatalogGraph(
    runtimeKey,
    getCatalogRevision(runtimeKey, input.sessions, input.ownerBySessionId),
    entries,
    (left, right) => input.compareSessions(
      getOpenCodeSourceSession(left),
      getOpenCodeSourceSession(right),
    ),
  );
};

export const projectOpenCodeSessionNodes = (
  nodes: SessionCatalogNode[],
  resolveWorktree: (session: Session) => WorktreeMetadata | null,
): CatalogSessionNode[] => nodes.map((node) => {
  const sourceSession = getOpenCodeSourceSession(node.session);
  const worktree = resolveWorktree(sourceSession);
  worktreeByCatalogEntry.set(node.session, worktree);
  const controller: SessionNodeController = {
    kind: 'opencode',
    getOpenCodeSessionId: () => sourceSession.id,
  };
  return {
    session: node.session,
    ownership: node.ownership,
    controller,
    children: projectOpenCodeSessionNodes(node.children, resolveWorktree),
  };
});

export const getOpenCodeCatalogWorktree = (entry: SessionCatalogEntry): WorktreeMetadata | null => (
  worktreeByCatalogEntry.get(entry) ?? null
);

export const groupOpenCodeSessionNodes = (
  nodes: CatalogSessionNode[],
  groups: Readonly<{
    rootId: string;
    archivedId: string;
    worktreeIdByDirectory: ReadonlyMap<string, string>;
  }>,
): ReadonlyMap<string, CatalogSessionNode[]> => {
  const grouped = new Map<string, CatalogSessionNode[]>();
  for (const node of nodes) {
    const source = getOpenCodeSourceSession(node.session);
    const groupId = node.session.archivedAt !== null
      ? groups.archivedId
      : node.ownership.kind === 'project'
        ? groups.rootId
        : groups.worktreeIdByDirectory.get(resolveGlobalSessionDirectory(source) ?? '') ?? null;
    if (!groupId) continue;
    const bucket = grouped.get(groupId);
    if (bucket) bucket.push(node);
    else grouped.set(groupId, [node]);
  }
  return grouped;
};

export const getOpenCodeCatalogBranchLabel = (
  entry: SessionCatalogEntry,
  branchesByDirectory: ReadonlyMap<string, string | null>,
  worktreeBranchesByDirectory: ReadonlyMap<string, string | null>,
): string | null => {
  const source = getOpenCodeSourceSession(entry);
  const directory = resolveGlobalSessionDirectory(source);
  if (!directory) return null;
  return branchesByDirectory.get(directory) ?? worktreeBranchesByDirectory.get(directory) ?? null;
};
