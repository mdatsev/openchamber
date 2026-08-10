import type {
  PrimeAPI,
  PrimeCatalogResponse,
  PrimeContextResponse,
  PrimeCreationRequest,
  PrimeCreationResponse,
  PrimeIssue,
  PrimeLiveActivationResponse,
  PrimeLiveDeactivationResponse,
  PrimeLiveEventPayload,
  PrimeLiveSnapshot,
  PrimeLiveStreamEvent,
  PrimeLiveTranscriptBlock,
  PrimeLiveTranscriptRecord,
  PrimeModel,
  PrimeMutationResponse,
  PrimeStatusResponse,
  PrimeThinkingLevel,
  PrimeTranscriptBlock,
  PrimeTranscriptMessage,
  PrimeTranscriptResponse,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isIssue = (value: unknown): value is PrimeIssue => isRecord(value)
  && typeof value.code === 'string'
  && (value.message === undefined || typeof value.message === 'string')
  && (value.sessionId === undefined || typeof value.sessionId === 'string');

const isIssueList = (value: unknown): value is PrimeIssue[] => (
  Array.isArray(value) && value.every(isIssue)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isNonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);

const isStatusResponse = (value: unknown): value is PrimeStatusResponse => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.supported === 'boolean'
  && (value.availability === 'ready' || value.availability === 'unavailable')
  && (value.protocolVersion === undefined || isFiniteNumber(value.protocolVersion))
  && (value.schemaRevision === undefined || isFiniteNumber(value.schemaRevision))
  && isIssueList(value.issues);

const isCatalogResponse = (value: unknown): value is PrimeCatalogResponse => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.revision === 'string'
  && typeof value.complete === 'boolean'
  && isIssueList(value.issues)
  && Array.isArray(value.sessions)
  && value.sessions.every((session) => isRecord(session)
    && typeof session.sessionId === 'string'
    && typeof session.title === 'string'
    && (session.parentSessionId === null || typeof session.parentSessionId === 'string')
    && typeof session.rootSessionId === 'string'
    && (session.workingDirectory === undefined || typeof session.workingDirectory === 'string')
    && (session.createdAt === undefined || isFiniteNumber(session.createdAt))
    && (session.updatedAt === undefined || isFiniteNumber(session.updatedAt))
    && (session.residency === 'working' || session.residency === 'idle' || session.residency === 'inactive')
    && (session.availability === 'ready' || session.availability === 'unavailable'));

const isBoundedCodeInput = (value: unknown): value is { code: string } => isRecord(value)
  && Object.keys(value).length === 1
  && typeof value.code === 'string'
  && new TextEncoder().encode(value.code).byteLength <= 64 * 1024;

const isPrimeIpythonToolPresentation = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !['durationMs', 'diffFiles', 'omittedDiffs'].includes(key))) return false;
  if (value.durationMs !== undefined
    && (!isFiniteNumber(value.durationMs) || value.durationMs < 0 || value.durationMs > 24 * 60 * 60 * 1000)) return false;
  if (value.omittedDiffs !== undefined && !isNonNegativeInteger(value.omittedDiffs)) return false;
  if (value.diffFiles !== undefined) {
    if (!Array.isArray(value.diffFiles) || value.diffFiles.length > 64) return false;
    let patchBytes = 0;
    for (const file of value.diffFiles) {
      if (!isRecord(file)
        || Object.keys(file).some((key) => !['path', 'patch', 'additions', 'deletions', 'openable'].includes(key))
        || typeof file.path !== 'string'
        || file.path.length === 0
        || file.path.length > 512
        || typeof file.patch !== 'string'
        || !isNonNegativeInteger(file.additions)
        || !isNonNegativeInteger(file.deletions)
        || typeof file.openable !== 'boolean') return false;
      patchBytes += new TextEncoder().encode(file.patch).byteLength;
      if (patchBytes > 256 * 1024) return false;
    }
  }
  return true;
};

