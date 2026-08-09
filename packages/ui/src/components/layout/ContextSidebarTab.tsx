import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';

import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { Icon } from "@/components/icon/Icon";
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { computeCacheHitRate } from '@/stores/utils/tokenUtils';
import { useSessions, useSessionMessageRecords } from '@/sync/sync-context';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import {
  derivePartsLabel,
  deriveUserSnippet,
  formatAssistantTokens,
  formatMessagePreviewTime,
} from './rawMessagePreview';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PrimeSessionSummary, PrimeTranscript } from '@/lib/api/types';

type SessionMessage = { info: Message; parts: Part[] };

type ProviderModelLike = {
  id?: string;
  name?: string;
  limit?: { context?: number };
};

type ProviderLike = {
  id?: string;
  name?: string;
  models?: ProviderModelLike[];
};

type TokenBreakdown = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type ContextBuckets = {
  user: number;
  assistant: number;
  tool: number;
  other: number;
};

const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

const EMPTY_BUCKETS: ContextBuckets = {
  user: 0,
  assistant: 0,
  tool: 0,
  other: 0,
};

const toNonNegativeNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

const extractTokenBreakdown = (message: SessionMessage): TokenBreakdown => {
  const tokenCandidate = (message.info as { tokens?: unknown }).tokens;
  const source =
    tokenCandidate !== undefined
      ? tokenCandidate
      : (message.parts.find((part) => (part as { tokens?: unknown }).tokens !== undefined) as { tokens?: unknown } | undefined)?.tokens;

  if (typeof source === 'number') {
    return {
      ...EMPTY_BREAKDOWN,
      total: toNonNegativeNumber(source),
    };
  }

  if (!source || typeof source !== 'object') {
    return EMPTY_BREAKDOWN;
  }

  const breakdown = source as {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };

  const input = toNonNegativeNumber(breakdown.input);
  const output = toNonNegativeNumber(breakdown.output);
  const reasoning = toNonNegativeNumber(breakdown.reasoning);
  const cacheRead = toNonNegativeNumber(breakdown.cache?.read);
  const cacheWrite = toNonNegativeNumber(breakdown.cache?.write);

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
};

const pickString = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
};

const estimateTextLength = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTextLength(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + estimateTextLength(item), 0);
  }
  return 0;
};

const estimatePartChars = (part: Part, role: 'user' | 'assistant' | 'tool' | 'other'): ContextBuckets => {
  const partRecord = part as Record<string, unknown>;
  const type = typeof partRecord.type === 'string' ? partRecord.type : '';

  if (type === 'reasoning') {
    return {
      ...EMPTY_BUCKETS,
      assistant: estimateTextLength(partRecord.text) + estimateTextLength(partRecord.content),
    };
  }

  const directText = pickString(
    partRecord.text,
    partRecord.content,
    partRecord.value,
    (partRecord.source as { value?: unknown; text?: { value?: unknown } } | undefined)?.value,
    (partRecord.source as { value?: unknown; text?: { value?: unknown } } | undefined)?.text?.value,
  );

  if (type === 'tool' || role === 'tool') {
    const toolInputOutputLength =
      estimateTextLength(partRecord.input)
      + estimateTextLength(partRecord.output)
      + estimateTextLength(partRecord.error)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.input)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.output)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.error);

    const toolPayloadLength =
      toolInputOutputLength
      + estimateTextLength(partRecord.raw)
      + Math.round(estimateTextLength(partRecord.metadata) * 0.25)
      + Math.round(estimateTextLength(partRecord.state) * 0.1);

    return { user: 0, assistant: 0, tool: toolPayloadLength, other: 0 };
  }

  if (role === 'user') {
    return { user: directText.length, assistant: 0, tool: 0, other: 0 };
  }

  if (role === 'assistant') {
    return { user: 0, assistant: directText.length, tool: 0, other: 0 };
  }

  return { user: 0, assistant: 0, tool: 0, other: directText.length };
};

