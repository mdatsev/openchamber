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
  if (state === 'active') {
    return (
      <Icon
        name="loader-4"
        className={cn('h-3 w-3 shrink-0 animate-spin text-primary', className)}
        aria-label={label}
      />
    );
  }

  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        'bg-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
    />
  );
}
