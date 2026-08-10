import {
  normalizePrimeIpythonToolPresentation,
  normalizePrimeToolCallBlock,
  sanitizePrimeIpythonEditOutput,
  shouldSuppressPrimeIpythonEditOutput,
} from './tool-input.js';

const MAX_TEXT_CHARS = 256 * 1024;
const MAX_RECORDS = 1_000;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_BLOCKS = 2_048;
const MAX_AVAILABLE_MODELS = 256;
const MAX_SOURCE_MODELS = 2_000;
const MAX_NAME_CHARS = 160;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);

export const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonNegative = (value) => Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : undefined;
};
const name = (value) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, MAX_NAME_CHARS)
  : undefined;
const textBlock = (type, text) => typeof text !== 'string'
  ? { type: 'omitted', reason: `invalid_${type}` }
  : text.length <= MAX_TEXT_CHARS
    ? { type, text }
    : { type: 'omitted', reason: `${type}_too_large`, bytesAtLeast: Buffer.byteLength(text.slice(0, MAX_TEXT_CHARS)) };

const normalizeBlock = (block) => {
  if (!isRecord(block)) return { type: 'omitted', reason: 'unsupported_block' };
  if (block.type === 'text') return textBlock('text', block.text);
  if (block.type === 'thinking') return block.redacted === true
    ? { type: 'thinking', redacted: true }
    : textBlock('thinking', block.thinking);
  if (block.type === 'toolCall') {
    return normalizePrimeToolCallBlock(block) || { type: 'omitted', reason: 'invalid_tool_call' };
  }
  if (block.type === 'image' || block.type === 'image_url') return { type: 'omitted', reason: 'binary_content' };
  if (block.type === 'omitted' && block.reason === 'ipython_output_too_large') return { type: 'omitted', reason: block.reason };
  return { type: 'omitted', reason: 'unsupported_block' };
};

const normalizeContent = (content) => {
  if (typeof content === 'string') return [textBlock('text', content)];
  if (!Array.isArray(content)) return [{ type: 'omitted', reason: 'unsupported_content' }];
  const blocks = content.slice(0, MAX_BLOCKS).map(normalizeBlock);
  if (content.length > MAX_BLOCKS) {
    blocks.push({ type: 'omitted', reason: 'block_limit', blocksOmitted: content.length - MAX_BLOCKS });
  }
  return blocks;
};

// Never project non-display custom records. The wrapper fallback covers older
// snapshots that lost the original display:false flag during compaction.
const isHiddenPrimeMessage = (message) => isRecord(message)
  && message.role === 'custom'
  && (message.display === false
    || (typeof message.content === 'string' && message.content.startsWith('<ipython_state>')));

const AGENT_MESSAGE_SOURCE = /^\[from (parent|child|sibling)(?::([A-Za-z0-9._-]{1,80}))?\]$/u;

/**
 * Agent-message custom records include private routing/session/command metadata
 * for the receiving model. The transcript needs only the public sender label
 * and body, rendered as ordinary Markdown by the shared message presentation.
 */
export const projectPrimeCustomMessageContent = (content) => {
  if (typeof content !== 'string') return content;
  if (content.startsWith('<ipython_state>')) return null;
  const firstBreak = content.indexOf('\n');
  const source = AGENT_MESSAGE_SOURCE.exec(firstBreak < 0 ? content : content.slice(0, firstBreak));
  if (!source || !content.slice(firstBreak + 1).startsWith('Agent-to-agent message received.')) return content;
  const separator = content.indexOf('\n\n', firstBreak + 1);
  let body = separator < 0 ? '' : content.slice(separator + 2).trim();
  const sender = source[2] || source[1];
  if (/^RLM child .+ \(sub-[0-9a-f]{8}\) completed without sending a reply$/u.test(body)) {
    body = 'Child agent completed without sending a reply.';
  }
  return `**Message from ${sender}**${body ? `\n\n${body}` : ''}`;
};

