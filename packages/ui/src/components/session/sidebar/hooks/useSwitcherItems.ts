import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import type { ChatHarness } from '@/lib/chat-identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useGitAllBranches } from '@/stores/useGitStore';
import {
  refreshPrimeCatalog,
  usePrimeCatalogStore,
} from '@/stores/usePrimeCatalogStore';
import { createPrimeSessionCatalog } from '../primeSessionAdapter';
import type { SessionCatalogNode } from '../sessionCatalog';
import {
  createOpenCodeSessionCatalog,
  getOpenCodeCatalogBranchLabel,
} from '../openCodeSessionAdapter';
import { createSessionOwnershipIndex } from '../sessionOwnership';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { projectFreshPrimeActivityBySession, usePrimeLiveStore } from '@/stores/usePrimeLiveStore';

export type SwitcherItem = {
  node: SessionCatalogNode;
  projectId: string;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

const MAX_PARENT_SESSIONS = 7;

type SwitcherItemsOptions = {
  scopeProjectId?: string | null;
  /** How many parent sessions to return (default 7 — the desktop dropdown). */
  maxParents?: number;
  harnesses?: readonly ChatHarness[];
};

const normalize = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const formatProjectLabel = (project: { label?: string | null; path: string }): string | null => {
  const trimmed = project.label?.trim();
  if (trimmed) return trimmed;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
};

export const useSwitcherItems = (enabled: boolean, options: SwitcherItemsOptions = {}): SwitcherItem[] => {
  const { scopeProjectId = null, maxParents = MAX_PARENT_SESSIONS, harnesses } = options;
  const apis = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const primeSnapshot = usePrimeCatalogStore((state) => state.byRuntime.get(runtimeKey) ?? null);
  const primeLiveStates = usePrimeLiveStore((state) => state.byKey);
  const primeLiveActivityBySessionId = React.useMemo(
    () => projectFreshPrimeActivityBySession(runtimeKey, primeLiveStates),
    [primeLiveStates, runtimeKey],
  );
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore((state) => state.rankById);
  const branchesByDirectory = useGitAllBranches();
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

  React.useEffect(() => {
    if (!enabled) return;
    void refreshPrimeCatalog(runtimeKey, apis);
  }, [apis, enabled, runtimeKey]);

  const worktreeBranchesByDirectory = React.useMemo(() => {
    const branches = new Map<string, string | null>();
    for (const worktrees of availableWorktreesByProject.values()) {
      for (const worktree of worktrees) {
        const worktreePath = normalize(worktree.path);
        if (!worktreePath) continue;
        branches.set(worktreePath, worktree.branch?.trim() || null);
      }
    }
    return branches;
  }, [availableWorktreesByProject]);

  const normalizedProjects = React.useMemo(
    () => projects.flatMap((project) => {
      const normalizedPath = normalize(project.path);
      return normalizedPath ? [{ ...project, normalizedPath }] : [];
    }),
    [projects],
  );
  const projectById = React.useMemo(
    () => new Map(normalizedProjects.map((project) => [project.id, project])),
    [normalizedProjects],
  );
  const harnessFilter = React.useMemo(
    () => harnesses ? new Set(harnesses) : null,
    [harnesses],
  );

  return React.useMemo<SwitcherItem[]>(() => {
    if (!enabled) return [];

    const ownership = createSessionOwnershipIndex(
      activeSessions,
      normalizedProjects,
      availableWorktreesByProject,
      isVSCodeRuntime(),
    );
    const openCodeCatalog = createOpenCodeSessionCatalog({
      sessions: activeSessions,
      ownerBySessionId: ownership.bySessionId,
      compareSessions: (left, right) => compareSessionsByLifecycleOrder(
        left,
        right,
        pinnedSessionIds,
        sessionOrderRanks,
      ),
      runtimeKey,
    });
    const primeCatalog = primeSnapshot
      ? createPrimeSessionCatalog({
          runtimeKey,
          snapshot: primeSnapshot,
          projects: normalizedProjects,
          availableWorktreesByProject,
          liveActivityBySessionId: primeLiveActivityBySessionId,
        })
      : null;
    const openCodeOrder = new Map(openCodeCatalog.roots.map((node, index) => [node.session.identity.sessionId, index]));
    const roots = [
      ...openCodeCatalog.roots,
      ...(primeCatalog?.roots ?? []),
    ].filter((node) => !harnessFilter || harnessFilter.has(node.session.identity.harness));
    roots.sort((left, right) => {
      const leftPinned = left.session.identity.harness === 'opencode'
        && pinnedSessionIds.has(left.session.identity.sessionId);
      const rightPinned = right.session.identity.harness === 'opencode'
        && pinnedSessionIds.has(right.session.identity.sessionId);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (left.session.identity.harness === 'opencode' && right.session.identity.harness === 'opencode') {
        return (openCodeOrder.get(left.session.identity.sessionId) ?? 0)
          - (openCodeOrder.get(right.session.identity.sessionId) ?? 0);
      }
      return right.session.updatedAt - left.session.updatedAt
        || right.session.createdAt - left.session.createdAt
        || left.session.identity.sessionId.localeCompare(right.session.identity.sessionId);
    });

    return roots
      .filter((node) => !scopeProjectId || node.ownership.projectId === scopeProjectId)
      .slice(0, maxParents)
      .flatMap((node) => {
        const owner = node.ownership;
        const project = projectById.get(owner.projectId);
        if (!project) return [];
        const projectLabel = formatProjectLabel(project);
        const branchLabel = node.session.identity.harness === 'opencode'
          ? getOpenCodeCatalogBranchLabel(
              node.session,
              branchesByDirectory,
              worktreeBranchesByDirectory,
            )
          : null;
        return [{
          node,
          projectId: owner.projectId,
          secondaryMeta: {
            projectLabel,
            branchLabel: branchLabel && branchLabel !== projectLabel ? branchLabel : null,
          },
        }];
      });
  }, [
    activeSessions,
    availableWorktreesByProject,
    branchesByDirectory,
    enabled,
    harnessFilter,
    maxParents,
    normalizedProjects,
    pinnedSessionIds,
    primeLiveActivityBySessionId,
    primeSnapshot,
    projectById,
    runtimeKey,
    scopeProjectId,
    sessionOrderRanks,
    worktreeBranchesByDirectory,
  ]);
};
