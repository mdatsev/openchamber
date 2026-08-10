import { create } from 'zustand';

import type {
  PrimeContextResponse,
  PrimeIssue,
  PrimeLiveSnapshot,
  PrimeLiveTranscriptBlock,
  PrimeLiveTranscriptRecord,
  PrimeTranscriptBlock,
  PrimeTranscriptMessage,
  PrimeTranscriptResponse,
  RuntimeAPIs,
} from '@/lib/api/types';
import { serializeChatIdentity, type ChatIdentity } from '@/lib/chat-identity';
import type {
  TranscriptMessage,
  TranscriptPart,
  TranscriptToolPart,
} from '@/components/chat/transcript/types';

export type PrimeTranscriptAvailability = 'unresolved' | 'loading' | 'ready' | 'unavailable';

export type PrimeTranscriptSnapshot = Readonly<{
  key: string;
  identity: ChatIdentity;
  availability: PrimeTranscriptAvailability;
  revision: string | null;
  messages: TranscriptMessage[];
  complete: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  truncated: boolean;
  oversizedOmitted: number;
  issues: PrimeIssue[];
  contextAvailability: PrimeTranscriptAvailability;
  context: PrimeContextResponse | null;
  contextIssues: PrimeIssue[];
  source: 'passive' | 'live';
  liveDesired: boolean;
  liveGeneration: string | null;
  liveRevision: number | null;
  liveFreshness: 'inactive' | 'fresh' | 'stale';
  liveIsWorking: boolean;
  liveActiveMessageId: string | null;
}>;

type PrimeTranscriptStore = {
  byKey: ReadonlyMap<string, PrimeTranscriptSnapshot>;
};

type PassiveTranscriptState = {
  records: PrimeTranscriptMessage[];
  messages: TranscriptMessage[];
  revision: string;
  complete: boolean;
  hasOlder: boolean;
  truncated: boolean;
  oversizedOmitted: number;
  issues: PrimeIssue[];
};

const PRIME_TRANSCRIPT_CACHE_LIMIT = 12;
const requestRevisionByKey = new Map<string, number>();
const inFlightByKey = new Map<string, Promise<void>>();
const olderCursorByKey = new Map<string, string>();
const passiveTranscriptByKey = new Map<string, PassiveTranscriptState>();
const liveSnapshotByKey = new Map<string, PrimeLiveSnapshot>();

export const getPrimeTranscriptKey = (identity: ChatIdentity): string => serializeChatIdentity(identity);

const createInitialSnapshot = (identity: ChatIdentity): PrimeTranscriptSnapshot => ({
  key: getPrimeTranscriptKey(identity),
  identity,
  availability: 'unresolved',
  revision: null,
  messages: [],
  complete: false,
  hasOlder: false,
  loadingOlder: false,
  truncated: false,
  oversizedOmitted: 0,
  issues: [],
  contextAvailability: 'unresolved',
  context: null,
  contextIssues: [],
  source: 'passive',
  liveDesired: false,
  liveGeneration: null,
  liveRevision: null,
  liveFreshness: 'inactive',
  liveIsWorking: false,
  liveActiveMessageId: null,
});

export const usePrimeTranscriptStore = create<PrimeTranscriptStore>()(() => ({
  byKey: new Map(),
}));

const updateSnapshot = (
  identity: ChatIdentity,
  update: (previous: PrimeTranscriptSnapshot) => PrimeTranscriptSnapshot,
) => {
  const key = getPrimeTranscriptKey(identity);
  usePrimeTranscriptStore.setState((state) => {
    const previous = state.byKey.get(key) ?? createInitialSnapshot(identity);
    const next = update(previous);
    if (next === previous) return state;
    const byKey = new Map(state.byKey);
    byKey.delete(key);
    byKey.set(key, next);
    while (byKey.size > PRIME_TRANSCRIPT_CACHE_LIMIT) {
      const oldestKey = byKey.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      byKey.delete(oldestKey);
      olderCursorByKey.delete(oldestKey);
      passiveTranscriptByKey.delete(oldestKey);
      liveSnapshotByKey.delete(oldestKey);
      requestRevisionByKey.delete(oldestKey);
    }
    return { byKey };
  });
};