/** Strip provider signatures/IDs, tool IDs/arguments, private details, paths, and binary bodies. */
export const normalizePrimeMessage = (message, workingDirectory) => {
  if (!isRecord(message)) return { role: 'custom', blocks: [{ type: 'omitted', reason: 'invalid_record' }] };
  let role = message.role;
  let toolName;
  if (role === 'toolResult') {
    role = 'tool';
    toolName = name(message.toolName);
  } else if (!['user', 'assistant', 'system', 'custom'].includes(role)) {
    role = 'custom';
  }
  const recordTimestamp = timestamp(message.timestamp);
  const stopReason = role === 'assistant' && STOP_REASONS.has(message.stopReason) ? message.stopReason : undefined;
  const projectedContent = message.role === 'custom'
    ? projectPrimeCustomMessageContent(message.content)
    : message.content;
  const toolPresentation = normalizePrimeIpythonToolPresentation(message, workingDirectory);
  const rawContent = shouldSuppressPrimeIpythonEditOutput(message, toolPresentation) ? [] : projectedContent;
  const content = sanitizePrimeIpythonEditOutput(message, rawContent, workingDirectory);
  return {
    role,
    ...(toolName ? { name: toolName } : {}),
    ...(message.role === 'toolResult' && message.isError === true ? { error: true } : {}),
    ...(recordTimestamp !== undefined ? { timestamp: recordTimestamp } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(toolPresentation ? { toolPresentation } : {}),
    blocks: message.role === role || message.role === 'toolResult'
      ? normalizeContent(content)
      : [{ type: 'omitted', reason: 'unsupported_record' }],
  };
};

const boundRecord = (record) => {
  const bytes = Buffer.byteLength(JSON.stringify(record));
  return bytes <= MAX_TEXT_CHARS * 2 ? record : {
    role: record.role,
    ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
    blocks: [{ type: 'omitted', reason: 'record_too_large', bytesAtLeast: bytes }],
  };
};

const trimRecords = (records, omittedOlderRecords) => {
  let totalBytes = records.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
  while (records.length > MAX_RECORDS || totalBytes > MAX_TRANSCRIPT_BYTES) {
    const removed = records.shift();
    if (!removed) break;
    totalBytes -= Buffer.byteLength(JSON.stringify(removed));
    omittedOlderRecords += 1;
  }
  return { records, omittedOlderRecords };
};

export const createPrimeTranscriptProjection = (workingDirectory) => {
  const records = [];
  const sizes = [];
  let totalBytes = 0;
  let sourceMessageCount = 0;
  let omittedOlderRecords = 0;
  return {
    add(message) {
      sourceMessageCount += 1;
      if (isHiddenPrimeMessage(message)) return;
      const record = boundRecord(normalizePrimeMessage(message, workingDirectory));
      const bytes = Buffer.byteLength(JSON.stringify(record));
      records.push(record);
      sizes.push(bytes);
      totalBytes += bytes;
      while (records.length > MAX_RECORDS || totalBytes > MAX_TRANSCRIPT_BYTES) {
        records.shift();
        totalBytes -= sizes.shift();
        omittedOlderRecords += 1;
      }
    },
    result: () => ({ records, sourceMessageCount, omittedOlderRecords }),
  };
};

export const appendPrimeTranscriptRecord = (transcript, message, workingDirectory) => ({
  ...trimRecords(
    [
      ...(Array.isArray(transcript?.records) ? transcript.records : []),
      ...(isHiddenPrimeMessage(message) ? [] : [boundRecord(normalizePrimeMessage(message, workingDirectory))]),
    ],
    Number.isSafeInteger(transcript?.omittedOlderRecords) ? transcript.omittedOlderRecords : 0,
  ),
  sourceMessageCount: (Number.isSafeInteger(transcript?.sourceMessageCount)
    ? transcript.sourceMessageCount
    : transcript?.records?.length || 0) + 1,
});

export const derivePrimeActivity = (state) => isRecord(state)
  && (state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true || state.retryAttempt > 0)
  ? 'working'
  : 'idle';

const modelSelector = (value) => typeof value === 'string'
  && value
  && value === value.trim()
  && value.length <= MAX_NAME_CHARS
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ? value
  : undefined;

const normalizeModel = (model) => {
  if (!isRecord(model)) return null;
  const id = modelSelector(model.id);
  const provider = modelSelector(model.provider);
  if (!id || !provider) return null;
  return {
    id,
    provider,
    ...(name(model.name) ? { name: name(model.name) } : {}),
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input)
      ? [...new Set(model.input.filter((value) => value === 'text' || value === 'image'))]
      : [],
    ...(nonNegative(model.contextWindow) !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(nonNegative(model.maxTokens) !== undefined ? { maxTokens: model.maxTokens } : {}),
  };
};

export const normalizePrimeAvailableModels = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.models) || payload.models.length > MAX_SOURCE_MODELS) return null;
  const models = [];
  const seen = new Set();
  for (const source of payload.models) {
    const model = normalizeModel(source);
    if (!model) continue;
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
    if (models.length === MAX_AVAILABLE_MODELS) break;
  }
  return models;
};