const isTranscriptBlock = (value: unknown): value is PrimeTranscriptBlock => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text' || value.type === 'thinking') return typeof value.text === 'string';
  if (value.type === 'tool_call') return typeof value.name === 'string'
    && (value.input === undefined || isBoundedCodeInput(value.input))
    && (value.omitted === undefined || value.omitted === true);
  return value.type === 'omitted'
    && typeof value.reason === 'string'
    && (value.bytes === undefined || isFiniteNumber(value.bytes))
    && (value.bytesAtLeast === undefined || isFiniteNumber(value.bytesAtLeast));
};

const isTranscriptMessage = (value: unknown): value is PrimeTranscriptMessage => isRecord(value)
  && value.type === 'message'
  && (value.id === undefined || typeof value.id === 'string')
  && ['user', 'assistant', 'tool', 'system', 'custom'].includes(String(value.role))
  && (value.name === undefined || typeof value.name === 'string')
  && (value.error === undefined || typeof value.error === 'boolean')
  && (value.timestamp === undefined || isFiniteNumber(value.timestamp))
  && (value.toolPresentation === undefined || (
    value.role === 'tool'
    && String(value.name).trim().toLowerCase() === 'ipython'
    && isPrimeIpythonToolPresentation(value.toolPresentation)
  ))
  && (value.omitted === undefined || typeof value.omitted === 'boolean')
  && Array.isArray(value.blocks)
  && value.blocks.every(isTranscriptBlock);

const isTranscriptResponse = (value: unknown): value is PrimeTranscriptResponse => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && typeof value.revision === 'string'
  && Array.isArray(value.messages)
  && value.messages.every(isTranscriptMessage)
  && isRecord(value.page)
  && (value.page.olderCursor === null || typeof value.page.olderCursor === 'string')
  && typeof value.page.hasOlder === 'boolean'
  && typeof value.page.truncated === 'boolean'
  && isFiniteNumber(value.page.oversizedOmitted);

const CONTEXT_USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'cost',
] as const;
const isContextUsage = (value: unknown): boolean => isRecord(value)
  && Object.keys(value).every((key) => CONTEXT_USAGE_KEYS.includes(key as typeof CONTEXT_USAGE_KEYS[number]))
  && CONTEXT_USAGE_KEYS.every((key) => (
    value[key] === undefined || (isFiniteNumber(value[key]) && value[key] >= 0)
  ));

const isContextResponse = (value: unknown): value is PrimeContextResponse => isRecord(value)
  && Object.keys(value).every((key) => ['schemaVersion', 'sessionId', 'revision', 'usage', 'window', 'truncated'].includes(key))
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && typeof value.revision === 'string'
  && isContextUsage(value.usage)
  && (value.window === undefined || (
    isRecord(value.window)
    && Object.keys(value.window).every((key) => ['used', 'limit', 'percent'].includes(key))
    && isNonNegativeNumber(value.window.used)
    && (value.window.limit === undefined || isNonNegativeNumber(value.window.limit))
    && (value.window.percent === undefined || isNonNegativeNumber(value.window.percent))
  ))
  && typeof value.truncated === 'boolean';

const isNonNegativeNumber = (value: unknown): value is number => (
  isFiniteNumber(value) && value >= 0
);

