import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { CollapsedActivityState } from './collapsedActivityState';

export function CollapsedActivityIndicator({
  state,
  activeLabel,
  questionLabel,
  unreadLabel,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  activeLabel: string;
  questionLabel: string;
  unreadLabel: string;
  className?: string;
}): React.ReactNode {
  if (state === 'question') {
    return (
      <Icon
        name="question"
        className={cn('h-3 w-3 shrink-0 text-[var(--status-info)]', className)}
        aria-label={questionLabel}
      />
    );
  }

  const label = state === 'active' ? activeLabel : unreadLabel;
  // Aggregate rows carry the dot only; the elapsed counter is per session and
  // has no meaning for a collapsed group that may hold several running turns.
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'active' ? 'bg-primary' : 'bg-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
    />
  );
}