const normalizeContext = (state, sessionUsage) => {
  const usage = state?.contextUsage;
  const context = (() => {
    if (!isRecord(usage)) return { known: false };
    const tokens = usage.tokens === null ? null : nonNegative(usage.tokens);
    const contextWindow = nonNegative(usage.contextWindow);
    const percent = usage.percent === null ? null : nonNegative(usage.percent);
    return tokens === undefined || contextWindow === undefined || percent === undefined
      ? { known: false }
      : { known: true, tokens, contextWindow, percent };
  })();
  return sessionUsage ? { ...context, usage: sessionUsage } : context;
};

export const normalizePrimeSessionStats = (payload) => {
  if (!isRecord(payload) || !isRecord(payload.tokens)) return null;
  const inputTokens = nonNegative(payload.tokens.input);
  const outputTokens = nonNegative(payload.tokens.output);
  const cacheReadTokens = nonNegative(payload.tokens.cacheRead);
  const cacheWriteTokens = nonNegative(payload.tokens.cacheWrite);
  const cost = nonNegative(payload.cost);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost]
    .some((value) => value === undefined)) return null;
  const usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost,
  };
  return {
    usage,
    context: normalizeContext({ contextUsage: payload.contextUsage }, usage),
  };
};

export const createPrimePublicSnapshot = ({
  sessionId,
  generation,
  revision,
  turnToken,
  observedAt,
  snapshot,
  transcript,
  availableModels,
  sessionStats,
  workingDirectory,
}) => {
  const { state, summary } = snapshot;
  const activity = derivePrimeActivity(state);
  const currentModel = normalizeModel(state.model);
  const currentThinking = THINKING_LEVELS.has(state.thinkingLevel) ? state.thinkingLevel : undefined;
  const recap = name(state.recap ?? summary.summary);
  const streamingRecord = summary.streamingMessage && !isHiddenPrimeMessage(summary.streamingMessage)
    ? normalizePrimeMessage(summary.streamingMessage, workingDirectory)
    : undefined;
  return {
    schemaVersion: 1,
    sessionId,
    generation,
    revision,
    turn: { token: turnToken, active: activity === 'working' },
    freshness: { state: 'fresh', observedAt },
    status: { activity, ...(recap ? { recap } : {}) },
    transcript: { ...transcript, ...(streamingRecord ? { streamingRecord } : {}) },
    context: sessionStats?.context ?? normalizeContext(state),
    configuration: {
      ...(currentModel ? { currentModel } : {}),
      models: Array.isArray(availableModels) ? availableModels : currentModel ? [currentModel] : [],
      thinking: {
        ...(currentThinking ? { current: currentThinking } : {}),
        available: Array.isArray(state.availableThinkingLevels)
          ? [...new Set(state.availableThinkingLevels.filter((level) => THINKING_LEVELS.has(level)))]
          : [],
      },
    },
    capabilities: {
      mutations: true,
      actions: { canSend: activity === 'idle', canAbort: activity === 'working', canChangeModel: activity === 'idle' },
      tools: Array.isArray(state.activeToolNames)
        ? [...new Set(state.activeToolNames.map(name).filter(Boolean))].slice(0, 256)
        : [],
    },
  };
};

export const normalizePrimeSessionEvent = (event, workingDirectory) => {
  if (!isRecord(event) || typeof event.type !== 'string') return null;
  if (event.type === 'agent_start' || event.type === 'agent_end') {
    return { type: 'activity', activity: event.type === 'agent_start' ? 'working' : 'idle' };
  }
  if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
    if (isHiddenPrimeMessage(event.message)) return null;
    return {
      type: 'message',
      phase: event.type.slice(8),
      record: normalizePrimeMessage(event.message, workingDirectory),
    };
  }
  if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
    const toolName = name(event.toolName);
    return {
      type: 'tool',
      phase: event.type.slice(15),
      ...(toolName ? { name: toolName } : {}),
      ...(event.type === 'tool_execution_end' && event.isError === true ? { error: true } : {}),
    };
  }
  if (/^(compaction|auto_retry|bash)_start$/.test(event.type)) return { type: 'activity', activity: 'working' };
  if (/^(compaction|auto_retry|bash)_end$/.test(event.type)) return { type: 'activity', activity: 'idle' };
  if (event.type === 'thinking_level_changed' && THINKING_LEVELS.has(event.level)) {
    return { type: 'thinking', current: event.level };
  }
  if (event.type === 'recap_update') return { type: 'status', ...(name(event.recap) ? { recap: name(event.recap) } : {}) };
  return null;
};