const addBuckets = (target: ContextBuckets, value: ContextBuckets): ContextBuckets => ({
  user: target.user + value.user,
  assistant: target.assistant + value.assistant,
  tool: target.tool + value.tool,
  other: target.other + value.other,
});

const deriveRoleBucket = (message: SessionMessage): 'user' | 'assistant' | 'tool' | 'other' => {
  const roleInfo = deriveMessageRole(message.info);
  if (roleInfo.isUser) return 'user';
  if (roleInfo.role === 'assistant') return 'assistant';
  if (roleInfo.role === 'tool') return 'tool';
  return 'other';
};

const computeContextBreakdown = (
  sessionMessages: SessionMessage[],
  systemPrompt: string,
): ContextBuckets => {
  if (sessionMessages.length === 0) {
    return { ...EMPTY_BUCKETS };
  }

  const totalChars = sessionMessages.reduce<ContextBuckets>((acc, message) => {
    const role = deriveRoleBucket(message);
    let bucket = { ...EMPTY_BUCKETS };
    for (const part of message.parts) {
      bucket = addBuckets(bucket, estimatePartChars(part, role));
    }
    return addBuckets(acc, bucket);
  }, { ...EMPTY_BUCKETS });

  totalChars.user += systemPrompt.length;

  return {
    user: Math.ceil(totalChars.user / 4),
    assistant: Math.ceil(totalChars.assistant / 4),
    tool: Math.ceil(totalChars.tool / 4),
    other: Math.ceil(totalChars.other / 4),
  };
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const formatMoney = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};

const formatDateTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return formatDateTimeForPreference(timestamp, timeFormatPreference, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const resolveProviderAndModel = (
  providers: ProviderLike[],
  providerID: string,
  modelID: string,
): { providerName: string; modelName: string; contextLimit: number | null } => {
  const provider = providers.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID);

  return {
    providerName: provider?.name || providerID || '-',
    modelName: model?.name || modelID || '-',
    contextLimit: typeof model?.limit?.context === 'number' ? model.limit.context : null,
  };
};

