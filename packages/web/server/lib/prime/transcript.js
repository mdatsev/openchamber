import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  openContainedRegularFile,
  readBoundedHeader,
  readFileRange,
} from './secure-files.js';
import { PrimeServiceError } from './errors.js';
import {
  normalizePrimeIpythonToolPresentation,
  normalizePrimeToolCallBlock,
  sanitizePrimeIpythonEditOutput,
  shouldSuppressPrimeIpythonEditOutput,
} from './tool-input.js';
import { projectPrimeCustomMessageContent } from './public-runtime.js';

const DEFAULT_MESSAGE_LIMIT = 200;
const DEFAULT_BYTE_LIMIT = 2 * 1024 * 1024;
const MAX_MESSAGE_LIMIT = 200;
const MAX_BYTE_LIMIT = 2 * 1024 * 1024;
const MIN_BYTE_LIMIT = 1024;
const BACKWARD_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_LINE_BYTES = 512 * 1024;
const MAX_LINE_PREFIX_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_LINE_BYTES = 1024 * 1024;
const SAFE_ENTRY_ID = /^[A-Za-z0-9-]{1,128}$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hashRevision = (sessionId, metadata) => createHash('sha256')
  .update([sessionId, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs].join(':'))
  .digest('base64url')
  .slice(0, 24);
const finiteTimestamp = (value) => {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? timestamp : undefined;
};
const boundedInteger = (rawValue, fallback, minimum, maximum) => {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PrimeServiceError(400, 'prime_invalid_pagination', 'Invalid transcript pagination parameters');
  }
  return value;
};

const normalizedBlock = (block) => {
  if (!isRecord(block)) return null;
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return { type: 'thinking', text: block.thinking };
  }
  if (block.type === 'toolCall') return normalizePrimeToolCallBlock(block);
  if (block.type === 'image' || block.type === 'image_url') {
    return { type: 'omitted', reason: 'binary_content' };
  }
  if (block.type === 'omitted' && block.reason === 'ipython_output_too_large') {
    return { type: 'omitted', reason: block.reason };
  }
  return null;
};

const normalizedContent = (content) => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(normalizedBlock).filter(Boolean);
};