const errorIssue = (error: unknown): PrimeIssue => {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string') {
    return { code: error.code };
  }
  return { code: 'prime_request_failed' };
};

const hashText = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const primeRecordMatchKey = (
  record: PrimeTranscriptMessage | PrimeLiveTranscriptRecord,
): string => JSON.stringify({
  role: record.role,
  name: record.name,
  error: record.error,
  timestamp: record.timestamp,
  toolPresentation: record.toolPresentation,
  blocks: record.blocks,
});

const selectUncommittedLiveRecords = (
  passiveRecords: PrimeTranscriptMessage[],
  liveRecords: PrimeLiveTranscriptRecord[],
): PrimeLiveTranscriptRecord[] => {
  if (passiveRecords.length === 0 || liveRecords.length === 0) return [];
  const remaining = new Map<string, number>();
  for (const record of passiveRecords) {
    const key = primeRecordMatchKey(record);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let lastMatchedIndex = -1;
  for (let index = 0; index < liveRecords.length; index += 1) {
    const key = primeRecordMatchKey(liveRecords[index]);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) continue;
    remaining.set(key, count - 1);
    lastMatchedIndex = index;
  }
  return lastMatchedIndex < 0 ? [] : liveRecords.slice(lastMatchedIndex + 1);
};

const adaptToolPresentation = (
  presentation: PrimeTranscriptMessage['toolPresentation'] | PrimeLiveTranscriptRecord['toolPresentation'],
): Record<string, unknown> | undefined => {
  if (!presentation) return undefined;
  return {
    ...(presentation.durationMs === undefined ? {} : { durationMs: presentation.durationMs }),
    ...(presentation.diffFiles === undefined ? {} : {
      files: presentation.diffFiles.map((file) => ({
        relativePath: file.path,
        patch: file.patch,
        additions: file.additions,
        deletions: file.deletions,
        openable: file.openable,
      })),
    }),
    ...(presentation.omittedDiffs === undefined ? {} : { ipythonDiffsOmitted: presentation.omittedDiffs }),
  };
};

const adaptBlock = (
  block: PrimeTranscriptBlock | PrimeLiveTranscriptBlock,
  partId: string,
  toolStatus = 'completed',
  timestamp?: number,
): TranscriptPart => {
  if (block.type === 'text') {
    return { id: partId, kind: 'text', text: block.text };
  }
  if (block.type === 'thinking') {
    return { id: partId, kind: 'reasoning', text: block.text ?? '' };
  }
  if (block.type === 'tool_call') {
    const input = 'input' in block ? block.input : undefined;
    const isIPython = block.name.trim().toLowerCase() === 'ipython';
    return {
      id: partId,
      kind: 'tool',
      tool: block.name,
      state: {
        status: toolStatus,
        time: typeof timestamp === 'number'
          ? { start: timestamp, ...(toolStatus === 'completed' ? { end: timestamp } : {}) }
          : undefined,
        input,
        metadata: {
          ...('omitted' in block && block.omitted ? { omitted: true } : {}),
          ...(isIPython && input ? { inputLanguage: 'python' } : {}),
        },
      },
    } satisfies TranscriptToolPart;
  }
  return {
    id: partId,
    kind: 'tool',
    tool: block.reason,
    state: {
      status: toolStatus,
      time: typeof timestamp === 'number'
        ? { start: timestamp, ...(toolStatus === 'completed' ? { end: timestamp } : {}) }
        : undefined,
      metadata: {
        omitted: true,
        reason: block.reason,
        ...(block.bytes === undefined ? null : { bytes: block.bytes }),
        ...(block.bytesAtLeast === undefined ? null : { bytesAtLeast: block.bytesAtLeast }),
      },
    },
  } satisfies TranscriptToolPart;
};