const OpenCodeContextPanelContent: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [expandedRawMessages, setExpandedRawMessages] = React.useState<Record<string, boolean>>({});
  const [copiedRawMessageId, setCopiedRawMessageId] = React.useState<string | null>(null);
  const copyResetTimeoutRef = React.useRef<number | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const sessions = useSessions(currentSessionDirectory ?? undefined);
  const sessionMessages = useSessionMessageRecords(
    currentSessionId ?? '',
    currentSessionDirectory ?? undefined,
  );
  const providers = useConfigStore((state) => state.providers);

  React.useEffect(() => {
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setExpandedRawMessages((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setCopiedRawMessageId(null);
  }, [currentSessionDirectory, currentSessionId]);

  React.useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCopyRawMessage = React.useCallback(async (messageId: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) {
      setCopiedRawMessageId(messageId);
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedRawMessageId((prev) => (prev === messageId ? null : prev));
        copyResetTimeoutRef.current = null;
      }, 2000);
    } else {
      setCopiedRawMessageId(null);
    }
  }, []);

  const viewModel = React.useMemo(() => {
    const currentSession = currentSessionId ? sessions.find((session) => session.id === currentSessionId) ?? null : null;

    const assistantMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).role === 'assistant');
    const userMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).isUser);

    let contextMessage: SessionMessage | null = null;
    for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
      const message = assistantMessages[i];
      if (extractTokenBreakdown(message).total > 0) {
        contextMessage = message;
        break;
      }
    }

    const tokenBreakdown = contextMessage ? extractTokenBreakdown(contextMessage) : EMPTY_BREAKDOWN;

    // Cache hit rate for the last assistant message. `input` is the non-cached portion
    // (total input - cache.read - cache.write per SDK's session.ts:getUsage),
    // so hit rate = cache.read / (input + cache.read + cache.write).
    const cacheHitRate = computeCacheHitRate({
      input: tokenBreakdown.input,
      cache: { read: tokenBreakdown.cacheRead, write: tokenBreakdown.cacheWrite },
    });

    const totalAssistantCost = assistantMessages.reduce((sum, message) => {
      const cost = toNonNegativeNumber((message.info as { cost?: unknown }).cost);
      return sum + cost;
    }, 0);

    const latestAssistantInfo = (contextMessage?.info ?? null) as (Message & { providerID?: string; modelID?: string }) | null;
    const providerModel = resolveProviderAndModel(
      providers as ProviderLike[],
      latestAssistantInfo?.providerID || '',
      latestAssistantInfo?.modelID || '',
    );

    const contextLimit = providerModel.contextLimit;
    const usagePercent = contextLimit && contextLimit > 0
      ? Math.min(999, (tokenBreakdown.total / contextLimit) * 100)
      : 0;

    const systemPrompt = ([...sessionMessages].reverse().find(
      (entry) => deriveMessageRole(entry.info).isUser && typeof (entry.info as { system?: unknown }).system === 'string',
    )?.info as { system?: string } | undefined)?.system || '';

    const computedBreakdown = computeContextBreakdown(sessionMessages, systemPrompt);

    const userTokens = computedBreakdown.user;
    const assistantTokens = computedBreakdown.assistant;
    const toolTokens = computedBreakdown.tool;
    const otherTokens = Math.max(0, tokenBreakdown.input - userTokens - assistantTokens - toolTokens);
    const breakdownTotal = userTokens + assistantTokens + toolTokens + otherTokens;

    const firstMessageTs = sessionMessages[0]?.info?.time?.created;
    const lastMessageTs = sessionMessages.length > 0
      ? sessionMessages[sessionMessages.length - 1]?.info?.time?.created
      : null;

    return {
      sessionTitle: currentSession?.title || t('contextSidebar.session.untitled'),
      messagesCount: sessionMessages.length,
      userMessagesCount: userMessages.length,
      assistantMessagesCount: assistantMessages.length,
      createdAt: (currentSession?.time?.created ?? firstMessageTs ?? null) as number | null,
      lastActivityAt: (lastMessageTs ?? currentSession?.time?.created ?? null) as number | null,
      providerModel,
      tokenBreakdown,
      usagePercent,
      cacheHitRate,
      totalAssistantCost,
      contextLimit,
      breakdown: {
        user: userTokens,
        assistant: assistantTokens,
        tool: toolTokens,
        other: otherTokens,
      },
      breakdownTotal,
    };
  }, [currentSessionId, providers, sessionMessages, sessions, t]);

  if (!currentSessionId) {
    return (
        <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {t('contextSidebar.empty.openSession')}
      </div>
    );
  }

  const segments: Array<{ key: string; label: string; value: number; color: string }> = [
    { key: 'user', label: t('contextSidebar.breakdown.user'), value: viewModel.breakdown.user, color: 'var(--status-success)' },
    { key: 'assistant', label: t('contextSidebar.breakdown.assistant'), value: viewModel.breakdown.assistant, color: 'var(--primary-base)' },
    { key: 'tool', label: t('contextSidebar.breakdown.toolCalls'), value: viewModel.breakdown.tool, color: 'var(--status-warning)' },
    { key: 'other', label: t('contextSidebar.breakdown.other'), value: viewModel.breakdown.other, color: 'var(--surface-muted-foreground)' },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">

        {/* ── Session header ── */}
        <div className="mb-6">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">{viewModel.sessionTitle}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>{viewModel.providerModel.providerName} / {viewModel.providerModel.modelName}</span>
            {viewModel.createdAt && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(viewModel.createdAt, timeFormatPreference)}</span>
              </>
            )}
          </div>
        </div>

        {/* ── Context usage ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="typography-micro text-muted-foreground">{t('contextSidebar.section.context')}</span>
            <span className="typography-micro tabular-nums text-muted-foreground/70">
              {formatNumber(viewModel.tokenBreakdown.total)}
              {viewModel.contextLimit ? ` / ${formatNumber(viewModel.contextLimit)}` : ''}
            </span>
          </div>
          <div className="mt-2.5 flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {viewModel.usagePercent > 0 && (
              <div
                className="rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(0.5, viewModel.usagePercent)}%`,
                  backgroundColor: viewModel.usagePercent > 80 ? 'var(--status-warning)' : 'var(--primary-base)',
                }}
              />
            )}
          </div>
          <div className="mt-1.5 typography-micro font-medium tabular-nums text-foreground/80">
            {t('contextSidebar.context.percentUsed', { percent: viewModel.usagePercent.toFixed(1) })}
          </div>
        </div>

        {/* ── Stat grid ── */}
        <div className="mb-5 grid grid-cols-2 gap-2">
          {([
            { label: t('contextSidebar.stats.messages'), value: formatNumber(viewModel.messagesCount) },
            { label: t('contextSidebar.stats.user'), value: formatNumber(viewModel.userMessagesCount) },
            { label: t('contextSidebar.stats.assistant'), value: formatNumber(viewModel.assistantMessagesCount) },
            { label: t('contextSidebar.stats.cost'), value: formatMoney(viewModel.totalAssistantCost) },
          ] as const).map((item) => (
            <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        {/* ── Last turn tokens ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="typography-micro text-muted-foreground mb-2.5">{t('contextSidebar.section.lastAssistantMessage')}</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
            {([
              { label: t('contextSidebar.tokens.input'), value: viewModel.tokenBreakdown.input, format: 'count' },
              { label: t('contextSidebar.tokens.output'), value: viewModel.tokenBreakdown.output, format: 'count' },
              { label: t('contextSidebar.tokens.reasoning'), value: viewModel.tokenBreakdown.reasoning, format: 'count' },
              { label: t('contextSidebar.tokens.cacheRead'), value: viewModel.tokenBreakdown.cacheRead, format: 'count' },
              { label: t('contextSidebar.tokens.cacheWrite'), value: viewModel.tokenBreakdown.cacheWrite, format: 'count' },
              {
                label: t('contextSidebar.tokens.cacheHit'),
                value: viewModel.cacheHitRate.hasInput ? viewModel.cacheHitRate.percent : null,
                format: 'percent',
              },
            ] as const).map((item) => (
              <div key={item.label}>
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                  {item.value !== null && item.value !== undefined
                    ? item.format === 'percent'
                      ? `${item.value.toFixed(1)}%`
                      : formatNumber(item.value)
                    : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Context breakdown ── */}
        <div className="mb-6">
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {segments.map((segment) => {
              if (segment.value <= 0 || viewModel.breakdownTotal <= 0) return null;
              return (
                <div
                  key={segment.key}
                  style={{
                    width: `${(segment.value / viewModel.breakdownTotal) * 100}%`,
                    backgroundColor: segment.color,
                  }}
                />
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {segments.map((segment) => {
              const pct = viewModel.breakdownTotal > 0 ? (segment.value / viewModel.breakdownTotal) * 100 : 0;
              return (
                <div key={segment.key} className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
                  <span className="typography-micro text-muted-foreground/70">
                    {segment.label} <span className="tabular-nums">{pct.toFixed(0)}%</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Raw messages ── */}
        <div>
          <div className="typography-micro text-muted-foreground">{t('contextSidebar.section.rawMessages')}</div>
          <div className="mt-2.5 space-y-1">
            {[...sessionMessages].reverse().map((message) => {
              const roleInfo = deriveMessageRole(message.info);
              const role = roleInfo.role;
              const isAssistant = role === 'assistant';
              const isUser = role === 'user';
              const isExpanded = expandedRawMessages[message.info.id] === true;
              const isCopied = copiedRawMessageId === message.info.id;
              const messageCreatedAt = (message.info.time?.created ?? null) as number | null;
              const partsLabel = derivePartsLabel(message.parts);
              const tokens = isAssistant ? extractTokenBreakdown({ info: message.info, parts: message.parts }) : null;
              const userSnippet = isUser ? deriveUserSnippet(message.parts) : '';
              const previewTime = formatMessagePreviewTime(messageCreatedAt, timeFormatPreference);
              // Keep token/time columns stable; the message label owns all
              // remaining space and truncates before it can push metrics.
              const assistantLeft = partsLabel || '\u2014';
              const assistantMiddle = tokens
                ? formatAssistantTokens(tokens.input, tokens.output, formatNumber)
                : '';
              const otherLeft = role || 'unknown';
              const otherLabel = partsLabel ? `${otherLeft}: ${partsLabel}` : otherLeft;

              const jsonValue = isExpanded
                ? JSON.stringify({ info: message.info, parts: message.parts }, null, 2)
                : '';

              return (
                <div
                  key={message.info.id}
                  className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70"
                >
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setExpandedRawMessages((prev) => ({
                        ...prev,
                        [message.info.id]: !(prev[message.info.id] === true),
                      }));
                    }}
                  >
                    <div
                      className="grid items-center gap-x-2 whitespace-nowrap typography-micro"
                      style={{ gridTemplateColumns: isAssistant ? 'minmax(0, 1fr) 7.5rem max-content' : 'minmax(0, 1fr) max-content' }}
                    >
                      {isUser ? (
                        <span
                          className="min-w-0 truncate text-muted-foreground"
                        >
                          <span className="typography-ui-label text-foreground">user:</span>{' '}
                          {userSnippet}
                        </span>
                      ) : (
                        <>
                          <span
                            className={
                              isAssistant
                                ? 'min-w-0 truncate text-muted-foreground'
                                : 'min-w-0 truncate text-muted-foreground'
                            }
                          >
                            {isAssistant ? assistantLeft : otherLabel}
                          </span>
                          {isAssistant && (
                            <span className="text-right text-muted-foreground tabular-nums">
                              {assistantMiddle}
                            </span>
                          )}
                        </>
                      )}
                      <span className="text-right text-muted-foreground">{previewTime}</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-[var(--surface-subtle)] p-0">
                      <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
                        <div className="absolute top-1 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyRawMessage(message.info.id, jsonValue);
                            }}
                            aria-label={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copyJson')}
                            title={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
                          >
                            {isCopied ? <Icon name="check" className="size-3.5" /> : <Icon name="file-copy" className="size-3.5" />}
                          </button>
                        </div>
                        <WorkerHighlightedCode
                          language="json"
                          code={jsonValue}
                          style={{
                            margin: 0,
                            padding: '0.75rem',
                            background: 'transparent',
                            fontSize: 'var(--text-micro)',
                            lineHeight: '1.35',
                          }}
                          wrap
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

const primeIdentityKey = (target: PrimeSessionSummary) => JSON.stringify([
  target.identity.runtimeKey,
  target.identity.harness,
  target.identity.sessionID,
]);

const PrimeContextPanelContent: React.FC<{ target: PrimeSessionSummary }> = ({ target }) => {
  const { t } = useI18n();
  const primeAPI = useRuntimeAPIs().prime;
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const targetKey = primeIdentityKey(target);
  const [loadedTranscript, setLoadedTranscript] = React.useState<{ key: string; value: PrimeTranscript } | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loadRevision, setLoadRevision] = React.useState(0);
  const [expandedItems, setExpandedItems] = React.useState<Record<string, boolean>>({});
  const [copiedItemID, setCopiedItemID] = React.useState<string | null>(null);
  const transcript = loadedTranscript?.key === targetKey ? loadedTranscript.value : null;

  React.useEffect(() => {
    setExpandedItems({});
    setCopiedItemID(null);
    setLoadFailed(false);
  }, [targetKey]);

  React.useEffect(() => {
    if (!primeAPI) return;
    const abortController = new AbortController();
    let cancelled = false;
    setLoadFailed(false);
    void primeAPI.getTranscript(target.identity, abortController.signal).then((result) => {
      if (!cancelled) setLoadedTranscript({ key: targetKey, value: result });
    }).catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return;
      setLoadFailed(true);
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [loadRevision, primeAPI, target.identity, targetKey]);

  React.useEffect(() => {
    if (!primeAPI) return;
    const subscription = primeAPI.subscribe((event) => {
      if (event.type === 'stream-ready' || event.type === 'runtime-changed') {
        setLoadRevision((current) => current + 1);
      } else if (event.sessionID === target.id && event.activity === 'idle') {
        setLoadRevision((current) => current + 1);
      }
    });
    return () => subscription.close();
  }, [primeAPI, target.id]);

  const viewModel = React.useMemo(() => {
    const items = transcript?.items ?? [];
    const latestMetadataItem = [...items].reverse().find((item) => item.modelID || item.providerID || item.reasoningEffort) ?? null;
    const latestUsage = [...items].reverse().find((item) => item.usage)?.usage ?? null;
    const sourceEntryIDs = new Set(items.map((item) => item.id.split(':', 1)[0]));
    const userEntryIDs = new Set(items.filter((item) => item.role === 'user').map((item) => item.id.split(':', 1)[0]));
    const assistantEntryIDs = new Set(items.filter((item) => item.role === 'assistant' || item.role === 'reasoning').map((item) => item.id.split(':', 1)[0]));
    const totalCost = items.reduce((sum, item) => sum + (item.usage?.cost ?? 0), 0);
    const cacheHitRate = computeCacheHitRate({
      input: latestUsage?.inputTokens ?? 0,
      cache: { read: latestUsage?.cacheReadTokens ?? 0, write: latestUsage?.cacheWriteTokens ?? 0 },
    });
    return {
      items,
      providerID: latestMetadataItem?.providerID ?? null,
      modelID: latestMetadataItem?.modelID ?? null,
      reasoningEffort: latestMetadataItem?.reasoningEffort ?? null,
      latestUsage,
      cacheHitRate,
      totalCost,
      messagesCount: sourceEntryIDs.size,
      userMessagesCount: userEntryIDs.size,
      assistantMessagesCount: assistantEntryIDs.size,
      createdAt: Date.parse(transcript?.session.createdAt ?? target.createdAt),
      updatedAt: Date.parse(transcript?.session.updatedAt ?? target.updatedAt),
    };
  }, [target.createdAt, target.updatedAt, transcript]);

  const handleCopyItem = React.useCallback(async (itemID: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (!result.ok) return;
    setCopiedItemID(itemID);
    window.setTimeout(() => setCopiedItemID((current) => current === itemID ? null : current), 2_000);
  }, []);

  if (!transcript && !loadFailed) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 typography-ui-label text-muted-foreground">
        <Icon name="loader-4" className="size-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  if (!transcript) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center typography-ui-label text-muted-foreground">
        <span>{t('common.unavailable')}</span>
        <button type="button" className="text-primary hover:underline" onClick={() => setLoadRevision((current) => current + 1)}>
          {t('sessions.sidebar.group.empty.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Icon name="chat-ai-3" className="size-4 text-muted-foreground" />
            <h2 className="truncate typography-ui-header font-semibold text-foreground">
              {transcript.session.title || t('contextSidebar.session.untitled')}
            </h2>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>Prime Agent</span>
            {viewModel.providerID || viewModel.modelID ? (
              <>
                <span>&middot;</span>
                <span>{[viewModel.providerID, viewModel.modelID].filter(Boolean).join(' / ')}</span>
              </>
            ) : null}
            {Number.isFinite(viewModel.createdAt) ? (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(viewModel.createdAt, timeFormatPreference)}</span>
              </>
            ) : null}
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground/70">
            <Icon name="folder" className="size-3.5 shrink-0" />
            <span className="truncate" title={transcript.session.directory}>{transcript.session.directory}</span>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2">
          {([
            { label: t('contextSidebar.stats.messages'), value: formatNumber(viewModel.messagesCount) },
            { label: t('contextSidebar.stats.user'), value: formatNumber(viewModel.userMessagesCount) },
            { label: t('contextSidebar.stats.assistant'), value: formatNumber(viewModel.assistantMessagesCount) },
            { label: t('contextSidebar.stats.cost'), value: formatMoney(viewModel.totalCost) },
          ] as const).map((item) => (
            <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="typography-micro text-muted-foreground">{t('contextSidebar.section.lastAssistantMessage')}</div>
            {viewModel.reasoningEffort ? (
              <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground/70">
                <Icon name="brain-ai-3" className="size-3" />
                {viewModel.reasoningEffort}
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
            {([
              { label: t('contextSidebar.tokens.input'), value: viewModel.latestUsage?.inputTokens ?? null, format: 'count' },
              { label: t('contextSidebar.tokens.output'), value: viewModel.latestUsage?.outputTokens ?? null, format: 'count' },
              { label: t('contextSidebar.tokens.cacheRead'), value: viewModel.latestUsage?.cacheReadTokens ?? null, format: 'count' },
              { label: t('contextSidebar.tokens.cacheWrite'), value: viewModel.latestUsage?.cacheWriteTokens ?? null, format: 'count' },
              { label: t('contextSidebar.section.context'), value: viewModel.latestUsage?.totalTokens ?? null, format: 'count' },
              { label: t('contextSidebar.tokens.cacheHit'), value: viewModel.cacheHitRate.hasInput ? viewModel.cacheHitRate.percent : null, format: 'percent' },
            ] as const).map((item) => (
              <div key={item.label}>
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                  {item.value !== null
                    ? item.format === 'percent' ? `${item.value.toFixed(1)}%` : formatNumber(item.value)
                    : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 typography-micro text-muted-foreground">
            <span>{t('contextSidebar.section.rawMessages')}</span>
            {Number.isFinite(viewModel.updatedAt) ? <span>{formatDateTime(viewModel.updatedAt, timeFormatPreference)}</span> : null}
          </div>
          <div className="mt-2.5 space-y-1">
            {[...viewModel.items].reverse().map((item) => {
              const isExpanded = expandedItems[item.id] === true;
              const isCopied = copiedItemID === item.id;
              const timestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
              const jsonValue = isExpanded ? JSON.stringify(item, null, 2) : '';
              return (
                <div key={item.id} className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70">
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedItems((current) => ({ ...current, [item.id]: !current[item.id] }))}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-2 whitespace-nowrap typography-micro">
                      <span className="min-w-0 truncate text-muted-foreground">
                        <span className="typography-ui-label text-foreground">{item.role}:</span>{' '}
                        {item.label || item.text}
                      </span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {Number.isFinite(timestamp) ? formatMessagePreviewTime(timestamp, timeFormatPreference) : ''}
                      </span>
                    </div>
                  </button>
                  {isExpanded ? (
                    <div className="border-t border-[var(--surface-subtle)] p-0">
                      <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
                        <div className="absolute right-2 top-1 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyItem(item.id, jsonValue);
                            }}
                            aria-label={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copyJson')}
                            title={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
                          >
                            <Icon name={isCopied ? 'check' : 'file-copy'} className="size-3.5" />
                          </button>
                        </div>
                        <WorkerHighlightedCode
                          language="json"
                          code={jsonValue}
                          style={{ margin: 0, padding: '0.75rem', background: 'transparent', fontSize: 'var(--text-micro)', lineHeight: '1.35' }}
                          wrap
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export const ContextPanelContent: React.FC = () => {
  const primeTarget = useUIStore((state) => state.primeTranscriptTarget);
  return primeTarget ? <PrimeContextPanelContent target={primeTarget} /> : <OpenCodeContextPanelContent />;
};
