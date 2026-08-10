import type { Session } from '@opencode-ai/sdk/v2';
import { serializeChatIdentity } from '@/lib/chat-identity';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionCatalogEntry, SessionCatalogNode } from './sessionCatalog';

export type SessionNodeController = Readonly<{
  kind: 'opencode' | 'passive';
  getOpenCodeSessionId: () => string | null;
}>;

export type CatalogSessionNode = Readonly<{
  session: SessionCatalogEntry;
  ownership: SessionCatalogNode['ownership'];
  controller: SessionNodeController;
  children: CatalogSessionNode[];
}>;

// Legacy SDK-backed controller node. Kept as the private OpenCode controller
// contract and for compatibility with controller-focused utilities.
export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree: WorktreeMetadata | null;
};

export type SessionGroupFolderScope = {
  scopeKey: string;
  directory: string | null;
};

export type SessionGroup<TNode = SessionNode> = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  isArchivedBucket?: boolean;
  worktree: WorktreeMetadata | null;
  directory: string | null;
  folderScopeKey?: string | null;
  /**
   * Flat display groups merge sessions from the project root and every
   * worktree; their folders come from all of these scopes. When present, the
   * group section gathers folders across every listed scope (in order)
   * instead of reading the single folderScopeKey.
   */
  folderScopes?: SessionGroupFolderScope[];
  sessions: TNode[];
};

export type GroupSearchData<TNode = CatalogSessionNode> = {
  filteredNodes: TNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};

export const getSessionNodeIdentityKey = (node: CatalogSessionNode): string => (
  serializeChatIdentity(node.session.identity)
);
