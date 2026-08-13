import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { cn } from '@/lib/utils';
import type { SortableDragHandleProps } from './sortableItems';
import type { SessionLeadingIndicator, SessionRowIndicatorModel } from './useSessionRowIndicatorModel';

export function SessionLeadingIndicatorGlyph({
  indicator,
  variant,
}: {
  indicator: Exclude<SessionLeadingIndicator, null>;
  variant: 'sidebar' | 'mobile';
}): React.ReactNode {
  const { t } = useI18n();
  const iconSize = variant === 'mobile' ? 'size-3.5' : 'size-3';
  if (indicator === 'moving') {
    return (
      <span role="img" aria-label={t('sessions.sidebar.session.status.movingToWorktree')}>
        <Icon name="loader-4" className={cn(iconSize, 'animate-spin text-primary')} />
      </span>
    );
  }
  if (indicator === 'question') {
    return (
      <span role="img" aria-label={t('sessions.sidebar.session.status.inputNeeded')}>
        <Icon name="question" className={cn(iconSize, 'text-[var(--status-info)]')} />
      </span>
    );
  }
  if (indicator === 'active') {
    return (
      <span
        className="size-1.5 rounded-full bg-primary"
        role="img"
        aria-label={t('sessions.sidebar.session.status.active')}
        title={t('sessions.sidebar.session.status.active')}
      />
    );
  }
  if (indicator === 'interrupted') {
    return (
      <span role="img" aria-label={t('sessions.sidebar.session.status.interruptedUnexpectedly')}>
        <Icon name="error-warning" className={cn(iconSize, 'text-status-warning')} />
      </span>
    );
  }
  if (indicator === 'unread') {
    return (
      <span
        className="size-1.5 rounded-full bg-[var(--status-info)]"
        role="img"
        aria-label={t('sessions.sidebar.session.status.unread')}
        title={t('sessions.sidebar.session.status.unread')}
      />
    );
  }
  return (
    <span role="img" aria-label={t('sessions.sidebar.session.status.pinned')}>
      <Icon name="pushpin" className={cn(iconSize, 'shrink-0 text-primary')} />
    </span>
  );
}

export function SessionCheckoutIndicators({
  model,
  variant,
  dragHandleProps,
}: {
  model: SessionRowIndicatorModel;
  variant: 'sidebar' | 'mobile';
  dragHandleProps?: SortableDragHandleProps | null;
}): React.ReactNode {
  const { t } = useI18n();
  const iconSize = variant === 'mobile' ? 'size-3.5' : 'size-3';
  if (model.rootDirectory) {
    const stateLabel = model.rootIsClean === true
      ? t('gitView.empty.cleanTitle')
      : model.rootIsClean === false
        ? t('sessions.sidebar.project.status.uncommittedChanges')
        : null;
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <span className="inline-flex" role="img" aria-label={t('sessions.sidebar.grouping.projectRoot')}>
          <Icon name="git-repository" className={cn(iconSize, 'text-muted-foreground/60')} />
        </span>
        {stateLabel ? (
          <span
            className={cn(
              'inline-flex',
              model.rootIsClean ? 'text-status-success' : 'text-status-warning',
            )}
            role="img"
            aria-label={stateLabel}
          >
            <Icon name={model.rootIsClean ? 'check' : 'file-edit'} className={iconSize} />
          </span>
        ) : null}
      </span>
    );
  }
  if (!model.worktreeDirectory) return null;
  const comparison = model.worktreeComparison;
  const hasComparisonChanges = Boolean(
    comparison?.available && (comparison.hasCommittedChanges || comparison.isDirty),
  );
  const comparisonLabel = comparison?.available
    ? hasComparisonChanges
      ? t('sessions.sidebar.worktreeChanges', {
          branch: comparison.baseBranch ?? '',
          count: comparison.fileCount,
        })
      : t('sessions.sidebar.session.status.worktreeClean', {
          branch: comparison.baseBranch ?? '',
        })
    : null;

  return (
    <span
      ref={dragHandleProps?.setActivatorNodeRef}
      data-worktree-drag-handle={dragHandleProps ? 'true' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1',
        dragHandleProps && 'cursor-grab active:cursor-grabbing',
      )}
      {...(dragHandleProps?.listeners ?? {})}
    >
      <span className="inline-flex" role="img" aria-label={t('sessions.sidebar.session.status.linkedWorktree')}>
        <Icon name="node-tree" className={cn(iconSize, 'text-muted-foreground/60')} />
      </span>
      {comparison?.available && comparisonLabel ? (
        <span
          className={cn(
            'inline-flex',
            hasComparisonChanges ? 'text-status-warning' : 'text-status-success',
          )}
          role="img"
          aria-label={comparisonLabel}
        >
          <Icon name={hasComparisonChanges ? 'git-commit' : 'check'} className={iconSize} />
        </span>
      ) : null}
    </span>
  );
}

