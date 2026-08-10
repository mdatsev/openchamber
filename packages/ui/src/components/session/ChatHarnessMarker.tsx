import React from 'react';
import type { ChatHarness } from '@/lib/chat-identity';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const LABEL_KEY_BY_HARNESS = {
  opencode: 'sessions.harness.openCode',
  prime: 'sessions.harness.primeAgent',
} as const satisfies Record<ChatHarness, 'sessions.harness.openCode' | 'sessions.harness.primeAgent'>;

type Props = {
  harness: ChatHarness;
  compact?: boolean;
  className?: string;
};

export const ChatHarnessMarker = React.memo(function ChatHarnessMarker({
  harness,
  compact = false,
  className,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const label = t(LABEL_KEY_BY_HARNESS[harness]);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm border border-border/70 bg-secondary font-medium text-muted-foreground',
        compact ? 'px-1 py-px typography-micro' : 'px-1.5 py-0.5 typography-meta',
        className,
      )}
      aria-label={label}
      title={label}
    >
      {label}
    </span>
  );
});