const adaptMessage = (
  identity: ChatIdentity,
  response: PrimeTranscriptResponse,
  message: PrimeTranscriptMessage,
  index: number,
  pageSeed: string,
  parentId?: string,
): TranscriptMessage => {
  const fingerprint = hashText(JSON.stringify(message));
  const messageId = `prime-${message.id ?? `${pageSeed}-${index}-${fingerprint}`}`;
  const parts = message.blocks.map((block, blockIndex) => adaptBlock(
    block,
    `${messageId}-part-${blockIndex}`,
    'completed',
    message.timestamp,
  ));
  const promptPreview = message.role === 'user'
    ? message.blocks
        .filter((block): block is Extract<PrimeTranscriptBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 240) || undefined
    : undefined;
  return {
    id: messageId,
    sessionId: getPrimeTranscriptKey(identity),
    role: message.role,
    parentId,
    createdAt: message.timestamp,
    completedAt: message.timestamp,
    finish: 'stop',
    status: 'completed',
    promptPreview,
    hidden: message.role === 'tool',
    toolResult: message.role === 'tool'
      ? {
          name: message.name,
          error: message.error === true,
          output: message.blocks
            .filter((block): block is Extract<PrimeTranscriptBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
          metadata: adaptToolPresentation(message.toolPresentation),
        }
      : undefined,
    parts,
  };
};

const adaptPage = (
  identity: ChatIdentity,
  response: PrimeTranscriptResponse,
  pageSeed: string,
): TranscriptMessage[] => {
  let activeUserMessageId: string | undefined;
  const messages = response.messages.map((message, index) => {
    const adapted = adaptMessage(
      identity,
      response,
      message,
      index,
      pageSeed,
      message.role === 'assistant' ? activeUserMessageId : undefined,
    );
    if (message.role === 'user') activeUserMessageId = adapted.id;
    return adapted;
  });
  return pairTranscriptToolResults(linkTranscriptTurns(identity, messages));
};

const linkTranscriptTurns = (
  identity: ChatIdentity,
  inputMessages: TranscriptMessage[],
): TranscriptMessage[] => {
  const messages = inputMessages.filter((message) => !(message.synthetic && message.userMessageMarker));
  const firstAssistantIndex = messages.findIndex((message) => message.role === 'assistant');
  const hasLeadingOrphanAssistant = firstAssistantIndex >= 0
    && !messages.slice(0, firstAssistantIndex).some((message) => message.role === 'user');
  if (hasLeadingOrphanAssistant) {
    const firstAssistant = messages[firstAssistantIndex];
    const anchorSeed = `${getPrimeTranscriptKey(identity)}:${firstAssistant.id}`;
    messages.splice(firstAssistantIndex, 0, {
      id: `prime-synthetic-turn-${hashText(anchorSeed)}`,
      sessionId: getPrimeTranscriptKey(identity),
      role: 'user',
      createdAt: firstAssistant.createdAt,
      completedAt: firstAssistant.createdAt,
      finish: 'stop',
      status: 'completed',
      synthetic: true,
      userMessageMarker: true,
      parts: [],
    });
  }

  let activeUserMessageId: string | undefined;
  return messages.map((message) => {
    if (message.role === 'user') {
      activeUserMessageId = message.id;
      return message;
    }
    if (message.role !== 'assistant' || message.parentId === activeUserMessageId) return message;
    return { ...message, parentId: activeUserMessageId };
  });
};

const pairTranscriptToolResults = (messages: TranscriptMessage[]): TranscriptMessage[] => {
  const projected: TranscriptMessage[] = [];
  const pending: Array<{ messageIndex: number; partIndex: number; name: string }> = [];
  for (const sourceMessage of messages) {
    if (sourceMessage.role === 'user') pending.length = 0;
    if (sourceMessage.toolResult) {
      const resultName = sourceMessage.toolResult.name?.trim().toLowerCase() ?? '';
      const pendingIndex = resultName
        ? pending.findIndex((candidate) => candidate.name === resultName)
        : (pending.length > 0 ? 0 : -1);
      if (pendingIndex !== -1) {
        const [match] = pending.splice(pendingIndex, 1);
        const owner = projected[match.messageIndex];
        const part = owner?.parts[match.partIndex];
        if (owner && part?.kind === 'tool') {
          const metadata = sourceMessage.toolResult.metadata
            ? { ...part.state.metadata, ...sourceMessage.toolResult.metadata }
            : part.state.metadata;
          const state = sourceMessage.toolResult.error
            ? {
                ...part.state,
                status: 'error',
                metadata,
                error: sourceMessage.toolResult.output,
                time: {
                  ...part.state.time,
                  end: sourceMessage.createdAt ?? part.state.time?.start,
                },
              }
            : {
                ...part.state,
                status: 'completed',
                output: sourceMessage.toolResult.output,
                metadata,
                time: {
                  ...part.state.time,
                  end: sourceMessage.createdAt ?? part.state.time?.start,
                },
              };
          const parts = owner.parts.slice();
          parts[match.partIndex] = { ...part, state };
          projected[match.messageIndex] = { ...owner, parts };
        }
      }
      projected.push(sourceMessage.hidden ? sourceMessage : { ...sourceMessage, hidden: true });
      continue;
    }

    const parts = sourceMessage.parts.map((part) => {
      if (part.kind !== 'tool') return part;
      const state = { ...part.state };
      delete state.output;
      delete state.error;
      return { ...part, state };
    });
    const message = parts.some((part, index) => part !== sourceMessage.parts[index])
      ? { ...sourceMessage, parts }
      : sourceMessage;
    const messageIndex = projected.length;
    projected.push(message);
    parts.forEach((part, partIndex) => {
      if (part.kind !== 'tool' || typeof part.state.metadata?.reason === 'string') return;
      pending.push({
        messageIndex,
        partIndex,
        name: part.tool.trim().toLowerCase(),
      });
    });
  }
  return projected;
};

const adaptLiveRecord = (
  identity: ChatIdentity,
  record: PrimeLiveTranscriptRecord,
  messageId: string,
  completed: boolean,
): TranscriptMessage => {
  const promptPreview = record.role === 'user'
    ? record.blocks
        .filter((block): block is Extract<PrimeLiveTranscriptBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 240) || undefined
    : undefined;
  return {
    id: messageId,
    sessionId: getPrimeTranscriptKey(identity),
    role: record.role,
    createdAt: record.timestamp,
    completedAt: completed ? record.timestamp : undefined,
    finish: completed ? (record.stopReason ?? 'stop') : undefined,
    status: completed ? 'completed' : 'pending',
    promptPreview,
    hidden: record.role === 'tool',
    toolResult: record.role === 'tool'
      ? {
          name: record.name,
          error: record.error === true,
          output: record.blocks
            .filter((block): block is Extract<PrimeLiveTranscriptBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
          metadata: adaptToolPresentation(record.toolPresentation),
        }
      : undefined,
    parts: record.blocks.map((block, blockIndex) => adaptBlock(
      block,
      `${messageId}-part-${blockIndex}`,
      completed ? 'completed' : 'running',
      record.timestamp,
    )),
  };
};

const adaptLiveSnapshotMessages = (
  identity: ChatIdentity,
  snapshot: PrimeLiveSnapshot,
  records: PrimeLiveTranscriptRecord[],
): { messages: TranscriptMessage[]; activeMessageId: string | null } => {
  const occurrences = new Map<string, number>();
  const messages = records.map((record) => {
    const fingerprint = hashText(JSON.stringify(record));
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    return adaptLiveRecord(identity, record, `prime-live-${fingerprint}-${occurrence}`, true);
  });
  let activeMessageId: string | null = null;
  if (snapshot.transcript.streamingRecord) {
    activeMessageId = `prime-live-stream-${snapshot.generation}`;
    messages.push(adaptLiveRecord(
      identity,
      snapshot.transcript.streamingRecord,
      activeMessageId,
      false,
    ));
  }
  return { messages, activeMessageId };
};

const liveContextResponse = (snapshot: PrimeLiveSnapshot): PrimeContextResponse => ({
  schemaVersion: 1,
  sessionId: snapshot.sessionId,
  revision: `live:${snapshot.generation}:${snapshot.revision}`,
  usage: snapshot.context.usage
    ?? (snapshot.context.known && typeof snapshot.context.tokens === 'number'
      ? { totalTokens: snapshot.context.tokens }
      : {}),
  ...(snapshot.context.known && typeof snapshot.context.tokens === 'number'
    ? {
        window: {
          used: snapshot.context.tokens,
          limit: snapshot.context.contextWindow,
          ...(typeof snapshot.context.percent === 'number'
            ? { percent: snapshot.context.percent }
            : {}),
        },
      }
    : {}),
  truncated: false,
});

export const beginPrimeLiveTranscript = (identity: ChatIdentity) => {
  const key = getPrimeTranscriptKey(identity);
  requestRevisionByKey.set(key, (requestRevisionByKey.get(key) ?? 0) + 1);
  updateSnapshot(identity, (previous) => ({
    ...previous,
    liveDesired: true,
    liveFreshness: previous.source === 'live' ? 'stale' : previous.liveFreshness,
    liveIsWorking: false,
    liveActiveMessageId: null,
  }));
};

export const commitPrimeLiveTranscript = (
  identity: ChatIdentity,
  snapshot: PrimeLiveSnapshot,
) => {
  if (snapshot.sessionId !== identity.sessionId) return;
  const key = getPrimeTranscriptKey(identity);
  const current = usePrimeTranscriptStore.getState().byKey.get(key);
  if (!current?.liveDesired
    || (current.liveGeneration === snapshot.generation
      && current.liveRevision !== null
      && snapshot.revision < current.liveRevision)) return;
  liveSnapshotByKey.set(key, snapshot);
  const passive = passiveTranscriptByKey.get(key);
  const liveRecords = passive
    ? selectUncommittedLiveRecords(passive.records, snapshot.transcript.records)
    : snapshot.transcript.records;
  const projection = adaptLiveSnapshotMessages(identity, snapshot, liveRecords);
  const messages = pairTranscriptToolResults(linkTranscriptTurns(identity, [
    ...(passive?.messages ?? []),
    ...projection.messages,
  ]));
  const omittedOlderRecords = snapshot.transcript.omittedOlderRecords;
  const freshnessIssue: PrimeIssue[] = snapshot.freshness.state === 'stale'
    ? [{ code: `prime_live_${snapshot.freshness.reason}`, sessionId: identity.sessionId }]
    : [];
  updateSnapshot(identity, (previous) => ({
    ...previous,
    availability: 'ready',
    revision: passive?.revision ?? `live:${snapshot.generation}:${snapshot.revision}`,
    messages,
    complete: passive?.complete ?? false,
    hasOlder: passive?.hasOlder ?? false,
    loadingOlder: false,
    truncated: passive?.truncated ?? omittedOlderRecords > 0,
    oversizedOmitted: passive?.oversizedOmitted ?? omittedOlderRecords,
    issues: [
      ...(passive?.issues ?? []),
      ...freshnessIssue,
      ...(!passive && omittedOlderRecords > 0
        ? [{ code: 'prime_live_transcript_older_omitted', sessionId: identity.sessionId }]
        : []),
    ],
    contextAvailability: 'ready',
    context: liveContextResponse(snapshot),
    contextIssues: freshnessIssue,
    source: 'live',
    liveGeneration: snapshot.generation,
    liveRevision: snapshot.revision,
    liveFreshness: snapshot.freshness.state,
    liveIsWorking: snapshot.freshness.state === 'fresh' && snapshot.turn.active,
    liveActiveMessageId: projection.activeMessageId,
  }));
};

export const markPrimeLiveTranscriptStale = (identity: ChatIdentity, code: string) => {
  updateSnapshot(identity, (previous) => {
    if (!previous.liveDesired || previous.source !== 'live') return previous;
    const issue = { code, sessionId: identity.sessionId };
    return {
      ...previous,
      issues: [...previous.issues.filter((candidate) => candidate.code !== code), issue],
      contextIssues: [...previous.contextIssues.filter((candidate) => candidate.code !== code), issue],
      liveFreshness: 'stale',
      liveIsWorking: false,
      liveActiveMessageId: null,
    };
  });
};

export const endPrimeLiveTranscript = (identity: ChatIdentity) => {
  liveSnapshotByKey.delete(getPrimeTranscriptKey(identity));
  updateSnapshot(identity, (previous) => ({
    ...previous,
    liveDesired: false,
    liveFreshness: 'inactive',
    liveIsWorking: false,
    liveActiveMessageId: null,
  }));
};

const transcriptIssues = (response: PrimeTranscriptResponse): PrimeIssue[] => {
  const issues: PrimeIssue[] = [];
  if (response.page.truncated) issues.push({ code: 'prime_transcript_truncated', sessionId: response.sessionId });
  if (response.page.oversizedOmitted > 0) issues.push({ code: 'prime_transcript_messages_omitted', sessionId: response.sessionId });
  return issues;
};

const commitRecentTranscript = (
  identity: ChatIdentity,
  response: PrimeTranscriptResponse,
) => {
  const key = getPrimeTranscriptKey(identity);
  if (response.page.olderCursor) {
    olderCursorByKey.set(key, response.page.olderCursor);
  } else {
    olderCursorByKey.delete(key);
  }
  const messages = adaptPage(identity, response, 'recent');
  const passive: PassiveTranscriptState = {
    records: response.messages,
    messages,
    revision: response.revision,
    complete: !response.page.hasOlder && !response.page.truncated,
    hasOlder: response.page.hasOlder,
    truncated: response.page.truncated,
    oversizedOmitted: response.page.oversizedOmitted,
    issues: transcriptIssues(response),
  };
  passiveTranscriptByKey.set(key, passive);
  updateSnapshot(identity, (previous) => ({
    ...previous,
    availability: 'ready',
    revision: passive.revision,
    messages: passive.messages,
    complete: passive.complete,
    hasOlder: passive.hasOlder,
    loadingOlder: false,
    truncated: passive.truncated,
    oversizedOmitted: passive.oversizedOmitted,
    issues: passive.issues,
    source: 'passive',
    liveGeneration: null,
    liveRevision: null,
    liveFreshness: 'inactive',
    liveIsWorking: false,
    liveActiveMessageId: null,
  }));
};

export const loadPrimeTranscript = (identity: ChatIdentity, apis: RuntimeAPIs): Promise<void> => {
  const key = getPrimeTranscriptKey(identity);
  if (usePrimeTranscriptStore.getState().byKey.get(key)?.liveDesired) return Promise.resolve();
  const existing = inFlightByKey.get(key);
  if (existing) return existing;
  const revision = (requestRevisionByKey.get(key) ?? 0) + 1;
  requestRevisionByKey.set(key, revision);
  updateSnapshot(identity, (previous) => ({
    ...previous,
    availability: 'loading',
    issues: [],
    contextAvailability: 'loading',
    contextIssues: [],
  }));

  const request = (async () => {
    const [transcriptResult, contextResult] = await Promise.allSettled([
      apis.prime.getTranscript(identity.sessionId),
      apis.prime.getContext(identity.sessionId),
    ]);
    if (requestRevisionByKey.get(key) !== revision) return;

    if (transcriptResult.status === 'fulfilled' && transcriptResult.value.sessionId === identity.sessionId) {
      commitRecentTranscript(identity, transcriptResult.value);
    } else {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        availability: 'unavailable',
        complete: false,
        loadingOlder: false,
        issues: [transcriptResult.status === 'rejected'
          ? errorIssue(transcriptResult.reason)
          : { code: 'prime_response_session_mismatch' }],
      }));
    }

    if (contextResult.status === 'fulfilled' && contextResult.value.sessionId === identity.sessionId) {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        contextAvailability: 'ready',
        context: contextResult.value,
        contextIssues: contextResult.value.truncated
          ? [{ code: 'prime_context_truncated', sessionId: identity.sessionId }]
          : [],
      }));
    } else {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        contextAvailability: 'unavailable',
        contextIssues: [contextResult.status === 'rejected'
          ? errorIssue(contextResult.reason)
          : { code: 'prime_response_session_mismatch' }],
      }));
    }
  })();
  inFlightByKey.set(key, request);
  void request.finally(() => {
    if (inFlightByKey.get(key) === request) inFlightByKey.delete(key);
  });
  return request;
};

