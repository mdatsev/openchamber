import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useGitStore, useWorktreeComparisonSummary } from '@/stores/useGitStore';

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
  const comparison = useWorktreeComparisonSummary(normalizedDirectory || null);
  const fetchWorktreeComparison = useGitStore((state) => state.fetchWorktreeComparison);

  React.useEffect(() => {
    if (!manageRefresh || !normalizedDirectory || !git.getWorktreeComparison) return;
    void fetchWorktreeComparison(normalizedDirectory, git);
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizeDirectory(hint.directory) !== normalizedDirectory) return;
      void fetchWorktreeComparison(normalizedDirectory, git);
    });
  }, [fetchWorktreeComparison, git, manageRefresh, normalizedDirectory]);

  if (!comparison?.available || !comparison.hasChanges) return null;

  const label = t('sessions.sidebar.worktreeChanges', {
    branch: comparison.baseBranch,
    count: comparison.fileCount,
  });
  const indicator = (
    <span
      className={cn('inline-flex size-4 shrink-0 items-center justify-center text-[var(--status-warning)]', className)}
      aria-label={label}
    >
      <Icon name="git-commit" className="size-3.5" />
    </span>
  );

  if (!showTooltip) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
};