export function SessionPrIndicator({
  model,
  variant,
  showDetails = false,
}: {
  model: SessionRowIndicatorModel;
  variant: 'sidebar' | 'mobile';
  showDetails?: boolean;
}): React.ReactNode {
  if (!model.prSummary || !model.prStatusLabel) return null;
  const label = `#${model.prSummary.number} · ${model.prStatusLabel}`;
  const color = `var(--pr-${model.prSummary.visualState})`;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5" style={{ color }} role="img" aria-label={label}>
      <Icon
        name="git-pull-request"
        className={variant === 'mobile' ? 'size-3.5' : 'size-3'}
      />
      {showDetails && <span className="min-w-0 truncate">{label}</span>}
    </span>
  );
}

export function SessionGoalIndicator({
  goal,
  variant,
}: {
  goal: SessionGoalPayload | null;
  variant: 'sidebar' | 'mobile';
}): React.ReactNode {
  const { t } = useI18n();
  if (!goal) return null;
  const label = t(sessionGoalStatusLabelKey[goal.status] as never);
  return (
    <span className="inline-flex shrink-0 items-center" title={label} role="img" aria-label={label}>
      <Icon
        name="target"
        className={variant === 'mobile' ? 'size-3.5' : 'size-3'}
        style={{ color: sessionGoalStatusColor[goal.status] }}
      />
    </span>
  );
}

export function SessionBlockingRequestBadges({ model }: { model: SessionRowIndicatorModel }): React.ReactNode {
  const { t } = useI18n();
  const questionLabel = model.pendingQuestionCount === 1
    ? t('sessions.sidebar.session.status.questionPendingSingle')
    : t('sessions.sidebar.session.status.questionPendingMany', { count: model.pendingQuestionCount });
  return (
    <>
      {model.pendingPermissionCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive"
          role="status"
          title={t('sessions.sidebar.session.status.permissionRequired')}
          aria-label={t('sessions.sidebar.session.status.permissionRequired')}
        >
          <Icon name="shield" className="size-3" />
          <span className="leading-none">{model.pendingPermissionCount}</span>
        </span>
      ) : null}
      {model.pendingQuestionCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded bg-status-info/10 px-1 py-0.5 text-[0.7rem] text-status-info"
          role="status"
          title={questionLabel}
          aria-label={questionLabel}
        >
          <Icon name="question" className="size-3" />
          <span className="leading-none">{model.pendingQuestionCount}</span>
        </span>
      ) : null}
    </>
  );
}

export function SessionPersistentErrorIndicator({ variant }: { variant: 'sidebar' | 'mobile' }): React.ReactNode {
  const { t } = useI18n();
  return (
    <span role="img" aria-label={t('sessions.scheduledTasks.dialog.status.error')}>
      <Icon
        name="error-warning"
        className={cn(variant === 'mobile' ? 'size-3.5' : 'size-4', 'text-status-warning')}
      />
    </span>
  );
}
