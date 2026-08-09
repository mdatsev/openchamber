import React from 'react';
import type { PrimeSessionIdentity, PrimeSessionSummary } from '@/lib/api/types';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const INITIAL_VISIBLE_COUNT = 10;

interface PrimeSessionRowsProps {
  sessions: readonly PrimeSessionSummary[];
  rootSessionIDs?: ReadonlySet<string>;
  loadFailed?: boolean;
  onRetry?: () => void;
  onSessionSelected?: (session: PrimeSessionSummary) => void;
  indent?: number;
  mobileVariant?: boolean;
}

const identityKey = (identity: PrimeSessionIdentity | null | undefined) => identity
  ? `${identity.runtimeKey}\0${identity.harness}\0${identity.sessionID}`
  : null;

export function PrimeSessionRows({
  sessions,
  rootSessionIDs,
  loadFailed = false,
  onRetry,
  onSessionSelected,
  indent = 26,
  mobileVariant = false,
}: PrimeSessionRowsProps) {
  const { t } = useI18n();
  const selectedPrimeIdentityKey = useUIStore((state) => identityKey(state.primeTranscriptTarget?.identity));
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_COUNT);
  const [collapsedSessionIDs, setCollapsedSessionIDs] = React.useState<Set<string>>(new Set());

  if (sessions.length === 0 && !loadFailed) return null;

  const nodesByID = new Map(sessions.map((session) => [session.id, { session, children: [] as PrimeSessionSummary[] }]));
  for (const session of sessions) {
    if (!session.parentID) continue;
    const parent = nodesByID.get(session.parentID);
    if (parent) parent.children.push(session);
  }
  const rootSessions = sessions.filter((session) => (
    rootSessionIDs ? rootSessionIDs.has(session.id) : !session.parentID || !nodesByID.has(session.parentID)
  ));
  const visibleSessions = rootSessions.slice(0, visibleCount);
  const hasMore = visibleSessions.length < rootSessions.length;

  const selectSession = (session: PrimeSessionSummary) => {
    useSessionUIStore.getState().closeNewSessionDraft();
    const uiState = useUIStore.getState();
    uiState.setActiveMainTab('chat');
    onSessionSelected?.(session);
    uiState.setPrimeTranscriptTarget(session);
  };

  const renderSession = (session: PrimeSessionSummary, depth: number): React.ReactNode => {
    const selected = selectedPrimeIdentityKey === identityKey(session.identity);
    const children = nodesByID.get(session.id)?.children ?? [];
    const hasChildren = children.length > 0;
    const expanded = hasChildren && !collapsedSessionIDs.has(session.id);
    const rowIndent = indent + (depth * 14);
    const title = session.title || 'Prime Agent';
    return (
      <React.Fragment key={identityKey(session.identity)}>
        <div className="group/prime-row relative">
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t(expanded ? 'sessions.sidebar.group.collapseAria' : 'sessions.sidebar.group.expandAria', { label: title })}
              onClick={() => setCollapsedSessionIDs((current) => {
                const next = new Set(current);
                if (next.has(session.id)) next.delete(session.id);
                else next.add(session.id);
                return next;
              })}
              className="absolute z-10 flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{ left: Math.max(rowIndent - 23, 3), top: mobileVariant ? 8 : 3 }}
            >
              <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
            </button>
          ) : (
            <Icon
              name="chat-ai-3"
              aria-label="Prime Agent"
              className="absolute size-3.5 text-muted-foreground/80"
              style={{ left: Math.max(rowIndent - 20, 6), top: mobileVariant ? 11 : 6 }}
            />
          )}
          <button
            type="button"
            onClick={() => selectSession(session)}
            title={`${title} · ${session.directory}`}
            className={cn(
              'flex w-full items-center rounded-md pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              mobileVariant ? 'h-9' : 'my-0.5 py-1',
              selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
            )}
            style={{ paddingLeft: rowIndent }}
          >
            <span className={cn(
              'min-w-0 flex-1 truncate typography-ui-label font-normal',
              selected ? 'text-interactive-selection-foreground' : 'text-foreground/80',
            )}>
              {title}
            </span>
            {session.activity === 'working' && (
              <span className="ml-1 flex shrink-0 items-center gap-1 typography-micro text-[9px] text-muted-foreground">
                <Icon name="loader-4" className="size-3 animate-spin" />
                {t('prime.status.working')}
              </span>
            )}
            {session.activity !== 'working' && !session.interactive && (
              <Icon
                name="lock"
                aria-label={t('prime.transcript.readOnly')}
                className="ml-1 size-3 shrink-0 text-muted-foreground/70"
              />
            )}
          </button>
        </div>
        {expanded && children.map((child) => renderSession(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <section className="pb-2">
      {loadFailed && sessions.length === 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground">
          <span>{t('common.unavailable')}</span>
          <Button size="xs" variant="ghost" onClick={onRetry}>
            {t('sessions.sidebar.group.empty.retry')}
          </Button>
        </div>
      )}
      {visibleSessions.map((session) => renderSession(session, 0))}
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => Math.min(rootSessions.length, count + INITIAL_VISIBLE_COUNT))}
          className="mt-0.5 flex items-center justify-start rounded-md py-0.5 pr-1.5 text-left text-xs leading-tight text-muted-foreground/70 hover:text-foreground hover:underline"
          style={{ paddingLeft: indent }}
        >
          {t('sessions.sidebar.group.showMore')}
        </button>
      )}
    </section>
  );
}
