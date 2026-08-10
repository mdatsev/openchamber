import { serializeChatIdentity, type ChatIdentity } from '@/lib/chat-identity';

export type SessionCatalogOwnership = Readonly<{
  projectId: string;
  kind: 'project' | 'worktree';
}>;

export type SessionCatalogEntry = Readonly<{
  identity: ChatIdentity;
  title: string | null;
  parentIdentity: ChatIdentity | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  activity: 'working' | 'idle' | 'inactive' | null;
  availability: 'ready' | 'unavailable';
  ownership: SessionCatalogOwnership | null;
}>;

export type SessionCatalogNode = Readonly<{
  session: SessionCatalogEntry;
  ownership: SessionCatalogOwnership;
  children: SessionCatalogNode[];
}>;

export type SessionCatalogGraph = Readonly<{
  runtimeKey: string;
  revision: string;
  roots: SessionCatalogNode[];
  nodesByIdentity: ReadonlyMap<string, SessionCatalogNode>;
  omittedIdentityKeys: ReadonlySet<string>;
}>;

const getSessionIdentityKey = (identity: ChatIdentity): string => serializeChatIdentity(identity);

export const createSessionCatalogGraph = (
  runtimeKey: string,
  revision: string,
  sessions: SessionCatalogEntry[],
  compareSessions: (left: SessionCatalogEntry, right: SessionCatalogEntry) => number,
): SessionCatalogGraph => {
  const sessionsByIdentity = new Map<string, SessionCatalogEntry>();
  for (const session of sessions) {
    if (session.identity.runtimeKey !== runtimeKey) continue;
    sessionsByIdentity.set(getSessionIdentityKey(session.identity), session);
  }

  const rootByIdentity = new Map<string, SessionCatalogEntry | null>();
  const resolving = new Set<string>();
  const resolveRoot = (session: SessionCatalogEntry): SessionCatalogEntry | null => {
    const identityKey = getSessionIdentityKey(session.identity);
    if (rootByIdentity.has(identityKey)) {
      return rootByIdentity.get(identityKey) ?? null;
    }
    if (resolving.has(identityKey)) {
      rootByIdentity.set(identityKey, null);
      return null;
    }
    if (!session.parentIdentity) {
      rootByIdentity.set(identityKey, session);
      return session;
    }

    resolving.add(identityKey);
    const parent = sessionsByIdentity.get(getSessionIdentityKey(session.parentIdentity));
    const root = parent ? resolveRoot(parent) : null;
    resolving.delete(identityKey);
    rootByIdentity.set(identityKey, root);
    return root;
  };

  const omittedIdentityKeys = new Set<string>();
  const validSessions: SessionCatalogEntry[] = [];
  for (const session of sessionsByIdentity.values()) {
    const root = resolveRoot(session);
    if (!root || !root.ownership || (root.archivedAt !== null) !== (session.archivedAt !== null)) {
      omittedIdentityKeys.add(getSessionIdentityKey(session.identity));
      continue;
    }
    validSessions.push(session);
  }

  const childrenByParent = new Map<string, SessionCatalogEntry[]>();
  for (const session of validSessions) {
    if (!session.parentIdentity) continue;
    const parentKey = getSessionIdentityKey(session.parentIdentity);
    if (omittedIdentityKeys.has(parentKey)) continue;
    const children = childrenByParent.get(parentKey);
    if (children) {
      children.push(session);
    } else {
      childrenByParent.set(parentKey, [session]);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareSessions);
  }

  const nodesByIdentity = new Map<string, SessionCatalogNode>();
  const buildNode = (session: SessionCatalogEntry): SessionCatalogNode => {
    const root = resolveRoot(session);
    if (!root?.ownership) {
      throw new Error(`Missing validated root ownership for ${getSessionIdentityKey(session.identity)}`);
    }
    const node: SessionCatalogNode = {
      session,
      ownership: root.ownership,
      children: (childrenByParent.get(getSessionIdentityKey(session.identity)) ?? []).map(buildNode),
    };
    nodesByIdentity.set(getSessionIdentityKey(session.identity), node);
    return node;
  };

  const roots = validSessions
    .filter((session) => session.parentIdentity === null)
    .sort(compareSessions)
    .map(buildNode);

  return {
    runtimeKey,
    revision,
    roots,
    nodesByIdentity,
    omittedIdentityKeys,
  };
};

export const mergeSessionCatalogGraphs = (
  runtimeKey: string,
  graphs: readonly SessionCatalogGraph[],
  compareSessions: (left: SessionCatalogEntry, right: SessionCatalogEntry) => number,
): SessionCatalogGraph => {
  const roots: SessionCatalogNode[] = [];
  const nodesByIdentity = new Map<string, SessionCatalogNode>();
  const omittedIdentityKeys = new Set<string>();
  const revisions: string[] = [];

  for (const graph of graphs) {
    if (graph.runtimeKey !== runtimeKey) continue;
    revisions.push(graph.revision);
    roots.push(...graph.roots);
    for (const [identityKey, node] of graph.nodesByIdentity) {
      nodesByIdentity.set(identityKey, node);
    }
    for (const identityKey of graph.omittedIdentityKeys) {
      omittedIdentityKeys.add(identityKey);
    }
  }
  roots.sort((left, right) => compareSessions(left.session, right.session));

  return {
    runtimeKey,
    revision: revisions.join('|'),
    roots,
    nodesByIdentity,
    omittedIdentityKeys,
  };
};