const THINKING_LEVELS = new Set<PrimeThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const isThinkingLevel = (value: unknown): value is PrimeThinkingLevel => (
  typeof value === 'string' && THINKING_LEVELS.has(value as PrimeThinkingLevel)
);
const hasOnlyKeys = (value: JsonRecord, allowed: readonly string[]): boolean => (
  Object.keys(value).every((key) => allowed.includes(key))
);
const PUBLIC_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isBoundedCreationSelector = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0
  && value === value.trim()
  && value.length <= 160
  && ![...value].some((character) => (
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  ));
const isCreationRequest = (value: unknown): value is PrimeCreationRequest => {
  if (!isRecord(value)
    || typeof value.workingDirectory !== 'string'
    || value.workingDirectory.trim().length === 0
    || new TextEncoder().encode(value.workingDirectory).byteLength > 16 * 1024
    || typeof value.message !== 'string'
    || !value.message.trim()
    || new TextEncoder().encode(value.message).byteLength > 256 * 1024) return false;
  const configured = Object.hasOwn(value, 'sourceSessionId');
  if (!configured) return Object.keys(value).length === 2
    && hasOnlyKeys(value, ['workingDirectory', 'message']);
  const expected = value.thinkingLevel === undefined
    ? ['workingDirectory', 'message', 'sourceSessionId', 'generation', 'revision', 'provider', 'modelId']
    : ['workingDirectory', 'message', 'sourceSessionId', 'generation', 'revision', 'provider', 'modelId', 'thinkingLevel'];
  return Object.keys(value).length === expected.length
    && hasOnlyKeys(value, expected)
    && typeof value.sourceSessionId === 'string'
    && PUBLIC_SESSION_ID.test(value.sourceSessionId)
    && typeof value.generation === 'string'
    && SAFE_FENCE_ID.test(value.generation)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && isBoundedCreationSelector(value.provider)
    && isBoundedCreationSelector(value.modelId)
    && (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel));
};
const isCreationResponse = (value: unknown): value is PrimeCreationResponse => isRecord(value)
  && hasOnlyKeys(value, ['schemaVersion', 'sessionId', 'accepted'])
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && value.sessionId.length > 0
  && value.accepted === true;
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
const STALE_REASONS = new Set([
  'deactivated',
  'disconnected',
  'identity_changed',
  'protocol_error',
  'reconnecting',
  'reconnect_failed',
  'resynchronizing',
  'sequence_gap',
  'snapshot_failed',
]);

const isLiveTranscriptBlock = (value: unknown): value is PrimeLiveTranscriptBlock => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'thinking') return (value.text === undefined || typeof value.text === 'string')
    && (value.redacted === undefined || value.redacted === true)
    && (typeof value.text === 'string' || value.redacted === true);
  if (value.type === 'tool_call') return typeof value.name === 'string'
    && (value.input === undefined || isBoundedCodeInput(value.input))
    && (value.omitted === undefined || value.omitted === true);
  return value.type === 'omitted'
    && typeof value.reason === 'string'
    && (value.bytes === undefined || isNonNegativeNumber(value.bytes))
    && (value.bytesAtLeast === undefined || isNonNegativeNumber(value.bytesAtLeast))
    && (value.blocksOmitted === undefined || isNonNegativeInteger(value.blocksOmitted));
};

const isLiveTranscriptRecord = (value: unknown): value is PrimeLiveTranscriptRecord => isRecord(value)
  && ['user', 'assistant', 'tool', 'system', 'custom'].includes(String(value.role))
  && (value.name === undefined || typeof value.name === 'string')
  && (value.error === undefined || typeof value.error === 'boolean')
  && (value.timestamp === undefined || isFiniteNumber(value.timestamp))
  && (value.toolPresentation === undefined || (
    value.role === 'tool'
    && String(value.name).trim().toLowerCase() === 'ipython'
    && isPrimeIpythonToolPresentation(value.toolPresentation)
  ))
  && (value.stopReason === undefined || STOP_REASONS.has(String(value.stopReason)))
  && Array.isArray(value.blocks)
  && value.blocks.every(isLiveTranscriptBlock);

const isLiveTurn = (value: unknown): value is PrimeLiveSnapshot['turn'] => isRecord(value)
  && typeof value.token === 'string'
  && value.token.length > 0
  && typeof value.active === 'boolean';

const isLiveFreshness = (value: unknown): value is PrimeLiveSnapshot['freshness'] => {
  if (!isRecord(value) || !isNonNegativeNumber(value.observedAt)) return false;
  if (value.state === 'fresh') return value.reason === undefined;
  return value.state === 'stale' && STALE_REASONS.has(String(value.reason));
};

const isLiveStatus = (value: unknown): value is PrimeLiveSnapshot['status'] => isRecord(value)
  && ['working', 'idle', 'unknown'].includes(String(value.activity))
  && (value.recap === undefined || typeof value.recap === 'string');

const isLiveContext = (value: unknown): value is PrimeLiveSnapshot['context'] => {
  if (!isRecord(value)
    || typeof value.known !== 'boolean'
    || !Object.keys(value).every((key) => ['known', 'tokens', 'contextWindow', 'percent', 'usage'].includes(key))
    || (value.usage !== undefined && !isContextUsage(value.usage))) return false;
  if (!value.known) return value.tokens === undefined
    && value.contextWindow === undefined
    && value.percent === undefined;
  return (value.tokens === null || isNonNegativeNumber(value.tokens))
    && isNonNegativeNumber(value.contextWindow)
    && (value.percent === null || isNonNegativeNumber(value.percent));
};

