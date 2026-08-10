import type { PrimeCatalogSession } from '@/lib/api/types';
import type { ChatIdentity } from '@/lib/chat-identity';
import { createPrimeChatIdentity } from '@/lib/prime/identity';
import { normalizePath } from '@/lib/pathNormalization';
import { useChatSelectionStore } from '@/stores/useChatSelectionStore';
import type {
  PrimeCatalogRecord,
  PrimeCatalogSnapshot,
} from '@/stores/usePrimeCatalogStore';
import { registerChatIdentitySelectionHandler } from '@/sync/session-navigation';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { createRootSessionOwnershipIndex } from './sessionOwnership';
import {
  createSessionCatalogGraph,
  type SessionCatalogEntry,
  type SessionCatalogGraph,
  type SessionCatalogNode,
} from './sessionCatalog';
import type { CatalogSessionNode, SessionNodeController } from './types';

const privateDirectoryByRuntime = new Map<string, Map<string, string | null>>();

export const replacePrimeCatalogDirectories = (
  runtimeKey: string,
  records: PrimeCatalogSession[],
) => {
  privateDirectoryByRuntime.set(runtimeKey, new Map(records.map((record) => [
    record.sessionId,
    normalizePath(record.workingDirectory) ?? null,
  ])));
};

export const removePrimeCatalogDirectories = (runtimeKey: string) => {
  privateDirectoryByRuntime.delete(runtimeKey);
};

export const getPrimeCatalogDirectory = (identity: ChatIdentity | null) => {
  if (!identity || identity.harness !== 'prime') return undefined;
  return privateDirectoryByRuntime
    .get(identity.runtimeKey)
    ?.get(identity.sessionId) ?? undefined;
};

const resolveValidRecords = (records: PrimeCatalogRecord[]): PrimeCatalogRecord[] => {
  const byId = new Map(records.map((record) => [record.sessionId, record]));
  const rootById = new Map<string, string | null>();
  const resolving = new Set<string>();
  const resolveRootId = (record: PrimeCatalogRecord): string | null => {
    if (rootById.has(record.sessionId)) return rootById.get(record.sessionId) ?? null;
    if (resolving.has(record.sessionId)) {
      rootById.set(record.sessionId, null);
      return null;
    }
    if (record.parentSessionId === null) {
      const rootId = record.rootSessionId === record.sessionId ? record.sessionId : null;
      rootById.set(record.sessionId, rootId);
      return rootId;
    }
    resolving.add(record.sessionId);
    const parent = byId.get(record.parentSessionId);
    const rootId = parent ? resolveRootId(parent) : null;
    resolving.delete(record.sessionId);
    const validRootId = rootId === record.rootSessionId ? rootId : null;
    rootById.set(record.sessionId, validRootId);
    return validRootId;
  };
  return records.filter((record) => resolveRootId(record) !== null);
};

type PrimeCatalogProject = {
  id: string;
  normalizedPath: string;
};

export const createPrimeSessionCatalog = (input: {
  runtimeKey: string;
  snapshot: PrimeCatalogSnapshot;
  projects: PrimeCatalogProject[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  liveActivityBySessionId?: ReadonlyMap<string, 'working' | 'idle'>;
}): SessionCatalogGraph => {
  const validRecords = resolveValidRecords(input.snapshot.records);
  const directories = privateDirectoryByRuntime.get(input.runtimeKey) ?? new Map();
  const ownership = createRootSessionOwnershipIndex(
    validRecords,
    input.projects,
    input.availableWorktreesByProject,
    false,
    {
      getIdentityKey: (record) => record.sessionId,
      getSessionId: (record) => record.sessionId,
      getParentIdentityKey: (record) => record.parentSessionId,
      getDirectory: (record) => directories.get(record.sessionId) ?? null,
      isArchived: () => false,
      isDiscoverable: () => true,
    },
  );
  const entries: SessionCatalogEntry[] = validRecords.map((record) => ({
    identity: createPrimeChatIdentity(input.runtimeKey, record.sessionId),
    title: record.title,
    parentIdentity: record.parentSessionId
      ? createPrimeChatIdentity(input.runtimeKey, record.parentSessionId)
      : null,
    createdAt: record.createdAt ?? 0,
    updatedAt: record.updatedAt ?? record.createdAt ?? 0,
    archivedAt: null,
    activity: input.liveActivityBySessionId?.get(record.sessionId) ?? 'inactive',
    availability: record.availability,
    ownership: record.parentSessionId === null
      ? (() => {
          const owner = ownership.bySessionId.get(record.sessionId);
          return owner ? { projectId: owner.projectId, kind: owner.kind } : null;
        })()
      : null,
  }));
  return createSessionCatalogGraph(
    input.runtimeKey,
    input.snapshot.revision ?? `unresolved:${input.runtimeKey}`,
    entries,
    (left, right) => (
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || left.identity.sessionId.localeCompare(right.identity.sessionId)
    ),
  );
};

export const projectPrimeSessionNodes = (nodes: SessionCatalogNode[]): CatalogSessionNode[] => nodes.map((node) => {
  const controller: SessionNodeController = {
    kind: 'passive',
    getOpenCodeSessionId: () => null,
  };
  return {
    session: node.session,
    ownership: node.ownership,
    controller,
    children: projectPrimeSessionNodes(node.children),
  };
});

export const groupPrimeSessionNodes = (
  nodes: CatalogSessionNode[],
  groups: Readonly<{
    rootId: string;
    worktreeIdByDirectory: ReadonlyMap<string, string>;
  }>,
): ReadonlyMap<string, CatalogSessionNode[]> => {
  const grouped = new Map<string, CatalogSessionNode[]>();
  for (const node of nodes) {
    const directory = privateDirectoryByRuntime
      .get(node.session.identity.runtimeKey)
      ?.get(node.session.identity.sessionId) ?? null;
    const groupId = node.ownership.kind === 'project'
      ? groups.rootId
      : groups.worktreeIdByDirectory.get(directory ?? '') ?? null;
    if (!groupId) continue;
    const bucket = grouped.get(groupId);
    if (bucket) bucket.push(node);
    else grouped.set(groupId, [node]);
  }
  return grouped;
};

registerChatIdentitySelectionHandler('prime', (identity) => {
  useSessionUIStore.getState().closeNewSessionDraft();
  useChatSelectionStore.getState().setVisibleChatIdentity(identity);
});
