import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useGitStore, useResolvedWorktreeComparisonSummary } from '@/stores/useGitStore';

const normalizeDirectory = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');

export const WorktreeChangesIndicator: React.FC<{
  directory: string;
  className?: string;
  showTooltip?: boolean;
  manageRefresh?: boolean;
}> = ({ directory, className, showTooltip = true, manageRefresh = true }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const normalizedDirectory = normalizeDirectory(directory);
  const comparison = useResolvedWorktreeComparisonSummary(normalizedDirectory || null);
  const upstreamAhead = useGitStore((state) => state.directories.get(normalizedDirectory)?.status?.ahead ?? 0);
  const fetchWorktreeComparison = useGitStore((state) => state.fetchWorktreeComparison);
  const ensureWorktreeComparison = useGitStore((state) => state.ensureWorktreeComparison);

  React.useEffect(() => {
    if (!manageRefresh || !normalizedDirectory || !git.getWorktreeComparison) return;
    void ensureWorktreeComparison(normalizedDirectory, git, { mode: 'combined' });
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizeDirectory(hint.directory) !== normalizedDirectory) return;
      void fetchWorktreeComparison(normalizedDirectory, git, { mode: 'combined' });
    });
  }, [ensureWorktreeComparison, fetchWorktreeComparison, git, manageRefresh, normalizedDirectory]);

  const hasWorktreeChanges = Boolean(comparison?.available && (comparison.hasCommittedChanges || comparison.isDirty));
  const hasUnpushedCommits = upstreamAhead > 0;
  if (!hasWorktreeChanges && !hasUnpushedCommits) return null;

  const changeLabel = hasWorktreeChanges && comparison?.available
    ? t('sessions.sidebar.worktreeChanges', {
        branch: comparison.baseBranch ?? '',
        count: comparison.fileCount,
      })
    : null;
  const pushLabel = hasUnpushedCommits
    ? t('gitView.sync.pushTooltipAhead', { count: upstreamAhead })
    : null;
  const indicator = (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-status-warning', className)}>
      {changeLabel || pushLabel ? (
        <span className="inline-flex size-4 items-center justify-center" aria-label={changeLabel ?? pushLabel ?? undefined} role="img">
          <Icon name="node-tree" className="size-3.5" />
        </span>
      ) : null}
      {pushLabel ? (
        <span className="inline-flex size-4 items-center justify-center" aria-label={pushLabel} role="img">
          <Icon name="arrow-up" className="size-3.5" />
        </span>
      ) : null}
    </span>
  );

  if (!showTooltip) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent sideOffset={8}>
        {changeLabel ? <div>{changeLabel}</div> : null}
        {pushLabel ? <div>{pushLabel}</div> : null}
      </TooltipContent>
    </Tooltip>
  );
};
