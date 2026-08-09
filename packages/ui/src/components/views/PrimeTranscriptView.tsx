import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ReasoningTimelineBlock } from '@/components/chat/message/parts/ReasoningPart';
import { PrimeToolPart } from '@/components/chat/message/parts/PrimeToolPart';
import { PrimeControlSelectors } from '@/components/chat/PrimeControlSelectors';
import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { usePrimeRuntimeStatus } from '@/hooks/usePrimeRuntimeStatus';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
  HarnessSessionIdentity,
  PrimeSessionControls,
  PrimeSessionSummary,
  PrimeSlashCommand,
  PrimeModel,
  PrimeThinkingLevel,
  PrimeTranscript,
  PrimeTranscriptItem,
} from '@/lib/api/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

const INITIAL_VISIBLE_ITEMS = 200;
const LIVE_TRANSCRIPT_REFRESH_MS = 1_000;

type PrimeComposerCommand = Pick<PrimeSlashCommand, 'name' | 'description' | 'argumentHint'>;
type PrimeControlChange =
  | { kind: 'model'; model: PrimeModel }
  | { kind: 'thinking'; level: PrimeThinkingLevel };

const PRIME_SESSION_COMMANDS: PrimeComposerCommand[] = [
  { name: 'compact', description: null, argumentHint: '[instructions]' },
  { name: 'refine', description: null, argumentHint: null },
  { name: 'goal', description: null, argumentHint: '[objective]' },
  { name: 'autonomous', description: null, argumentHint: '[status|on|off]' },
];

const isAmbiguousMutationError = (error: unknown) => error instanceof Error
  && (error as Error & { ambiguous?: boolean }).ambiguous === true;

const identityKey = (identity: HarnessSessionIdentity | null | undefined) => identity
  ? JSON.stringify([identity.runtimeKey, identity.harness, identity.sessionID])
  : null;

const transcriptItemClass = (item: PrimeTranscriptItem) => {
  if (item.role === 'user') return 'ml-auto max-w-[85%] bg-interactive-hover';
  if (item.role === 'system') return 'border border-border/40 bg-[var(--surface-muted)] text-muted-foreground';
  return '';
};