const isPrimeModel = (value: unknown): value is PrimeModel => isRecord(value)
  && hasOnlyKeys(value, ['id', 'provider', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens'])
  && typeof value.id === 'string'
  && typeof value.provider === 'string'
  && (value.name === undefined || typeof value.name === 'string')
  && typeof value.reasoning === 'boolean'
  && Array.isArray(value.input)
  && value.input.every((input) => input === 'text' || input === 'image')
  && (value.contextWindow === undefined || isNonNegativeNumber(value.contextWindow))
  && (value.maxTokens === undefined || isNonNegativeNumber(value.maxTokens));

const isLiveConfiguration = (value: unknown): value is PrimeLiveSnapshot['configuration'] => isRecord(value)
  && hasOnlyKeys(value, ['currentModel', 'models', 'thinking'])
  && (value.currentModel === undefined || isPrimeModel(value.currentModel))
  && Array.isArray(value.models)
  && value.models.length <= 256
  && value.models.every(isPrimeModel)
  && isRecord(value.thinking)
  && hasOnlyKeys(value.thinking, ['current', 'available'])
  && (value.thinking.current === undefined || isThinkingLevel(value.thinking.current))
  && Array.isArray(value.thinking.available)
  && value.thinking.available.every(isThinkingLevel);

const isLiveCapabilities = (value: unknown): value is PrimeLiveSnapshot['capabilities'] => isRecord(value)
  && typeof value.mutations === 'boolean'
  && isRecord(value.actions)
  && typeof value.actions.canSend === 'boolean'
  && typeof value.actions.canAbort === 'boolean'
  && typeof value.actions.canChangeModel === 'boolean'
  && Array.isArray(value.tools)
  && value.tools.length <= 256
  && value.tools.every((tool) => typeof tool === 'string');

const isLiveSnapshot = (value: unknown): value is PrimeLiveSnapshot => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && typeof value.generation === 'string'
  && value.generation.length > 0
  && isNonNegativeInteger(value.revision)
  && isLiveTurn(value.turn)
  && isLiveFreshness(value.freshness)
  && isLiveStatus(value.status)
  && isRecord(value.transcript)
  && Array.isArray(value.transcript.records)
  && value.transcript.records.every(isLiveTranscriptRecord)
  && isNonNegativeInteger(value.transcript.sourceMessageCount)
  && isNonNegativeInteger(value.transcript.omittedOlderRecords)
  && (value.transcript.streamingRecord === undefined
    || isLiveTranscriptRecord(value.transcript.streamingRecord))
  && isLiveContext(value.context)
  && isLiveConfiguration(value.configuration)
  && isLiveCapabilities(value.capabilities);

const isActivationResponse = (value: unknown): value is PrimeLiveActivationResponse => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && value.active === true
  && isLiveSnapshot(value.snapshot)
  && value.snapshot.sessionId === value.sessionId;

const isDeactivationResponse = (value: unknown): value is PrimeLiveDeactivationResponse => isRecord(value)
  && value.schemaVersion === 1
  && typeof value.sessionId === 'string'
  && value.active === false
  && (value.snapshot === undefined || (isLiveSnapshot(value.snapshot) && value.snapshot.sessionId === value.sessionId));

const isLiveEventPayload = (value: unknown): value is PrimeLiveEventPayload => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'activity') return value.activity === 'working' || value.activity === 'idle';
  if (value.type === 'message') return ['start', 'update', 'end'].includes(String(value.phase))
    && isLiveTranscriptRecord(value.record);
  if (value.type === 'tool') return ['start', 'update', 'end'].includes(String(value.phase))
    && (value.name === undefined || typeof value.name === 'string')
    && (value.error === undefined || value.error === true);
  if (value.type === 'thinking') return isThinkingLevel(value.current);
  if (value.type === 'status') return value.recap === undefined || typeof value.recap === 'string';
  return value.type === 'state_changed';
};

