import React from 'react';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionGroup, CatalogSessionNode } from '../types';
import type { SessionCatalogEntry } from '../sessionCatalog';
import {
  getArchivedScopeKey,
  normalizeForBranchComparison,
  normalizePath,
} from '../utils';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getWorktreeFirstSeenAt } from '../worktreeFirstSeen';
import { groupOpenCodeSessionNodes } from '../openCodeSessionAdapter';
import { groupPrimeSessionNodes } from '../primeSessionAdapter';

const getOpaqueWorktreeGroupId = (directory: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < directory.length; index += 1) {
    hash ^= directory.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `worktree:${(hash >>> 0).toString(36)}`;
};

type Args = {
  homeDirectory: string | null;
  sessionOrderRanks: ReadonlyMap<string, number>;
  gitBranches: Map<string, string | null>;
  isVSCode: boolean;
};

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  const buildGroupSearchText = React.useCallback((group: SessionGroup<CatalogSessionNode>): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: SessionCatalogEntry): string => {
    const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
    return sessionTitle.toLowerCase();
  }, [t]);

  const filterSessionNodesForSearch = React.useCallback(
    (nodes: CatalogSessionNode[], query: string): CatalogSessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = buildSessionSearchText(node.session).includes(query);
        if (nodeMatches) {
          return [node];
        }

        const filteredChildren = filterSessionNodesForSearch(node.children, query);
        if (filteredChildren.length === 0) {
          return [];
        }

        return [{ ...node, children: filteredChildren }];
      });
    },
    [buildSessionSearchText],
  );

  const buildGroupedSessions = React.useCallback(
    (
      projectNodes: CatalogSessionNode[],
      projectRoot: string | null,
      availableWorktrees: WorktreeMetadata[],
      projectRootBranch: string | null,
      projectIsRepo: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);

      const worktreeByPath = new Map<string, WorktreeMetadata>();
      availableWorktrees.forEach((meta) => {
        if (meta.path) {
          const normalized = normalizePath(meta.path) ?? meta.path;
          worktreeByPath.set(normalized, meta);
        }
      });

      const roots = projectNodes;

      const groupedNodes = new Map<string, CatalogSessionNode[]>();
      const archivedKey = 'archived';
      const rootKey = 'root';
      const worktreeIdByDirectory = new Map(availableWorktrees.map((worktree) => {
        const directory = normalizePath(worktree.path) ?? worktree.path;
        return [directory, getOpaqueWorktreeGroupId(directory)] as const;
      }));
      const resolveWorktreeGroupId = (directory: string): string => (
        worktreeIdByDirectory.get(directory) ?? getOpaqueWorktreeGroupId(directory)
      );
      const projections = [
        groupOpenCodeSessionNodes(
          roots.filter((node) => node.controller.kind === 'opencode'),
          { rootId: rootKey, archivedId: archivedKey, worktreeIdByDirectory },
        ),
        groupPrimeSessionNodes(
          roots.filter((node) => node.controller.kind === 'passive'),
          { rootId: rootKey, worktreeIdByDirectory },
        ),
      ];
      for (const projection of projections) {
        for (const [groupId, groupNodes] of projection) {
          const bucket = groupedNodes.get(groupId);
          if (bucket) bucket.push(...groupNodes);
          else groupedNodes.set(groupId, [...groupNodes]);
        }
      }
      for (const bucket of groupedNodes.values()) {
        bucket.sort((left, right) => (
          right.session.updatedAt - left.session.updatedAt
          || right.session.createdAt - left.session.createdAt
          || left.session.identity.sessionId.localeCompare(right.session.identity.sessionId)
        ));
      }

      const groups: SessionGroup<CatalogSessionNode>[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? t('sessions.sidebar.grouping.projectRootWithBranch', { branch: projectRootBranch })
          : t('sessions.sidebar.grouping.projectRoot'),
        branch: projectRootBranch ?? null,
        description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, args.homeDirectory) : null,
        isMain: true,
        isArchivedBucket: false,
        worktree: null,
        directory: normalizedProjectRoot,
        folderScopeKey: normalizedProjectRoot,
        sessions: groupedNodes.get(rootKey) ?? [],
      }];

      // Calculate display-order activity for each worktree.
      const worktreeActivityInfo = new Map<string, { hasActiveSession: boolean; lastUpdatedAt: number }>();
      availableWorktrees.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const sessionsInWorktree = groupedNodes.get(resolveWorktreeGroupId(directory)) ?? [];
        const hasActiveSession = sessionsInWorktree.length > 0;
        // Lifecycle rank wins when present; timestamps seed bootstrap ordering.
        const lastUpdatedAt = sessionsInWorktree.reduce((max, node) => {
          const openCodeId = node.controller.getOpenCodeSessionId();
          const updatedAt = openCodeId
            ? (args.sessionOrderRanks.get(openCodeId) ?? node.session.updatedAt)
            : node.session.updatedAt;
          return Math.max(max, updatedAt);
        }, 0);

        worktreeActivityInfo.set(directory, { hasActiveSession, lastUpdatedAt });
      });

      // Sort populated worktrees by shared session activity, then empty ones by label.
      const sortedWorktrees = [...availableWorktrees].sort((a, b) => {
        const aDir = normalizePath(a.path) ?? a.path;
        const bDir = normalizePath(b.path) ?? b.path;
        const aInfo = worktreeActivityInfo.get(aDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };
        const bInfo = worktreeActivityInfo.get(bDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };

        // First priority: active status (active first)
        if (aInfo.hasActiveSession !== bInfo.hasActiveSession) {
          return aInfo.hasActiveSession ? -1 : 1;
        }

        // Second priority: for populated worktrees, sort by latest display activity.
        if (aInfo.hasActiveSession && bInfo.hasActiveSession) {
          return bInfo.lastUpdatedAt - aInfo.lastUpdatedAt;
        }

        // Third priority: for inactive worktrees, most recently discovered
        // first (a worktree created mid-session surfaces at the top of the
        // list; startup discovery ties and falls through to labels).
        const aSeen = getWorktreeFirstSeenAt(a.path);
        const bSeen = getWorktreeFirstSeenAt(b.path);
        if (aSeen !== bSeen) {
          return bSeen - aSeen;
        }

        // Fourth priority: sort by label (asc)
        const aLabel = (a.label || a.branch || a.name || a.path || '').toLowerCase();
        const bLabel = (b.label || b.branch || b.name || b.path || '').toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      // VS Code groups strictly by open workspace — no per-worktree subgroups.
      const worktreeGroups = args.isVSCode ? [] : sortedWorktrees;
      worktreeGroups.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const currentBranch = args.gitBranches.get(directory)?.trim() || null;
        const metadataBranch = meta.branch?.trim() || null;
        const shouldSyncLabelWithBranch = Boolean(
          currentBranch && metadataBranch && meta.label && normalizeForBranchComparison(meta.label) === normalizeForBranchComparison(metadataBranch),
        );
        const label = shouldSyncLabelWithBranch
          ? currentBranch!
          : (meta.label || meta.name || formatDirectoryName(directory, args.homeDirectory) || directory);

        groups.push({
          id: resolveWorktreeGroupId(directory),
          label,
          branch: currentBranch || metadataBranch,
          description: formatPathForDisplay(directory, args.homeDirectory),
          isMain: false,
          isArchivedBucket: false,
          worktree: meta,
          directory,
          folderScopeKey: directory,
          sessions: groupedNodes.get(resolveWorktreeGroupId(directory)) ?? [],
        });
      });

      const archivedSessions = groupedNodes.get(archivedKey) ?? [];
      if (archivedSessions.length > 0) {
        groups.push({
          id: 'archived',
          label: t('sessions.sidebar.grouping.archived'),
          branch: null,
          description: t('sessions.sidebar.grouping.archivedDescription'),
          isMain: false,
          isArchivedBucket: true,
          worktree: null,
          directory: null,
          folderScopeKey: !args.isVSCode && normalizedProjectRoot ? getArchivedScopeKey(normalizedProjectRoot) : null,
          sessions: archivedSessions,
        });
      }

      return groups;
    },
    [args.homeDirectory, args.sessionOrderRanks, args.gitBranches, args.isVSCode, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