const normalizedMessage = (entry, workingDirectory) => {
  if (!isRecord(entry)) return null;
  let role;
  let blocks;
  let name;
  let error;
  let toolPresentation;
  if (entry.type === 'custom_message') {
    if (entry.display !== true) return null;
    const projectedContent = projectPrimeCustomMessageContent(entry.content);
    if (projectedContent === null) return null;
    role = 'custom';
    blocks = normalizedContent(projectedContent);
  } else if (entry.type === 'message' && isRecord(entry.message)) {
    const message = entry.message;
    if (message.role === 'custom'
      && (message.display === false
        || (typeof message.content === 'string' && message.content.startsWith('<ipython_state>')))) return null;
    if (message.role === 'toolResult') {
      role = 'tool';
      name = typeof message.toolName === 'string' ? message.toolName.slice(0, 128) : undefined;
      error = message.isError === true || undefined;
    } else if (message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'custom') {
      role = message.role;
    } else {
      return null;
    }
    toolPresentation = normalizePrimeIpythonToolPresentation(message, workingDirectory);
    const rawContent = shouldSuppressPrimeIpythonEditOutput(message, toolPresentation) ? [] : message.content;
    blocks = normalizedContent(sanitizePrimeIpythonEditOutput(message, rawContent, workingDirectory));
  } else {
    return null;
  }
  const timestamp = finiteTimestamp(entry.message?.timestamp ?? entry.timestamp);
  return {
    type: 'message',
    ...(typeof entry.id === 'string' && SAFE_ENTRY_ID.test(entry.id) ? { id: entry.id } : {}),
    role,
    ...(name ? { name } : {}),
    ...(error ? { error: true } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(toolPresentation ? { toolPresentation } : {}),
    blocks,
  };
};

const prefixStringProperty = (prefix, property) => {
  const match = prefix.match(new RegExp(`"${property}"\\s*:\\s*"([^"\\\\]{0,128})"`));
  return match?.[1];
};

const omittedMessage = (prefix, bytes, reason = 'oversized_message') => {
  const rawRole = prefixStringProperty(prefix, 'role');
  const role = rawRole === 'toolResult'
    ? 'tool'
    : (rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' || rawRole === 'custom'
      ? rawRole
      : 'custom');
  const rawTimestamp = prefixStringProperty(prefix, 'timestamp');
  const timestamp = finiteTimestamp(rawTimestamp);
  return {
    type: 'message',
    role,
    ...(timestamp !== undefined ? { timestamp } : {}),
    blocks: [{
      type: 'omitted',
      reason,
      ...(reason === 'scan_limit' ? { bytesAtLeast: bytes } : { bytes }),
    }],
    omitted: true,
  };
};

const lineLooksDisplayable = (prefix) => (
  /"type"\s*:\s*"message"/.test(prefix)
  || (/"type"\s*:\s*"custom_message"/.test(prefix) && /"display"\s*:\s*true/.test(prefix))
);

const validEntryIdentity = (entry) => {
  if (!isRecord(entry) || entry.type === 'session'
    || typeof entry.id !== 'string' || !SAFE_ENTRY_ID.test(entry.id)) return null;
  if (entry.parentId === null) return { id: entry.id, parentId: null };
  return typeof entry.parentId === 'string' && SAFE_ENTRY_ID.test(entry.parentId)
    ? { id: entry.id, parentId: entry.parentId }
    : null;
};

const lineEntryIdentity = (accumulator) => {
  const prefix = accumulator.prefix.toString('utf8');
  if (accumulator.totalBytes <= MAX_MESSAGE_LINE_BYTES
    && accumulator.prefix.length >= accumulator.totalBytes) {
    try {
      return validEntryIdentity(JSON.parse(prefix));
    } catch {
      return null;
    }
  }
  const suffix = accumulator.suffix.toString('utf8');
  const type = prefixStringProperty(prefix, 'type');
  if (!type || type === 'session') return null;
  const identitySource = type === 'custom' || type === 'custom_message' ? suffix : prefix;
  const id = prefixStringProperty(identitySource, 'id');
  const parentId = prefixStringProperty(identitySource, 'parentId');
  if (!id || !SAFE_ENTRY_ID.test(id)) return null;
  if (parentId) return SAFE_ENTRY_ID.test(parentId) ? { id, parentId } : null;
  return /"parentId"\s*:\s*null/.test(identitySource) ? { id, parentId: null } : null;
};

const createLineAccumulator = () => ({ totalBytes: 0, prefix: Buffer.alloc(0), suffix: Buffer.alloc(0) });
const prependLinePart = (accumulator, part) => {
  accumulator.totalBytes += part.length;
  if (part.length === 0) return;
  accumulator.prefix = Buffer.concat([part, accumulator.prefix]).subarray(0, MAX_LINE_PREFIX_BYTES);
  accumulator.suffix = Buffer.concat([part, accumulator.suffix]).subarray(-MAX_LINE_PREFIX_BYTES);
};

const normalizeLine = (accumulator, workingDirectory) => {
  const prefix = accumulator.prefix.toString('utf8');
  const suffix = accumulator.suffix.toString('utf8');
  if (!lineLooksDisplayable(`${prefix}${suffix}`)) return { message: null, omitted: false };
  if (accumulator.totalBytes > MAX_MESSAGE_LINE_BYTES || accumulator.prefix.length < accumulator.totalBytes) {
    return { message: omittedMessage(prefix, accumulator.totalBytes), omitted: true };
  }
  try {
    const message = normalizedMessage(JSON.parse(prefix), workingDirectory);
    return { message, omitted: false };
  } catch {
    return {
      message: omittedMessage(prefix, accumulator.totalBytes, 'malformed_message'),
      omitted: true,
    };
  }
};

const signCursor = (secret, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const readCursor = (secret, rawCursor, sessionId, revision, fileSize) => {
  if (typeof rawCursor !== 'string' || rawCursor.length < 10 || rawCursor.length > 2048) {
    throw new PrimeServiceError(400, 'prime_invalid_cursor', 'Invalid transcript cursor');
  }
  const [encoded, signature, extra] = rawCursor.split('.');
  if (!encoded || !signature || extra) throw new PrimeServiceError(400, 'prime_invalid_cursor', 'Invalid transcript cursor');
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    throw new PrimeServiceError(400, 'prime_invalid_cursor', 'Invalid transcript cursor');
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new PrimeServiceError(400, 'prime_invalid_cursor', 'Invalid transcript cursor');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new PrimeServiceError(400, 'prime_invalid_cursor', 'Invalid transcript cursor');
  }
  if (!isRecord(payload)
    || payload.v !== 2
    || payload.s !== sessionId
    || payload.r !== revision
    || !Number.isSafeInteger(payload.b)
    || payload.b < 0
    || payload.b > fileSize
    || typeof payload.a !== 'string'
    || !SAFE_ENTRY_ID.test(payload.a)) {
    throw new PrimeServiceError(409, 'prime_cursor_stale', 'Transcript cursor no longer matches this session revision');
  }
  return { endOffset: payload.b, expectedEntryId: payload.a };
};

const scanTranscriptPage = async ({
  openedFile,
  endOffset,
  expectedEntryId,
  messageLimit,
  byteLimit,
  workingDirectory,
}) => {
  const newestFirst = [];
  let responseBytes = 0;
  let oversizedOmitted = 0;
  let truncated = false;
  let scanBytes = 0;
  let position = endOffset;
  let currentEnd = endOffset;
  let accumulator = createLineAccumulator();
  let oldestIncludedStart = endOffset;
  let cursorExpectedEntryId = expectedEntryId;
  let expectedId = expectedEntryId;
  let branchComplete = false;
  let stoppedForPage = false;
  let hitScanLimit = false;

  const consumeLine = (lineStart) => {
    const identity = lineEntryIdentity(accumulator);
    if (!identity) {
      accumulator = createLineAccumulator();
      return;
    }
    if (expectedId === undefined) expectedId = identity.id;
    if (identity.id !== expectedId) {
      accumulator = createLineAccumulator();
      return;
    }
    const normalized = normalizeLine(accumulator, workingDirectory);
    accumulator = createLineAccumulator();
    if (!normalized.message) {
      expectedId = identity.parentId;
      oldestIncludedStart = lineStart;
      cursorExpectedEntryId = expectedId ?? undefined;
      if (expectedId === null) branchComplete = true;
      return;
    }
    let message = normalized.message;
    let serializedBytes = Buffer.byteLength(JSON.stringify(message));
    if (serializedBytes > byteLimit) {
      message = omittedMessage('', serializedBytes);
      serializedBytes = Buffer.byteLength(JSON.stringify(message));
      normalized.omitted = true;
    }
    if (newestFirst.length >= messageLimit
      || (newestFirst.length > 0 && responseBytes + serializedBytes > byteLimit)) {
      stoppedForPage = true;
      return;
    }
    expectedId = identity.parentId;
    newestFirst.push(message);
    responseBytes += serializedBytes;
    oldestIncludedStart = lineStart;
    cursorExpectedEntryId = expectedId ?? undefined;
    if (expectedId === null) branchComplete = true;
    if (normalized.omitted) {
      oversizedOmitted += 1;
      truncated = true;
    }
  };

  while (position > 0 && !stoppedForPage && !branchComplete) {
    const remainingWork = MAX_TRANSCRIPT_SCAN_BYTES - scanBytes;
    if (remainingWork <= 0) {
      hitScanLimit = true;
      break;
    }
    const length = Math.min(BACKWARD_CHUNK_BYTES, position, remainingWork);
    const start = position - length;
    const chunk = await readFileRange(openedFile.handle, start, length);
    scanBytes += chunk.length;
    let segmentEnd = chunk.length;
    for (;;) {
      const newlineIndex = chunk.lastIndexOf(0x0a, segmentEnd - 1);
      if (newlineIndex < 0) break;
      prependLinePart(accumulator, chunk.subarray(newlineIndex + 1, segmentEnd));
      consumeLine(start + newlineIndex + 1);
      currentEnd = start + newlineIndex;
      segmentEnd = newlineIndex;
      if (stoppedForPage || branchComplete) break;
    }
    if (!stoppedForPage) prependLinePart(accumulator, chunk.subarray(0, segmentEnd));
    position = start;
  }

  if (!stoppedForPage && !branchComplete && position === 0
    && (accumulator.totalBytes > 0 || currentEnd > 0)) {
    consumeLine(0);
  }
  const scanLimitResumable = hitScanLimit
    && oldestIncludedStart < endOffset
    && typeof cursorExpectedEntryId === 'string';
  if (hitScanLimit && !scanLimitResumable) {
    truncated = true;
    if (accumulator.totalBytes > 0 && newestFirst.length < messageLimit) {
      newestFirst.push(omittedMessage(accumulator.prefix.toString('utf8'), accumulator.totalBytes, 'scan_limit'));
      oversizedOmitted += 1;
    }
  }
  const hasOlder = (stoppedForPage || scanLimitResumable)
    && typeof cursorExpectedEntryId === 'string';
  return {
    messages: newestFirst.reverse(),
    olderOffset: hasOlder ? oldestIncludedStart : null,
    olderExpectedEntryId: hasOlder ? cursorExpectedEntryId : null,
    hasOlder,
    truncated,
    oversizedOmitted,
  };
};

const nonNegativeUsage = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const contextTokens = (usage) => {
  if (!isRecord(usage)) return 0;
  return nonNegativeUsage(usage.totalTokens)
    || nonNegativeUsage(usage.input)
      + nonNegativeUsage(usage.output)
      + nonNegativeUsage(usage.cacheRead)
      + nonNegativeUsage(usage.cacheWrite);
};
const validUsage = (usage) => isRecord(usage)
  && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
    .every((key) => usage[key] === undefined || (Number.isFinite(usage[key]) && usage[key] >= 0));

export const createPrimeTranscriptService = ({ cursorSecret = randomBytes(32) } = {}) => {
  const openSession = async (entity) => {
    const openedFile = await openContainedRegularFile(entity.filePath, entity.containmentRoot).catch(() => {
      throw new PrimeServiceError(404, 'prime_session_unavailable', 'Prime session is unavailable');
    });
    try {
      const header = await readBoundedHeader(openedFile);
      if (header?.type !== 'session'
        || header.id !== entity.sessionId
        || path.basename(openedFile.realPath) !== `${entity.sessionId}.jsonl`) {
        throw new PrimeServiceError(404, 'prime_session_unavailable', 'Prime session is unavailable');
      }
      return openedFile;
    } catch (error) {
      await openedFile.handle.close();
      if (error instanceof PrimeServiceError) throw error;
      throw new PrimeServiceError(404, 'prime_session_unavailable', 'Prime session is unavailable');
    }
  };

  const getTranscript = async (entity, query = {}) => {
    const messageLimit = boundedInteger(query.limit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
    const byteLimit = boundedInteger(query.byteLimit, DEFAULT_BYTE_LIMIT, MIN_BYTE_LIMIT, MAX_BYTE_LIMIT);
    const openedFile = await openSession(entity);
    try {
      const revision = hashRevision(entity.sessionId, openedFile.metadata);
      const cursor = query.cursor
        ? readCursor(cursorSecret, query.cursor, entity.sessionId, revision, openedFile.metadata.size)
        : { endOffset: openedFile.metadata.size, expectedEntryId: undefined };
      const page = await scanTranscriptPage({
        openedFile,
        endOffset: cursor.endOffset,
        expectedEntryId: cursor.expectedEntryId,
        messageLimit,
        byteLimit,
        workingDirectory: entity.workingDirectory,
      });
      const finalMetadata = await openedFile.handle.stat();
      if (hashRevision(entity.sessionId, finalMetadata) !== revision) {
        throw new PrimeServiceError(409, 'prime_revision_changed', 'Prime session changed while it was being read');
      }
      const olderCursor = page.olderOffset === null || page.olderExpectedEntryId === null
        ? null
        : signCursor(cursorSecret, {
            v: 2,
            s: entity.sessionId,
            r: revision,
            b: page.olderOffset,
            a: page.olderExpectedEntryId,
          });
      return {
        schemaVersion: 1,
        sessionId: entity.sessionId,
        revision,
        messages: page.messages,
        page: {
          olderCursor,
          hasOlder: Boolean(olderCursor) && page.hasOlder,
          truncated: page.truncated,
          oversizedOmitted: page.oversizedOmitted,
        },
      };
    } finally {
      await openedFile.handle.close();
    }
  };

  const getContext = async (entity) => {
    const openedFile = await openSession(entity);
    try {
      const revision = hashRevision(entity.sessionId, openedFile.metadata);
      if (openedFile.metadata.size > MAX_CONTEXT_BYTES) {
        return { schemaVersion: 1, sessionId: entity.sessionId, revision, usage: {}, truncated: true };
      }
      const buffer = await readFileRange(openedFile.handle, 0, openedFile.metadata.size);
      const entries = [];
      const byId = new Map();
      const attributionByTarget = new Map();
      let truncated = false;
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_CONTEXT_LINE_BYTES) {
          truncated = true;
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          truncated = true;
          continue;
        }
        if (!isRecord(entry)) {
          truncated = true;
          continue;
        }
        if (entry.type === 'session') continue;
        if (entry.type === 'child_usage_attributed') {
          if (typeof entry.targetId !== 'string' || !isRecord(entry.aggregateUsage)) {
            truncated = true;
          } else {
            attributionByTarget.set(entry.targetId, entry.aggregateUsage);
          }
        }
        if (entry.type === 'message' && !isRecord(entry.message)) truncated = true;
        if (typeof entry.id !== 'string'
          || !SAFE_ENTRY_ID.test(entry.id)
          || (entry.parentId !== null && typeof entry.parentId !== 'string')) {
          truncated = true;
          continue;
        }
        if (byId.has(entry.id)) truncated = true;
        entries.push(entry);
        byId.set(entry.id, entry);
      }
      const branch = [];
      const visited = new Set();
      let current = entries.at(-1);
      while (current && !visited.has(current.id) && branch.length <= entries.length) {
        visited.add(current.id);
        branch.push(current);
        if (typeof current.parentId === 'string' && !byId.has(current.parentId)) truncated = true;
        current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
      }
      if (current || branch.length > entries.length) truncated = true;
      branch.reverse();
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
      };
      let costKnown = true;
      let assistantCount = 0;
      let latestAssistantIndex = -1;
      let latestAssistantContextTokens = 0;
      let latestCompactionIndex = -1;
      for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index];
        if (entry.type === 'compaction') latestCompactionIndex = index;
        if (entry.type !== 'message'
          || !isRecord(entry.message)
          || entry.message.role !== 'assistant'
          || entry.message.stopReason === 'aborted'
          || entry.message.stopReason === 'error') continue;
        const rawMessageUsage = entry.message.usage;
        const aggregateUsage = attributionByTarget.get(entry.id) || rawMessageUsage;
        if (!validUsage(rawMessageUsage) || !validUsage(aggregateUsage)) {
          truncated = true;
          continue;
        }
        const inputTokens = nonNegativeUsage(aggregateUsage.input);
        const outputTokens = nonNegativeUsage(aggregateUsage.output);
        const cacheReadTokens = nonNegativeUsage(aggregateUsage.cacheRead);
        const cacheWriteTokens = nonNegativeUsage(aggregateUsage.cacheWrite);
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
        usage.cacheReadTokens += cacheReadTokens;
        usage.cacheWriteTokens += cacheWriteTokens;
        usage.totalTokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
        const messageCost = isRecord(aggregateUsage.cost)
          ? aggregateUsage.cost.total
          : undefined;
        if (Number.isFinite(messageCost) && messageCost >= 0) usage.cost += messageCost;
        else costKnown = false;
        assistantCount += 1;
        latestAssistantIndex = index;
        latestAssistantContextTokens = contextTokens(rawMessageUsage);
      }
      const finalMetadata = await openedFile.handle.stat();
      if (hashRevision(entity.sessionId, finalMetadata) !== revision) {
        throw new PrimeServiceError(409, 'prime_revision_changed', 'Prime session changed while it was being read');
      }
      const exactUsage = assistantCount > 0 && !truncated
        ? { ...usage, ...(!costKnown ? { cost: undefined } : {}) }
        : {};
      const window = !truncated && latestAssistantIndex > latestCompactionIndex && latestAssistantContextTokens > 0
        ? { used: latestAssistantContextTokens }
        : undefined;
      return {
        schemaVersion: 1,
        sessionId: entity.sessionId,
        revision,
        usage: exactUsage,
        ...(window ? { window } : {}),
        truncated,
      };
    } finally {
      await openedFile.handle.close();
    }
  };

  return { getTranscript, getContext };
};