const isLiveStreamEvent = (value: unknown): value is PrimeLiveStreamEvent => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'snapshot') return isLiveSnapshot(value.snapshot);
  if (value.type === 'closed') return typeof value.sessionId === 'string';
  const common = typeof value.sessionId === 'string'
    && typeof value.generation === 'string'
    && isNonNegativeInteger(value.revision)
    && isLiveTurn(value.turn)
    && isLiveFreshness(value.freshness);
  if (!common) return false;
  if (value.type === 'event') return isLiveEventPayload(value.event);
  return value.type === 'freshness' && isLiveStatus(value.status);
};

const SAFE_FENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const isMutationAuthority = (value: unknown): boolean => isRecord(value)
  && hasOnlyKeys(value, ['generation', 'revision', 'turnToken'])
  && typeof value.generation === 'string'
  && SAFE_FENCE_ID.test(value.generation)
  && isNonNegativeInteger(value.revision)
  && value.revision >= 1
  && typeof value.turnToken === 'string'
  && SAFE_FENCE_ID.test(value.turnToken);

const isMutationResponseFor = (
  value: unknown,
  action: PrimeMutationResponse['action'],
): value is PrimeMutationResponse => {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.sessionId !== 'string'
    || value.action !== action
    || value.accepted !== true
    || (value.authority !== undefined && !isMutationAuthority(value.authority))) return false;
  if (action === 'prompt' || action === 'abort') {
    return hasOnlyKeys(value, ['schemaVersion', 'sessionId', 'action', 'accepted', 'authority']);
  }
  if (!hasOnlyKeys(value, ['schemaVersion', 'sessionId', 'action', 'accepted', 'authority', 'result'])
    || !isRecord(value.result)) return false;
  if (action === 'set_model') {
    return hasOnlyKeys(value.result, ['model'])
      && isRecord(value.result.model)
      && hasOnlyKeys(value.result.model, ['provider', 'id'])
      && typeof value.result.model.provider === 'string'
      && typeof value.result.model.id === 'string';
  }
  return hasOnlyKeys(value.result, ['thinkingLevel'])
    && isThinkingLevel(value.result.thinkingLevel);
};

class PrimeAPIRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'PrimeAPIRequestError';
    this.status = status;
    this.code = code;
  }
}

const requestPrimeJson = async <T>(
  path: string,
  validate: (value: unknown) => value is T,
  query?: Record<string, string | number | undefined>,
  init: RequestInit = {},
): Promise<T> => {
  const response = await runtimeFetch(path, {
    ...init,
    query,
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Accept: 'application/json' },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
      ? payload.error.code
      : 'prime_request_failed';
    throw new PrimeAPIRequestError(response.status, code);
  }
  if (!validate(payload)) {
    throw new PrimeAPIRequestError(502, 'prime_invalid_response');
  }
  return payload;
};

const requestPrimeMutation = async (
  sessionId: string,
  route: string,
  action: PrimeMutationResponse['action'],
  request: object,
): Promise<PrimeMutationResponse> => {
  const response = await requestPrimeJson(
    `/api/prime/sessions/${encodeURIComponent(sessionId)}/${route}`,
    (value): value is PrimeMutationResponse => isMutationResponseFor(value, action),
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  if (response.sessionId !== sessionId) {
    throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
  }
  return response;
};

const MAX_SSE_FRAME_CHARS = 6 * 1024 * 1024;
const MAX_SSE_BUFFER_CHARS = MAX_SSE_FRAME_CHARS + 64 * 1024;

const parseSseFrame = (frame: string): PrimeLiveStreamEvent | null => {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') eventName = value;
    if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  if (!['snapshot', 'event', 'freshness', 'closed'].includes(eventName)) {
    throw new PrimeAPIRequestError(502, 'prime_invalid_event_stream');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    throw new PrimeAPIRequestError(502, 'prime_invalid_event_stream');
  }
  if (!isLiveStreamEvent(payload) || payload.type !== eventName) {
    throw new PrimeAPIRequestError(502, 'prime_invalid_event_stream');
  }
  return payload;
};

const readPrimeEventStream = async (
  response: Response,
  signal: AbortSignal,
  onEvent: (event: PrimeLiveStreamEvent) => void,
): Promise<void> => {
  if (!response.body) throw new PrimeAPIRequestError(502, 'prime_event_stream_unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw new PrimeAPIRequestError(502, 'prime_event_frame_too_large');
      }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimiter.length);
        if (frame.length > MAX_SSE_FRAME_CHARS) {
          throw new PrimeAPIRequestError(502, 'prime_event_frame_too_large');
        }
        const event = parseSseFrame(frame);
        if (event) onEvent(event);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !buffer.trim().startsWith(':')) {
      throw new PrimeAPIRequestError(502, 'prime_invalid_event_stream');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or aborted.
    }
    reader.releaseLock();
  }
};