const PrimeTranscriptSession: React.FC<{ target: PrimeSessionSummary }> = ({ target }) => {
  const { t } = useI18n();
  const primeAPI = useRuntimeAPIs().prime;
  const mobileAppActions = useMobileAppActions();
  const setPrimeTranscriptTarget = useUIStore((state) => state.setPrimeTranscriptTarget);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const targetID = target.id;
  const targetIdentity = target.identity;
  const targetIdentityKey = identityKey(targetIdentity)!;
  const [transcript, setTranscript] = React.useState<PrimeTranscript | null>(null);
  const [controls, setControls] = React.useState<PrimeSessionControls | null>(null);
  const [isAttached, setIsAttached] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [controlsLoadFailed, setControlsLoadFailed] = React.useState(false);
  const [loadRevision, setLoadRevision] = React.useState(0);
  const [controlsRevision, setControlsRevision] = React.useState(0);
  const [visibleItemCount, setVisibleItemCount] = React.useState(INITIAL_VISIBLE_ITEMS);
  const [prompt, setPrompt] = React.useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = React.useState(0);
  const [commandsDismissed, setCommandsDismissed] = React.useState(false);
  const [activity, setActivity] = React.useState<'working' | 'idle'>(target.activity);
  const [isSending, setIsSending] = React.useState(false);
  const [isAborting, setIsAborting] = React.useState(false);
  const [updatingControl, setUpdatingControl] = React.useState<'model' | 'thinking' | null>(null);
  const [copiedItemID, setCopiedItemID] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const transcriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  const transcriptContentRef = React.useRef<HTMLDivElement | null>(null);
  const followLatestRef = React.useRef(true);
  const refreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityRevisionRef = React.useRef(0);
  const attachedIdentityRef = React.useRef(false);
  const sendOperationRef = React.useRef(0);
  const abortOperationRef = React.useRef(0);
  const isMountedRef = React.useRef(true);
  const {
    status: runtimeStatus,
    isLoading: statusLoading,
    loadFailed: statusLoadFailed,
    retry: retryStatus,
  } = usePrimeRuntimeStatus(primeAPI, true);

  const runtimeReady = !statusLoadFailed && runtimeStatus?.state === 'ready' && runtimeStatus.interactive;
  const statusPending = !statusLoadFailed
    && (statusLoading || runtimeStatus === null || runtimeStatus.state === 'starting');

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (runtimeStatus === null || runtimeStatus.state === 'starting' || target.interactive === runtimeReady) return;
    const currentTarget = useUIStore.getState().primeTranscriptTarget;
    if (currentTarget && identityKey(currentTarget.identity) === targetIdentityKey && currentTarget.interactive !== runtimeReady) {
      setPrimeTranscriptTarget({ ...currentTarget, interactive: runtimeReady });
    }
  }, [runtimeReady, runtimeStatus, setPrimeTranscriptTarget, target.interactive, targetIdentityKey]);

  React.useEffect(() => {
    if (!primeAPI || !runtimeReady) {
      if (!runtimeReady) attachedIdentityRef.current = false;
      return;
    }
    if (attachedIdentityRef.current) return;
    const requestedIdentity = useUIStore.getState().primeTranscriptTarget?.identity;
    if (!requestedIdentity || identityKey(requestedIdentity) !== targetIdentityKey) return;
    const abortController = new AbortController();
    let cancelled = false;
    void primeAPI.attachSession(requestedIdentity, abortController.signal).then((session) => {
      if (cancelled || identityKey(useUIStore.getState().primeTranscriptTarget?.identity) !== targetIdentityKey) return;
      attachedIdentityRef.current = true;
      setIsAttached(true);
      setPrimeTranscriptTarget(session);
      setLoadRevision((current) => current + 1);
      setControlsRevision((current) => current + 1);
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
      if (target.parentID) setLoadFailed(true);
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [primeAPI, runtimeReady, setPrimeTranscriptTarget, target.parentID, targetIdentityKey]);

  React.useEffect(() => {
    if (!primeAPI) return;
    if (target.parentID && runtimeReady && !isAttached) return;
    const requestedIdentity = useUIStore.getState().primeTranscriptTarget?.identity;
    if (!requestedIdentity || identityKey(requestedIdentity) !== targetIdentityKey) return;
    const abortController = new AbortController();
    const requestedIdentityKey = targetIdentityKey;
    const startingActivityRevision = activityRevisionRef.current;
    let cancelled = false;
    setLoadFailed(false);
    void primeAPI.getTranscript(requestedIdentity, abortController.signal).then((result) => {
      if (cancelled || identityKey(useUIStore.getState().primeTranscriptTarget?.identity) !== requestedIdentityKey) return;
      setTranscript(result);
      const activityIsCurrent = activityRevisionRef.current === startingActivityRevision;
      if (activityIsCurrent) {
        setActivity(result.session.activity);
      }
      const currentTarget = useUIStore.getState().primeTranscriptTarget;
      const nextSummary = !activityIsCurrent && currentTarget && identityKey(currentTarget.identity) === requestedIdentityKey
        ? { ...result.session, activity: currentTarget.activity }
        : result.session;
      if (
        currentTarget
        && identityKey(currentTarget.identity) === requestedIdentityKey
        && (
          currentTarget.title !== nextSummary.title
          || currentTarget.directory !== nextSummary.directory
          || currentTarget.updatedAt !== nextSummary.updatedAt
          || currentTarget.activity !== nextSummary.activity
          || currentTarget.interactive !== nextSummary.interactive
        )
      ) {
        setPrimeTranscriptTarget(nextSummary);
      }
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
      if (identityKey(useUIStore.getState().primeTranscriptTarget?.identity) === requestedIdentityKey) {
        setLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [isAttached, loadRevision, primeAPI, runtimeReady, setPrimeTranscriptTarget, target.parentID, targetIdentityKey]);

  React.useLayoutEffect(() => {
    const scrollContainer = transcriptScrollRef.current;
    if (!scrollContainer || !transcript || !followLatestRef.current) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [controls, transcript]);

  React.useEffect(() => {
    const scrollContainer = transcriptScrollRef.current;
    const content = transcriptContentRef.current;
    if (!scrollContainer || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    observer.observe(content);
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [targetIdentityKey]);

  React.useEffect(() => {
    if (!primeAPI || !runtimeReady) return;
    const requestedIdentity = useUIStore.getState().primeTranscriptTarget?.identity;
    if (!requestedIdentity || identityKey(requestedIdentity) !== targetIdentityKey) return;
    const abortController = new AbortController();
    const requestedIdentityKey = targetIdentityKey;
    let cancelled = false;
    setControlsLoadFailed(false);
    void primeAPI.getSessionControls(requestedIdentity, abortController.signal).then((result) => {
      if (cancelled || identityKey(useUIStore.getState().primeTranscriptTarget?.identity) !== requestedIdentityKey) return;
      setControls(result);
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
      if (identityKey(useUIStore.getState().primeTranscriptTarget?.identity) === requestedIdentityKey) {
        setControlsLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [controlsRevision, primeAPI, runtimeReady, targetIdentityKey]);

  React.useEffect(() => {
    if (!primeAPI) return;
    const refreshNow = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setLoadRevision((current) => current + 1);
    };
    const subscription = primeAPI.subscribe((event) => {
      if (event.type === 'runtime-changed') {
        if (event.status.interactive) {
          refreshNow();
          setControlsRevision((current) => current + 1);
        }
        return;
      }
      if (event.type === 'stream-ready') {
        refreshNow();
        setControlsRevision((current) => current + 1);
        return;
      }
      if (event.sessionID !== targetID) return;
      activityRevisionRef.current += 1;
      setActivity(event.activity);
      const currentTarget = useUIStore.getState().primeTranscriptTarget;
      if (currentTarget && identityKey(currentTarget.identity) === targetIdentityKey && currentTarget.activity !== event.activity) {
        setPrimeTranscriptTarget({ ...currentTarget, activity: event.activity });
      }
      if (event.activity === 'idle') {
        refreshNow();
        setControlsRevision((current) => current + 1);
      } else if (!refreshTimerRef.current) {
        refreshTimerRef.current = setTimeout(refreshNow, LIVE_TRANSCRIPT_REFRESH_MS);
      }
    });
    return () => {
      subscription.close();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [primeAPI, setPrimeTranscriptTarget, targetID, targetIdentityKey]);

  const composerCommands = React.useMemo(() => {
    const commandsByName = new Map<string, PrimeComposerCommand>();
    for (const command of [...PRIME_SESSION_COMMANDS, ...(controls?.commands ?? [])]) {
      if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
    }
    return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [controls?.commands]);
  const slashCommandQuery = prompt.match(/^\/([^\s/]*)$/)?.[1].toLowerCase() ?? null;
  const matchingCommands = slashCommandQuery === null || commandsDismissed
    ? []
    : composerCommands.filter((command) => command.name.toLowerCase().includes(slashCommandQuery)).slice(0, 12);
  const visibleCommandIndex = matchingCommands.length > 0
    ? Math.min(selectedCommandIndex, matchingCommands.length - 1)
    : 0;

  React.useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashCommandQuery]);

  const selectCommand = (command: PrimeComposerCommand) => {
    setPrompt(`/${command.name}${command.argumentHint ? ' ' : ''}`);
    setCommandsDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const changeControl = async (change: PrimeControlChange) => {
    if (!primeAPI || updatingControl) return;
    const ownsTarget = () => isMountedRef.current
      && identityKey(useUIStore.getState().primeTranscriptTarget?.identity) === targetIdentityKey;
    setUpdatingControl(change.kind);
    try {
      if (change.kind === 'model') {
        await primeAPI.setSessionModel({
          identity: targetIdentity,
          provider: change.model.provider,
          modelID: change.model.id,
        });
      } else {
        await primeAPI.setSessionThinkingLevel({ identity: targetIdentity, level: change.level });
      }
      if (!ownsTarget()) return;
      setControls((current) => {
        if (!current) return current;
        if (change.kind === 'model') return { ...current, model: change.model };
        return { ...current, thinkingLevel: change.level };
      });
      setControlsRevision((current) => current + 1);
    } catch (error) {
      if (!ownsTarget()) return;
      if (isAmbiguousMutationError(error)) {
        setControlsRevision((current) => current + 1);
        toast.warning(t('prime.composer.ambiguous'));
      } else {
        toast.error(t('common.unavailable'));
      }
    } finally {
      if (ownsTarget()) setUpdatingControl(null);
    }
  };

  const changeModel = (model: PrimeModel) => changeControl({ kind: 'model', model });
  const changeThinkingLevel = (level: PrimeThinkingLevel) => changeControl({ kind: 'thinking', level });

  const openPrimeSettings = () => {
    if (mobileAppActions) {
      mobileAppActions.openSettings('general');
      return;
    }
    setSettingsPage('general');
    setSettingsDialogOpen(true);
  };

  const sendPrompt = async () => {
    const nextPrompt = prompt.trim();
    if (!targetIdentity || !targetIdentityKey || !primeAPI || !runtimeReady || !nextPrompt || isSending) return;
    const operationID = sendOperationRef.current + 1;
    sendOperationRef.current = operationID;
    const ownsOperation = () => isMountedRef.current
      && sendOperationRef.current === operationID
      && identityKey(useUIStore.getState().primeTranscriptTarget?.identity) === targetIdentityKey;
    const markPromptAsDispatched = () => {
      if (!ownsOperation()) return;
      setPrompt('');
      activityRevisionRef.current += 1;
      setActivity('working');
      setLoadRevision((current) => current + 1);
    };
    setIsSending(true);
    try {
      await primeAPI.sendPrompt({ identity: targetIdentity, prompt: nextPrompt });
      markPromptAsDispatched();
    } catch (error) {
      if (!ownsOperation()) return;
      if (isAmbiguousMutationError(error)) {
        markPromptAsDispatched();
        toast.warning(t('prime.composer.ambiguous'));
      } else {
        toast.error(t('prime.composer.sendFailed'));
      }
    } finally {
      if (ownsOperation()) setIsSending(false);
    }
  };

  const abortSession = async () => {
    if (!targetIdentity || !targetIdentityKey || !primeAPI || !runtimeReady || isAborting) return;
    const operationID = abortOperationRef.current + 1;
    abortOperationRef.current = operationID;
    const ownsOperation = () => isMountedRef.current
      && abortOperationRef.current === operationID
      && identityKey(useUIStore.getState().primeTranscriptTarget?.identity) === targetIdentityKey;
    setIsAborting(true);
    try {
      await primeAPI.abortSession(targetIdentity);
      if (ownsOperation()) setLoadRevision((current) => current + 1);
    } catch (error) {
      if (!ownsOperation()) return;
      if (isAmbiguousMutationError(error)) toast.warning(t('prime.composer.ambiguous'));
      else toast.error(t('prime.composer.abortFailed'));
    } finally {
      if (ownsOperation()) setIsAborting(false);
    }
  };

  const copyItem = async (item: PrimeTranscriptItem) => {
    const result = await copyTextToClipboard(item.text);
    if (!result.ok) return;
    setCopiedItemID(item.id);
    window.setTimeout(() => setCopiedItemID((current) => current === item.id ? null : current), 2_000);
  };

  return (
    <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">
      <div
        ref={transcriptScrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight <= 48) {
            followLatestRef.current = true;
          }
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) followLatestRef.current = false;
        }}
        onTouchStart={() => {
          followLatestRef.current = false;
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) followLatestRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
            followLatestRef.current = false;
          }
        }}
      >
        <div ref={transcriptContentRef} className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 sm:px-8">
          <div className="flex self-center items-center gap-1.5 rounded-full bg-[var(--surface-elevated)] px-2.5 py-1 typography-micro text-muted-foreground">
            <Icon name="chat-ai-3" className="h-4 w-4" />
            <span>Prime Agent</span>
            {(activity === 'working' || !runtimeReady) && <span aria-hidden>·</span>}
            {activity === 'working' && <span>{t('prime.status.working')}</span>}
            {activity !== 'working' && !runtimeReady && <span>{t('prime.transcript.readOnly')}</span>}
          </div>

          {!transcript && !loadFailed && (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              <span>{t('common.loading')}</span>
            </div>
          )}

          {loadFailed && !transcript && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <span>{t('common.unavailable')}</span>
              <Button variant="outline" size="sm" onClick={() => setLoadRevision((current) => current + 1)}>
                {t('sessions.sidebar.group.empty.retry')}
              </Button>
            </div>
          )}

          {loadFailed && transcript && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-[var(--surface-muted)] px-3 py-2 text-xs text-muted-foreground">
              <span>{t('common.unavailable')}</span>
              <Button variant="ghost" size="xs" onClick={() => setLoadRevision((current) => current + 1)}>
                {t('sessions.sidebar.group.empty.retry')}
              </Button>
            </div>
          )}

          {transcript && transcript.items.length > visibleItemCount && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisibleItemCount((count) => Math.min(transcript.items.length, count + INITIAL_VISIBLE_ITEMS))}
              >
                {t('chat.history.loadOlder')}
              </Button>
            </div>
          )}

          {transcript?.items.slice(-visibleItemCount).map((item) => {
            if (item.role === 'reasoning') {
              return (
                <ReasoningTimelineBlock
                  key={item.id}
                  text={item.text}
                  variant="thinking"
                  blockId={`prime:${targetIdentityKey}:${item.id}`}
                  isStreaming={item.streaming}
                />
              );
            }
            if (item.role === 'tool' || (item.role === 'system' && item.label === 'agent_message')) {
              return <PrimeToolPart key={item.id} item={item} />;
            }
            const timestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
            const formattedTime = Number.isFinite(timestamp)
              ? formatDateTimeForPreference(timestamp, timeFormatPreference, { hour: 'numeric', minute: '2-digit' })
              : null;
            const showAssistantMetadata = item.role === 'assistant';
            return (
              <article
                key={item.id}
                className={cn('group/message w-full rounded-xl px-4 py-3', transcriptItemClass(item))}
              >
                {item.label && (
                  <div className="mb-2 truncate font-mono text-[11px] text-muted-foreground">{item.label}</div>
                )}
                <SimpleMarkdownRenderer
                  content={item.text}
                  variant="assistant"
                  className="typography-markdown-body"
                  enableFileReferences={false}
                />
                <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground/70">
                  {showAssistantMetadata && item.modelID ? (
                    <span className="inline-flex items-center gap-1" title={item.providerID ?? undefined}>
                      <Icon name="chat-ai-3" className="size-3" />
                      {item.modelID}
                    </span>
                  ) : null}
                  {showAssistantMetadata && item.reasoningEffort ? (
                    <span className="inline-flex items-center gap-1">
                      <Icon name="brain-ai-3" className="size-3" />
                      {item.reasoningEffort}
                    </span>
                  ) : null}
                  {item.usage ? (
                    <span className="tabular-nums">
                      {t('contextUsage.tooltip.usedTokens', {
                        tokens: item.usage.totalTokens.toLocaleString(getCurrentIntlLocale()),
                      })}
                    </span>
                  ) : null}
                  {item.usage?.cost !== null && item.usage?.cost !== undefined ? (
                    <span className="tabular-nums">
                      {new Intl.NumberFormat(getCurrentIntlLocale(), {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: item.usage.cost < 0.01 ? 4 : 2,
                        maximumFractionDigits: item.usage.cost < 0.01 ? 4 : 2,
                      }).format(item.usage.cost)}
                    </span>
                  ) : null}
                  {formattedTime ? <span className="tabular-nums">{formattedTime}</span> : null}
                  <span className="min-w-0 flex-1" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 bg-transparent text-muted-foreground opacity-0 hover:!bg-transparent hover:text-foreground group-hover/message:opacity-100 focus-visible:opacity-100"
                        aria-label={t('chat.messageBody.actions.copyMessageAria')}
                        onClick={() => void copyItem(item)}
                      >
                        <Icon name={copiedItemID === item.id ? 'check' : 'file-copy'} className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                  </Tooltip>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/70 bg-background px-4 py-3 sm:px-8">
        <div className="mx-auto w-full max-w-[920px]">
          {runtimeReady ? (
            <form
              className="relative flex flex-col gap-1 rounded-[var(--radius-xl)] border border-border/80 bg-[var(--surface-elevated)] p-2 focus-within:ring-1 focus-within:ring-primary/50"
              onSubmit={(event) => {
                event.preventDefault();
                void sendPrompt();
              }}
            >
              {matchingCommands.length > 0 && (
                <div
                  role="listbox"
                  aria-label={t('commandPalette.title')}
                  className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-30 max-h-72 overflow-y-auto rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-1 shadow-lg"
                >
                  {matchingCommands.map((command, index) => (
                    <button
                      key={command.name}
                      type="button"
                      role="option"
                      className={cn(
                        'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left typography-ui-label',
                        index === visibleCommandIndex && 'bg-interactive-hover',
                      )}
                      aria-selected={index === visibleCommandIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCommand(command)}
                    >
                      <span className="shrink-0 font-mono text-foreground">
                        /{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ''}
                      </span>
                      {command.description ? (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{command.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              <Textarea
                ref={textareaRef}
                simple
                rows={2}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setCommandsDismissed(false);
                }}
                onKeyDown={(event) => {
                  if (matchingCommands.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setSelectedCommandIndex((current) => (current + 1) % matchingCommands.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setSelectedCommandIndex((current) => (current - 1 + matchingCommands.length) % matchingCommands.length);
                      return;
                    }
                    if ((event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
                      event.preventDefault();
                      const command = matchingCommands[visibleCommandIndex];
                      if (command) selectCommand(command);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setCommandsDismissed(true);
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void sendPrompt();
                  }
                }}
                placeholder={t('prime.composer.placeholder')}
                disabled={isSending}
                className="min-h-12 py-2"
              />
              <div className="flex min-w-0 items-center gap-1.5">
                {controls ? (
                  <PrimeControlSelectors
                    controls={controls}
                    model={controls.model}
                    thinkingLevel={controls.thinkingLevel}
                    disabled={updatingControl !== null}
                    onModelChange={(model) => void changeModel(model)}
                    onThinkingLevelChange={(level) => void changeThinkingLevel(level)}
                  />
                ) : controlsLoadFailed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setControlsRevision((current) => current + 1)}
                        aria-label={t('sessions.sidebar.group.empty.retry')}
                      >
                        <Icon name="refresh" className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('common.unavailable')}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Icon name="loader-4" className="ml-2 size-3.5 animate-spin text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1" />
                {activity === 'working' && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    disabled={isAborting}
                    onClick={() => void abortSession()}
                    aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                  >
                    <StopIcon className="size-4" />
                  </Button>
                )}
                <Button
                  type="submit"
                  size="icon"
                  disabled={!prompt.trim() || isSending}
                  aria-label={t('chat.chatInput.actions.sendMessageAria')}
                >
                  <Icon name="send-plane-2" className="size-4" />
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-[var(--surface-muted)] px-3 py-2 text-xs text-muted-foreground">
              <span>{statusPending
                ? t('common.loading')
                : runtimeStatus?.message ?? t('prime.unavailable.description')}</span>
              {!statusPending && (
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="ghost" size="xs" onClick={retryStatus}>
                    {t('sessions.sidebar.group.empty.retry')}
                  </Button>
                  <Button type="button" variant="outline" size="xs" onClick={openPrimeSettings}>
                    {t('helpDialog.item.openSettings')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const PrimeTranscriptView: React.FC = () => {
  const target = useUIStore((state) => state.primeTranscriptTarget);
  if (!target) return null;
  return <PrimeTranscriptSession key={identityKey(target.identity)} target={target} />;
};