export const resumePrimePassiveTranscript = async (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  endPrimeLiveTranscript(identity);
  const key = getPrimeTranscriptKey(identity);
  const pending = inFlightByKey.get(key);
  if (pending) await pending;
  await loadPrimeTranscript(identity, apis);
};

export const loadEarlierPrimeTranscript = async (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<void> => {
  const key = getPrimeTranscriptKey(identity);
  const cursor = olderCursorByKey.get(key);
  if (!cursor) return;
  const snapshot = usePrimeTranscriptStore.getState().byKey.get(key);
  if (!snapshot || snapshot.loadingOlder) return;
  updateSnapshot(identity, (previous) => ({ ...previous, loadingOlder: true }));
  try {
    const response = await apis.prime.getTranscript(identity.sessionId, { cursor });
    if (response.sessionId !== identity.sessionId) {
      throw Object.assign(new Error('prime_response_session_mismatch'), {
        code: 'prime_response_session_mismatch',
      });
    }
    const current = usePrimeTranscriptStore.getState().byKey.get(key);
    if (!current || current.revision !== response.revision) {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        complete: false,
        loadingOlder: false,
        issues: [...previous.issues, { code: 'prime_transcript_revision_changed', sessionId: identity.sessionId }],
      }));
      return;
    }
    if (response.page.olderCursor) {
      olderCursorByKey.set(key, response.page.olderCursor);
    } else {
      olderCursorByKey.delete(key);
    }
    const passive = passiveTranscriptByKey.get(key);
    if (!passive || passive.revision !== response.revision) {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        complete: false,
        loadingOlder: false,
        issues: [...previous.issues, { code: 'prime_transcript_revision_changed', sessionId: identity.sessionId }],
      }));
      return;
    }
    const olderMessages = adaptPage(identity, response, hashText(cursor));
    const existingIds = new Set(passive.messages.map((message) => message.id));
    const nextPassive: PassiveTranscriptState = {
      records: [...response.messages, ...passive.records],
      messages: pairTranscriptToolResults(linkTranscriptTurns(identity, [
        ...olderMessages.filter((message) => !existingIds.has(message.id)),
        ...passive.messages,
      ])),
      revision: passive.revision,
      complete: !response.page.hasOlder && !response.page.truncated,
      hasOlder: response.page.hasOlder,
      truncated: passive.truncated || response.page.truncated,
      oversizedOmitted: passive.oversizedOmitted + response.page.oversizedOmitted,
      issues: [...passive.issues, ...transcriptIssues(response)],
    };
    passiveTranscriptByKey.set(key, nextPassive);
    const liveSnapshot = liveSnapshotByKey.get(key);
    if (liveSnapshot && current.liveDesired) {
      commitPrimeLiveTranscript(identity, liveSnapshot);
    } else {
      updateSnapshot(identity, (previous) => ({
        ...previous,
        messages: nextPassive.messages,
        complete: nextPassive.complete,
        hasOlder: nextPassive.hasOlder,
        loadingOlder: false,
        truncated: nextPassive.truncated,
        oversizedOmitted: nextPassive.oversizedOmitted,
        issues: nextPassive.issues,
      }));
    }
  } catch (error) {
    updateSnapshot(identity, (previous) => ({
      ...previous,
      complete: false,
      loadingOlder: false,
      issues: [...previous.issues, errorIssue(error)],
    }));
  }
};