const openPrimeEvents = async (
  sessionId: string,
  signal: AbortSignal,
  onEvent: (event: PrimeLiveStreamEvent) => void,
): Promise<void> => {
  const response = await runtimeFetch(
    `/api/prime/sessions/${encodeURIComponent(sessionId)}/events`,
    { signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' },
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
      ? payload.error.code
      : 'prime_event_stream_failed';
    throw new PrimeAPIRequestError(response.status, code);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    throw new PrimeAPIRequestError(502, 'prime_invalid_event_stream');
  }
  await readPrimeEventStream(response, signal, (event) => {
    if (event.type === 'snapshot' ? event.snapshot.sessionId !== sessionId : event.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    onEvent(event);
  });
};

export const createWebPrimeAPI = (): PrimeAPI => ({
  create: (request: PrimeCreationRequest) => {
    if (!isCreationRequest(request)) {
      throw new PrimeAPIRequestError(400, 'prime_invalid_creation_request');
    }
    const body = request.sourceSessionId === undefined
      ? { workingDirectory: request.workingDirectory, message: request.message }
      : {
          workingDirectory: request.workingDirectory,
          message: request.message,
          sourceSessionId: request.sourceSessionId,
          generation: request.generation,
          revision: request.revision,
          provider: request.provider,
          modelId: request.modelId,
          ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        };
    return requestPrimeJson('/api/prime/sessions', isCreationResponse, undefined, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  getStatus: () => requestPrimeJson('/api/prime/status', isStatusResponse),
  getCatalog: () => requestPrimeJson('/api/prime/catalog', isCatalogResponse),
  getTranscript: async (sessionId, options = {}) => {
    const response = await requestPrimeJson(
      `/api/prime/sessions/${encodeURIComponent(sessionId)}/transcript`,
      isTranscriptResponse,
      {
        cursor: options.cursor,
        limit: options.limit,
        byteLimit: options.byteLimit,
      },
    );
    if (response.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    return response;
  },
  getContext: async (sessionId) => {
    const response = await requestPrimeJson(
      `/api/prime/sessions/${encodeURIComponent(sessionId)}/context`,
      isContextResponse,
    );
    if (response.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    return response;
  },
  activate: async (sessionId) => {
    const response = await requestPrimeJson(
      `/api/prime/sessions/${encodeURIComponent(sessionId)}/activate`,
      isActivationResponse,
      undefined,
      { method: 'POST' },
    );
    if (response.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    return response;
  },
  deactivate: async (sessionId) => {
    const response = await requestPrimeJson(
      `/api/prime/sessions/${encodeURIComponent(sessionId)}/deactivate`,
      isDeactivationResponse,
      undefined,
      { method: 'POST' },
    );
    if (response.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    return response;
  },
  getSnapshot: async (sessionId) => {
    const response = await requestPrimeJson(
      `/api/prime/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      isLiveSnapshot,
    );
    if (response.sessionId !== sessionId) {
      throw new PrimeAPIRequestError(502, 'prime_response_session_mismatch');
    }
    return response;
  },
  openEvents: (sessionId, options) => openPrimeEvents(sessionId, options.signal, options.onEvent),
  prompt: (sessionId, request) => requestPrimeMutation(sessionId, 'prompt', 'prompt', request),
  abort: (sessionId, request) => requestPrimeMutation(sessionId, 'abort', 'abort', request),
  setModel: (sessionId, request) => requestPrimeMutation(sessionId, 'model', 'set_model', request),
  setThinkingLevel: (sessionId, request) => requestPrimeMutation(
    sessionId,
    'thinking-level',
    'set_thinking_level',
    request,
  ),
});
