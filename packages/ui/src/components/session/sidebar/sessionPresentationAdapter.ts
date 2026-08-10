import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { projectOpenCodeSessionNodes } from './openCodeSessionAdapter';
import { projectPrimeSessionNodes } from './primeSessionAdapter';
import type { SessionCatalogGraph, SessionCatalogNode } from './sessionCatalog';
import type { CatalogSessionNode } from './types';

const projectNode = (
  node: SessionCatalogNode,
  resolveOpenCodeWorktree: (session: Session) => WorktreeMetadata | null,
): CatalogSessionNode[] => {
  switch (node.session.identity.harness) {
    case 'opencode':
      return projectOpenCodeSessionNodes([node], resolveOpenCodeWorktree);
    case 'prime':
      return projectPrimeSessionNodes([node]);
  }
};

export const projectSessionCatalogGraph = (
  graph: SessionCatalogGraph,
  resolveOpenCodeWorktree: (session: Session) => WorktreeMetadata | null,
): CatalogSessionNode[] => graph.roots.flatMap((node) => projectNode(node, resolveOpenCodeWorktree));
