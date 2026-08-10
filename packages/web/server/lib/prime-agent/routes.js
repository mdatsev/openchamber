const MAX_CATALOG_FILES = 5_000;
const MAX_ARTIFACT_DIRECTORIES = 10_000;
const MAX_ARTIFACT_METADATA_BYTES = 16 * 1024 * 1024;
const CATALOG_MAX_AGE_MS = 10_000;
const SESSION_PREVIEW_BYTES = 64 * 1024;
const SESSION_TAIL_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_TRANSCRIPT_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEMS = 5_000;
const MAX_SESSION_RECORDS = 50_000;
const MAX_DIRECTORY_LENGTH = 4_096;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TRANSCRIPT_CACHE_ENTRIES = 8;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_RUNTIME_ERROR_CODES = new Set([
  'binary-mismatch',
  'command-result-uncertain',
  'command-timeout',
  'connection-closed',
  'incompatible',
  'invalid-binary',
  'launch-failed',
  'not-configured',
  'settings-unavailable',
  'unavailable',
]);
const PRIME_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIME_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const expandHome = (value, homeDirectory, path) => {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

const resolvePrimeSessionDirectory = ({ env, os, path }) => {
  const homeDirectory = os.homedir();
  const explicitSessionDirectory = asNonEmptyString(env.PRIME_AGENT_SESSION_DIR)
    ?? asNonEmptyString(env.PRIME_AGENT_CODING_AGENT_SESSION_DIR);
  if (explicitSessionDirectory) {
    return path.resolve(expandHome(explicitSessionDirectory, homeDirectory, path));
  }

  const configDirectory = asNonEmptyString(env.PRIME_AGENT_CODING_AGENT_DIR);
  if (configDirectory) {
    return path.resolve(expandHome(configDirectory, homeDirectory, path), 'sessions');
  }
  return path.join(homeDirectory, '.prime', 'agent', 'sessions');
};

const parseJsonObject = (line) => {
  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Prime Agent session record must be an object');
  }
  return parsed;
};

const extractTextContent = (content) => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
};

const truncateTitle = (value) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
};

const resolveSessionTitle = (sessionName, firstMessage) => {
  if (sessionName) return truncateTitle(sessionName);
  if (firstMessage) return truncateTitle(firstMessage);
  return null;
};

const isValidSessionHeader = (header, expectedSessionID) => (
  header
  && header.type === 'session'
  && header.id === expectedSessionID
  && typeof header.cwd === 'string'
  && header.cwd.length <= MAX_DIRECTORY_LENGTH
  && (header.timestamp === undefined
    || (typeof header.timestamp === 'string' && header.timestamp.length <= MAX_TIMESTAMP_LENGTH))
  && (header.parentSession === undefined
    || (typeof header.parentSession === 'string' && header.parentSession.length <= MAX_DIRECTORY_LENGTH))
  && (header.rlmDepth === undefined
    || (Number.isSafeInteger(header.rlmDepth) && header.rlmDepth >= 0))
);

const isRootSessionHeader = (header) => header.rlmDepth === undefined
  ? !header.parentSession
  : header.rlmDepth === 0;

const readWindow = async (fileHandle, start, length) => {
  if (length <= 0) return '';
  const buffer = Buffer.allocUnsafe(length);
  let totalBytesRead = 0;
  while (totalBytesRead < length) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      totalBytesRead,
      length - totalBytesRead,
      start + totalBytesRead,
    );
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }
  return buffer.subarray(0, totalBytesRead).toString('utf8');
};

const fileSignature = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;

const parsePreviewRecords = (source, completeAtEnd) => {
  const lines = source.split('\n');
  if (!completeAtEnd) lines.pop();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    records.push(parseJsonObject(line));
  }
  return records;
};

const readSessionSummary = async ({ filePath, fsPromises, expectedSessionID, expectedStats, allowChild = false }) => {
  const fileHandle = await fsPromises.open(filePath, 'r');
  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile()) throw new Error('Prime Agent session path is not a regular file');
    if (expectedStats.ino !== 0 && (expectedStats.dev !== stats.dev || expectedStats.ino !== stats.ino)) {
      throw new Error('Prime Agent session path changed during catalog read');
    }

    const firstLength = Math.min(stats.size, SESSION_PREVIEW_BYTES);
    const firstSource = await readWindow(fileHandle, 0, firstLength);
    const firstRecords = parsePreviewRecords(firstSource, stats.size <= firstLength);
    const header = firstRecords[0];
    if (!isValidSessionHeader(header, expectedSessionID)) {
      throw new Error('Invalid Prime Agent session header');
    }
    if (!isRootSessionHeader(header) && !allowChild) return null;

    let firstMessage = '';
    for (const record of firstRecords.slice(1)) {
      if (record.type !== 'message' || record.message?.role !== 'user') continue;
      firstMessage = extractTextContent(record.message.content);
      if (firstMessage) break;
    }

    let sessionName = null;
    const tailStart = Math.max(0, stats.size - SESSION_TAIL_BYTES);
    const tailSource = tailStart === 0
      ? firstSource
      : await readWindow(fileHandle, tailStart, stats.size - tailStart);
    const tailBody = tailStart === 0
      ? tailSource
      : tailSource.slice(Math.max(0, tailSource.indexOf('\n') + 1));
    let tailRecords = [];
    try {
      tailRecords = parsePreviewRecords(tailBody, true);
    } catch {
      // Catalog metadata is best-effort per file. The transcript endpoint does
      // the strict parse when the user opens this session.
    }
    for (const record of tailRecords) {
      if (record.type === 'session_info') {
        sessionName = typeof record.name === 'string' ? record.name.trim() : null;
      }
    }

    return {
      signature: fileSignature(stats),
      header,
      summary: {
        id: header.id,
        title: resolveSessionTitle(sessionName, firstMessage),
        directory: header.cwd,
        createdAt: typeof header.timestamp === 'string' ? header.timestamp : stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        parentID: null,
        depth: 0,
      },
    };
  } finally {
    await fileHandle.close();
  }
};

const listPrimeSessions = async ({ sessionDirectory, fsPromises, path, summaryCache }) => {
  let entries;
  try {
    entries = await fsPromises.readdir(sessionDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'not-configured', sessions: [], skippedFileCount: 0, failedSessionIDs: [] };
    }
    throw error;
  }

  const candidates = [];
  const compareCandidates = (left, right) => (
    right.summary.updatedAt.localeCompare(left.summary.updatedAt)
    || left.summary.id.localeCompare(right.summary.id)
  );
  let cappedSessionCount = 0;
  const capCandidates = () => {
    candidates.sort(compareCandidates);
    const removedCandidates = candidates.slice(MAX_CATALOG_FILES);
    // Read failures already contribute to skippedFileCount when they occur.
    cappedSessionCount += removedCandidates.filter((candidate) => !candidate.failed).length;
    candidates.length = Math.min(candidates.length, MAX_CATALOG_FILES);
  };
  const addCandidate = (candidate) => {
    candidates.push(candidate);
    if (candidates.length < MAX_CATALOG_FILES * 2) return;
    capCandidates();
  };
  let nextIndex = 0;
  let skippedFileCount = 0;
  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionID = entry.name.slice(0, -'.jsonl'.length);
      if (!PRIME_SESSION_ID_PATTERN.test(sessionID)) {
        skippedFileCount += 1;
        continue;
      }
      const cached = summaryCache.get(entry.name);
      try {
        const stats = await fsPromises.lstat(path.join(sessionDirectory, entry.name));
        if (!stats.isFile() || stats.isSymbolicLink()) {
          skippedFileCount += 1;
          summaryCache.delete(entry.name);
          continue;
        }
        const signature = fileSignature(stats);
        let cacheEntry = cached;
        if (cacheEntry?.signature !== signature) {
          cacheEntry = await readSessionSummary({
            filePath: path.join(sessionDirectory, entry.name),
            fsPromises,
            expectedSessionID: sessionID,
            expectedStats: stats,
          });
          if (!cacheEntry) {
            summaryCache.delete(entry.name);
            continue;
          }
        }
        addCandidate({ fileName: entry.name, cacheEntry, summary: cacheEntry.summary, failed: false });
      } catch (error) {
        skippedFileCount += 1;
        if (error?.code === 'ENOENT') {
          summaryCache.delete(entry.name);
        } else if (cached) {
          addCandidate({ fileName: entry.name, cacheEntry: cached, summary: cached.summary, failed: true });
        }
      }
    }
  }));
  capCandidates();
  summaryCache.clear();
  for (const candidate of candidates) {
    summaryCache.set(candidate.fileName, candidate.cacheEntry);
  }
  skippedFileCount += cappedSessionCount;
  return {
    status: skippedFileCount > 0 ? 'partial' : 'ready',
    sessions: candidates.map((candidate) => candidate.summary),
    skippedFileCount,
    failedSessionIDs: candidates
      .filter((candidate) => candidate.failed)
      .map((candidate) => candidate.summary.id)
      .sort(),
  };
};

const isPathWithin = (path, rootPath, candidatePath) => {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

const listArtifactChildSessions = async ({ sessionDirectory, rootSessionIDs, fsPromises, path }) => {
  const artifactDirectory = path.join(path.dirname(sessionDirectory), 'session-artifacts');
  let artifactRoots;
  try {
    artifactRoots = await fsPromises.readdir(artifactDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const latestRecordsByPath = new Map();
  let visitedDirectoryCount = 0;
  let metadataBytesRead = 0;
  for (const artifactRoot of artifactRoots) {
    if (!artifactRoot.isDirectory() || !rootSessionIDs.has(artifactRoot.name)) continue;
    const rootPath = path.join(artifactDirectory, artifactRoot.name);
    const pendingDirectories = [rootPath];
    while (pendingDirectories.length > 0 && visitedDirectoryCount < MAX_ARTIFACT_DIRECTORIES) {
      const directory = pendingDirectories.pop();
      visitedDirectoryCount += 1;
      let entries;
      try {
        entries = await fsPromises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(entryPath);
          continue;
        }
        if (!entry.isFile() || entry.name !== 'rlm-subagents.jsonl') continue;
        let handle;
        try {
          const before = await fsPromises.lstat(entryPath);
          if (!before.isFile() || before.isSymbolicLink()) continue;
          if (before.size > MAX_ARTIFACT_METADATA_BYTES - metadataBytesRead) continue;
          handle = await fsPromises.open(entryPath, 'r');
          const after = await handle.stat();
          if (!after.isFile() || (before.ino !== 0 && (before.dev !== after.dev || before.ino !== after.ino))) continue;
          const source = await readWindow(handle, 0, after.size);
          metadataBytesRead += after.size;
          for (const line of source.split('\n')) {
            if (!line.trim()) continue;
            let record;
            try {
              record = parseJsonObject(line);
            } catch {
              continue;
            }
            if (record.type !== 'rlm_subagent') continue;
            const sessionFile = asNonEmptyString(record.sessionFile);
            if (!sessionFile) continue;
            const resolvedSessionFile = path.resolve(sessionFile);
            if (!isPathWithin(path, rootPath, resolvedSessionFile)) continue;
            latestRecordsByPath.set(resolvedSessionFile, { record, rootID: artifactRoot.name, rootPath });
            if (latestRecordsByPath.size >= MAX_CATALOG_FILES) break;
          }
        } catch {
          // One damaged artifact registry must not hide unrelated sessions.
        } finally {
          await handle?.close().catch(() => {});
        }
        if (latestRecordsByPath.size >= MAX_CATALOG_FILES || metadataBytesRead >= MAX_ARTIFACT_METADATA_BYTES) break;
      }
      if (latestRecordsByPath.size >= MAX_CATALOG_FILES || metadataBytesRead >= MAX_ARTIFACT_METADATA_BYTES) break;
    }
    if (latestRecordsByPath.size >= MAX_CATALOG_FILES || metadataBytesRead >= MAX_ARTIFACT_METADATA_BYTES) break;
  }

  const candidates = [];
  for (const [sessionFile, metadata] of latestRecordsByPath) {
    if (metadata.record.status === 'deleted') continue;
    const extension = path.extname(sessionFile);
    const sessionID = extension === '.jsonl' ? path.basename(sessionFile, extension) : null;
    if (!sessionID || !PRIME_SESSION_ID_PATTERN.test(sessionID)) continue;
    try {
      const stats = await fsPromises.lstat(sessionFile);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const result = await readSessionSummary({
        filePath: sessionFile,
        fsPromises,
        expectedSessionID: sessionID,
        expectedStats: stats,
        allowChild: true,
      });
      if (!result || isRootSessionHeader(result.header)) continue;
      const parentPath = asNonEmptyString(result.header.parentSession);
      const parentExtension = parentPath ? path.extname(parentPath) : '';
      const parentID = parentExtension === '.jsonl' ? path.basename(parentPath, parentExtension) : null;
      const depth = result.header.rlmDepth;
      if (
        !parentID
        || !PRIME_SESSION_ID_PATTERN.test(parentID)
        || !Number.isSafeInteger(depth)
        || depth < 1
        || (asNonEmptyString(metadata.record.parentSessionId) ?? parentID) !== parentID
      ) continue;
      if (depth > 1 && !isPathWithin(path, metadata.rootPath, path.resolve(parentPath))) continue;
      candidates.push({
        ...result.summary,
        title: resolveSessionTitle(asNonEmptyString(metadata.record.sessionName), result.summary.title),
        parentID,
        depth,
        activity: metadata.record.status === 'running' ? 'working' : 'idle',
        isSessionActive: false,
        activeSessionID: null,
        sessionFile,
        isChild: true,
        raw: { status: metadata.record.status },
        rootID: metadata.rootID,
      });
    } catch {
      // Artifact metadata is best-effort per child.
    }
  }

  const byID = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const hasValidAncestry = (candidate) => {
    let current = candidate;
    const visited = new Set();
    while (current.parentID !== current.rootID) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      const parent = byID.get(current.parentID);
      if (!parent || parent.rootID !== current.rootID || parent.depth !== current.depth - 1) return false;
      current = parent;
    }
    return current.depth === 1;
  };

  return candidates
    .filter(hasValidAncestry)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
};

const createRouteError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

const parseSessionFile = (source) => {
  const lines = source.split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let record;
    try {
      record = parseJsonObject(line);
    } catch {
      const isIncompleteFinalLine = index === lines.length - 1 && !source.endsWith('\n');
      if (isIncompleteFinalLine) {
        throw createRouteError(409, 'transcript-in-progress', 'Prime Agent is still writing this transcript');
      }
      throw createRouteError(422, 'invalid-session', `Invalid Prime Agent session record at line ${index + 1}`);
    }
    records.push(record);
    if (records.length > MAX_SESSION_RECORDS) {
      throw createRouteError(413, 'transcript-too-large', 'Prime Agent transcript has too many records to display');
    }
  }
  return records;
};

const resolveActiveBranch = (entries, version) => {
  if (version === 1 || entries.every((entry) => entry.parentId === undefined)) return entries;

  const entriesByID = new Map();
  for (const entry of entries) {
    if (typeof entry.id === 'string') entriesByID.set(entry.id, entry);
  }
  const leaf = [...entries].reverse().find((entry) => typeof entry.id === 'string');
  if (!leaf) return [];

  const branch = [];
  const visited = new Set();
  let current = leaf;
  while (current) {
    if (visited.has(current.id)) throw createRouteError(422, 'invalid-session', 'Prime Agent session contains a cycle');
    visited.add(current.id);
    branch.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    current = entriesByID.get(current.parentId);
    if (!current) throw createRouteError(422, 'invalid-session', 'Prime Agent session branch is incomplete');
  }
  return branch.reverse();
};

const validateSessionTree = (entries, version) => {
  if (version < 2) return;
  const entriesByID = new Map();
  let rootCount = 0;
  for (const entry of entries) {
    if (typeof entry.type !== 'string' || !entry.type || entry.type.length > 128) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session entry has an invalid type');
    }
    if (typeof entry.timestamp !== 'string' || !entry.timestamp || entry.timestamp.length > MAX_TIMESTAMP_LENGTH) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session entry has an invalid timestamp');
    }
    if (typeof entry.id !== 'string' || !PRIME_ENTRY_ID_PATTERN.test(entry.id)) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session entry is missing an ID');
    }
    if (entriesByID.has(entry.id)) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session contains duplicate entry IDs');
    }
    if (entry.parentId !== null && (typeof entry.parentId !== 'string' || !PRIME_ENTRY_ID_PATTERN.test(entry.parentId))) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session entry has an invalid parent ID');
    }
    if (entry.parentId === null) rootCount += 1;
    entriesByID.set(entry.id, entry);
  }
  if (entries.length > 0 && rootCount === 0) {
    throw createRouteError(422, 'invalid-session', 'Prime Agent session must contain a root entry');
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !entriesByID.has(entry.parentId)) {
      throw createRouteError(422, 'invalid-session', 'Prime Agent session branch is incomplete');
    }
  }
  const completeEntryIDs = new Set();
  for (const entry of entries) {
    if (completeEntryIDs.has(entry.id)) continue;
    const branchEntryIDs = [];
    const branchEntryIDSet = new Set();
    let current = entry;
    while (current && !completeEntryIDs.has(current.id)) {
      if (branchEntryIDSet.has(current.id)) {
        throw createRouteError(422, 'invalid-session', 'Prime Agent session contains a cycle');
      }
      branchEntryIDs.push(current.id);
      branchEntryIDSet.add(current.id);
      current = current.parentId === null ? null : entriesByID.get(current.parentId);
    }
    branchEntryIDs.forEach((entryID) => completeEntryIDs.add(entryID));
  }
};

const stringifyValue = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const contentBlocks = (content) => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
};

const boundedLabel = (value) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, 256)
  : null;

const nonNegativeNumber = (value) => Number.isFinite(value) && value >= 0 ? value : null;

const normalizeUsage = (usage) => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = nonNegativeNumber(usage.input);
  const outputTokens = nonNegativeNumber(usage.output);
  const cacheReadTokens = nonNegativeNumber(usage.cacheRead);
  const cacheWriteTokens = nonNegativeNumber(usage.cacheWrite);
  const explicitTotalTokens = nonNegativeNumber(usage.totalTokens);
  const cost = nonNegativeNumber(usage.cost?.total);
  if (
    inputTokens === null
    && outputTokens === null
    && cacheReadTokens === null
    && cacheWriteTokens === null
    && explicitTotalTokens === null
    && cost === null
  ) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: explicitTotalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
    cost,
  };
};

const transcriptItemsFromBranch = (branch, options = {}) => {
  const transcriptItems = [];
  const toolItemIndexes = new Map();
  let transcriptTextBytes = 0;
  let providerID = null;
  let modelID = null;
  let reasoningEffort = null;
  const currentMetadata = () => ({
    providerID,
    modelID,
    reasoningEffort,
    usage: null,
    stopReason: null,
  });
  const appendItem = (item) => {
    transcriptTextBytes += Buffer.byteLength(item.text, 'utf8');
    if (item.toolInput && item.toolInput !== item.text) transcriptTextBytes += Buffer.byteLength(item.toolInput, 'utf8');
    if (item.toolOutput && item.toolOutput !== item.text) transcriptTextBytes += Buffer.byteLength(item.toolOutput, 'utf8');
    if (transcriptItems.length >= MAX_TRANSCRIPT_ITEMS || transcriptTextBytes > MAX_TRANSCRIPT_TEXT_BYTES) {
      throw createRouteError(413, 'transcript-too-large', 'Prime Agent transcript is too large to display');
    }
    transcriptItems.push({
      branchEntryID: null,
      streaming: false,
      toolCallID: null,
      toolInput: null,
      toolOutput: null,
      toolStatus: null,
      ...item,
    });
    return transcriptItems.length - 1;
  };
  const setToolOutput = (itemIndex, output, isError, label) => {
    transcriptTextBytes += Buffer.byteLength(output, 'utf8');
    if (transcriptTextBytes > MAX_TRANSCRIPT_TEXT_BYTES) {
      throw createRouteError(413, 'transcript-too-large', 'Prime Agent transcript is too large to display');
    }
    const current = transcriptItems[itemIndex];
    transcriptItems[itemIndex] = {
      ...current,
      label: current.label ?? label,
      isError,
      streaming: false,
      toolOutput: output,
      toolStatus: isError ? 'error' : 'completed',
    };
  };

  for (let entryIndex = 0; entryIndex < branch.length; entryIndex += 1) {
    const entry = branch[entryIndex];
    const storedEntryID = typeof entry.id === 'string' && entry.id.trim() ? entry.id : null;
    const entryID = storedEntryID ?? `entry-${entryIndex}`;
    const timestamp = typeof entry.timestamp === 'string'
      ? entry.timestamp.slice(0, MAX_TIMESTAMP_LENGTH)
      : null;
    if (entry.type === 'model_change') {
      providerID = boundedLabel(entry.provider) ?? providerID;
      modelID = boundedLabel(entry.modelId) ?? modelID;
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      reasoningEffort = boundedLabel(entry.thinkingLevel);
      continue;
    }
    if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
      const message = entry.message;
      const itemMetadata = currentMetadata();
      if (message.role === 'user') {
        const text = extractTextContent(message.content);
        if (text) appendItem({
          id: `${entryID}:user`,
          branchEntryID: options.actionableEntries === true ? storedEntryID : null,
          role: 'user',
          text,
          timestamp,
          label: null,
          isError: false,
          ...itemMetadata,
        });
        continue;
      }
      if (message.role === 'assistant') {
        providerID = boundedLabel(message.provider) ?? providerID;
        modelID = boundedLabel(message.model ?? message.modelId) ?? modelID;
        const assistantMetadata = {
          providerID,
          modelID,
          reasoningEffort,
          usage: normalizeUsage(message.usage),
          stopReason: boundedLabel(message.stopReason),
        };
        const messageItems = [];
        contentBlocks(message.content).forEach((block, blockIndex) => {
          if (!block || typeof block !== 'object') return;
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            messageItems.push({ id: `${entryID}:text:${blockIndex}`, role: 'assistant', text: block.text, timestamp, label: null, isError: false, streaming: entry.streamingContentIndex === blockIndex });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            messageItems.push({ id: `${entryID}:thinking:${blockIndex}`, role: 'reasoning', text: block.thinking, timestamp, label: null, isError: false, streaming: entry.streamingContentIndex === blockIndex });
          } else if (block.type === 'toolCall' && typeof block.name === 'string') {
            const toolCallID = boundedLabel(block.id);
            const toolInput = stringifyValue(block.arguments ?? {});
            messageItems.push({
              id: toolCallID ? `tool:${toolCallID}` : `${entryID}:tool:${blockIndex}`,
              role: 'tool',
              text: toolInput,
              timestamp,
              label: boundedLabel(block.name),
              isError: false,
              streaming: entry.streamingContentIndex === blockIndex,
              toolCallID,
              toolInput,
              toolStatus: 'pending',
            });
          }
        });
        if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
          messageItems.push({ id: `${entryID}:error`, role: 'assistant', text: message.errorMessage, timestamp, label: null, isError: true });
        }
        const usageItemIndex = Math.max(0, messageItems.findIndex((item) => item.role === 'assistant'));
        messageItems.forEach((item, itemIndex) => {
          const transcriptItemIndex = appendItem({
            ...item,
            ...assistantMetadata,
            usage: itemIndex === usageItemIndex ? assistantMetadata.usage : null,
            stopReason: itemIndex === usageItemIndex ? assistantMetadata.stopReason : null,
          });
          if (item.toolCallID) toolItemIndexes.set(item.toolCallID, transcriptItemIndex);
        });
        continue;
      }
      if (message.role === 'toolResult') {
        const text = extractTextContent(message.content);
        if (text) {
          const toolCallID = boundedLabel(message.toolCallId);
          const existingIndex = toolCallID ? toolItemIndexes.get(toolCallID) : undefined;
          if (existingIndex === undefined) {
            const itemIndex = appendItem({
              id: toolCallID ? `tool:${toolCallID}` : `${entryID}:result`,
              role: 'tool',
              text,
              timestamp,
              label: boundedLabel(message.toolName),
              isError: message.isError === true,
              toolCallID,
              toolOutput: text,
              toolStatus: message.isError === true ? 'error' : 'completed',
              ...itemMetadata,
            });
            if (toolCallID) toolItemIndexes.set(toolCallID, itemIndex);
          } else {
            setToolOutput(existingIndex, text, message.isError === true, boundedLabel(message.toolName));
          }
        }
        continue;
      }
      if (message.role === 'bashExecution') {
        appendItem({
          id: `${entryID}:bash`,
          role: 'tool',
          text: typeof message.output === 'string' ? message.output : '',
          timestamp,
          label: boundedLabel(message.command),
          isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
          toolInput: typeof message.command === 'string' ? message.command : null,
          toolOutput: typeof message.output === 'string' ? message.output : '',
          toolStatus: typeof message.exitCode === 'number' && message.exitCode !== 0 ? 'error' : 'completed',
          ...itemMetadata,
        });
      } else if ((message.role === 'custom' || message.role === 'hookMessage') && message.display !== false) {
        const text = extractTextContent(message.content);
        if (text) {
          appendItem({
            id: `${entryID}:custom-message`,
            role: 'system',
            text,
            timestamp,
            label: boundedLabel(message.customType ?? message.hookName),
            isError: false,
            ...itemMetadata,
          });
        }
      }
      continue;
    }

    if (entry.type === 'custom_message' && entry.display !== false) {
      const text = extractTextContent(entry.content);
      if (text) appendItem({ id: `${entryID}:custom`, role: 'system', text, timestamp, label: boundedLabel(entry.customType), isError: false, ...currentMetadata() });
    } else if (entry.type === 'compaction' && typeof entry.summary === 'string' && entry.summary.trim()) {
      appendItem({ id: `${entryID}:compaction`, role: 'system', text: entry.summary, timestamp, label: null, isError: false, ...currentMetadata() });
    } else if (entry.type === 'branch_summary' && typeof entry.summary === 'string' && entry.summary.trim()) {
      appendItem({ id: `${entryID}:branch`, role: 'system', text: entry.summary, timestamp, label: null, isError: false, ...currentMetadata() });
    }
  }
  return transcriptItems;
};

const messageIdentity = (message, index) => {
  const role = typeof message?.role === 'string' ? message.role : 'message';
  const timestamp = Number.isFinite(message?.timestamp) ? Number(message.timestamp) : index;
  const toolCallID = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
  return `${role}-${timestamp}-${toolCallID}-${index}`;
};

const runtimeMessageIdentity = (message) => {
  const role = typeof message?.role === 'string' ? message.role : null;
  const timestamp = Number.isFinite(message?.timestamp) ? Number(message.timestamp) : null;
  if (!role || timestamp === null) return null;
  const toolCallID = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
  return `${role}:${timestamp}:${toolCallID}`;
};

const transcriptItemIdentity = (item) => (
  `${item.role}\0${item.timestamp ?? ''}\0${item.label ?? ''}\0${item.isError}`
);

const transcriptItemContentIdentity = (item) => (
  `${item.role}\0${item.label ?? ''}\0${item.isError}\0${item.text}`
);

const transcriptItemsFromMessages = (messages, toolExecutions = [], streamingContent = null) => {
  const transcriptItems = transcriptItemsFromBranch(messages.map((message, index) => ({
    id: `live-${messageIdentity(message, index)}`,
    parentId: null,
    timestamp: Number.isFinite(message?.timestamp) && !Number.isNaN(new Date(message.timestamp).valueOf())
      ? new Date(message.timestamp).toISOString()
      : undefined,
    type: 'message',
    message,
    streamingContentIndex: streamingContent?.messageIdentity === runtimeMessageIdentity(message)
      ? streamingContent.contentIndex
      : null,
  })));
  const toolIndexes = new Map();
  transcriptItems.forEach((item, index) => {
    if (item.toolCallID) toolIndexes.set(item.toolCallID, index);
  });
  for (const execution of toolExecutions) {
    const toolCallID = boundedLabel(execution?.callID);
    if (!toolCallID) continue;
    const toolInput = execution.input === null || execution.input === undefined
      ? null
      : stringifyValue(execution.input);
    const toolOutput = typeof execution.output === 'string' ? execution.output : null;
    const toolStatus = execution.status === 'error'
      ? 'error'
      : execution.status === 'completed'
        ? 'completed'
        : 'running';
    const existingIndex = toolIndexes.get(toolCallID);
    if (existingIndex === undefined) {
      toolIndexes.set(toolCallID, transcriptItems.length);
      transcriptItems.push({
        id: `tool:${toolCallID}`,
        role: 'tool',
        text: toolInput ?? toolOutput ?? '',
        timestamp: null,
        label: boundedLabel(execution.name),
        isError: toolStatus === 'error',
        providerID: null,
        modelID: null,
        reasoningEffort: null,
        usage: null,
        stopReason: null,
        streaming: toolStatus === 'running',
        toolCallID,
        toolInput,
        toolOutput,
        toolStatus,
      });
      continue;
    }
    const current = transcriptItems[existingIndex];
    transcriptItems[existingIndex] = {
      ...current,
      label: boundedLabel(execution.name) ?? current.label,
      isError: toolStatus === 'error',
      streaming: toolStatus === 'running',
      toolInput: toolInput ?? current.toolInput,
      toolOutput: toolOutput ?? current.toolOutput,
      toolStatus,
    };
  }
  const totalTextBytes = transcriptItems.reduce(
    (total, item) => total + Buffer.byteLength(item.text, 'utf8') + Buffer.byteLength(item.toolOutput ?? '', 'utf8'),
    0,
  );
  if (transcriptItems.length > MAX_TRANSCRIPT_ITEMS || totalTextBytes > MAX_TRANSCRIPT_TEXT_BYTES) {
    throw createRouteError(413, 'transcript-too-large', 'Prime Agent transcript is too large to display');
  }
  return transcriptItems;
};

const summaryFromLiveSession = (liveSummary, fallbackTitle = null) => ({
  id: liveSummary.id,
  title: liveSummary.title ?? fallbackTitle,
  directory: liveSummary.directory,
  createdAt: liveSummary.createdAt,
  updatedAt: liveSummary.updatedAt,
  activity: liveSummary.activity,
  interactive: true,
  parentID: liveSummary.parentID ?? null,
  depth: liveSummary.depth ?? 0,
});

const selectRecentLiveMessages = (messages) => {
  const selected = [];
  let selectedBytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    let messageBytes;
    try {
      messageBytes = Buffer.byteLength(JSON.stringify(messages[index]), 'utf8');
    } catch {
      continue;
    }
    if (messageBytes > MAX_LIVE_TRANSCRIPT_SOURCE_BYTES) continue;
    if (selectedBytes + messageBytes > MAX_LIVE_TRANSCRIPT_SOURCE_BYTES) break;
    selected.unshift(messages[index]);
    selectedBytes += messageBytes;
  }
  return selected;
};

const transcriptFromLiveSession = (live, fallbackTranscript = null) => {
  const recentMessages = selectRecentLiveMessages(live.messages);
  const liveItems = transcriptItemsFromMessages(recentMessages, live.toolExecutions, live.streamingContent);
  const items = fallbackTranscript ? [...fallbackTranscript.items] : [];
  const idIndexes = new Map(items.map((item, index) => [item.id, index]));
  const itemIndexes = new Map();
  const contentIndexes = new Map();
  items.forEach((item, index) => {
    const identity = transcriptItemIdentity(item);
    const indexes = itemIndexes.get(identity) ?? [];
    indexes.push(index);
    itemIndexes.set(identity, indexes);
    const contentIdentity = transcriptItemContentIdentity(item);
    const matchingContent = contentIndexes.get(contentIdentity) ?? [];
    matchingContent.push(index);
    contentIndexes.set(contentIdentity, matchingContent);
  });
  const liveIdentityCounts = new Map();
  const matchedContentIndexes = new Set();
  for (const item of liveItems) {
    const matchingIDIndex = idIndexes.get(item.id);
    if (matchingIDIndex !== undefined) {
      items[matchingIDIndex] = {
        ...item,
        branchEntryID: items[matchingIDIndex].branchEntryID,
      };
      continue;
    }
    const identity = transcriptItemIdentity(item);
    const occurrence = liveIdentityCounts.get(identity) ?? 0;
    liveIdentityCounts.set(identity, occurrence + 1);
    const existingIndex = itemIndexes.get(identity)?.[occurrence];
    if (existingIndex === undefined) {
      const contentIdentity = transcriptItemContentIdentity(item);
      const liveTimestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
      const matchingContentIndex = contentIndexes.get(contentIdentity)?.findLast((index) => {
        if (matchedContentIndexes.has(index)) return false;
        const storedTimestamp = items[index]?.timestamp ? Date.parse(items[index].timestamp) : Number.NaN;
        return Number.isFinite(liveTimestamp)
          && Number.isFinite(storedTimestamp)
          && Math.abs(liveTimestamp - storedTimestamp) <= 10_000;
      });
      if (matchingContentIndex !== undefined) {
        matchedContentIndexes.add(matchingContentIndex);
        continue;
      }
      items.push(item);
    } else {
      items[existingIndex] = {
        ...item,
        branchEntryID: items[existingIndex].branchEntryID,
      };
    }
  }
  return {
    schemaVersion: 1,
    session: summaryFromLiveSession(live.summary, fallbackTranscript?.session?.title ?? null),
    sourceVersion: fallbackTranscript?.sourceVersion ?? 1,
    totalEntryCount: Math.max(fallbackTranscript?.totalEntryCount ?? 0, live.messages.length),
    branchEntryCount: Math.max(fallbackTranscript?.branchEntryCount ?? 0, live.messages.length),
    items: items.slice(-MAX_TRANSCRIPT_ITEMS),
  };
};

const readPrimeTranscript = async ({ sessionID, sessionDirectory, fsPromises, path }) => {
  if (!PRIME_SESSION_ID_PATTERN.test(sessionID)) {
    throw createRouteError(400, 'invalid-session-id', 'Invalid Prime Agent session ID');
  }

  const resolvedDirectory = path.resolve(sessionDirectory);
  const filePath = path.resolve(resolvedDirectory, `${sessionID}.jsonl`);
  if (path.dirname(filePath) !== resolvedDirectory) {
    throw createRouteError(400, 'invalid-session-id', 'Invalid Prime Agent session ID');
  }

  let pathStats;
  try {
    pathStats = await fsPromises.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
    throw error;
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
  }
  let fileHandle;
  try {
    fileHandle = await fsPromises.open(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
    throw error;
  }
  let stats;
  let source;
  try {
    stats = await fileHandle.stat();
    if (!stats.isFile() || (pathStats.ino !== 0 && (pathStats.dev !== stats.dev || pathStats.ino !== stats.ino))) {
      throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
    }
    if (stats.size > MAX_TRANSCRIPT_BYTES) {
      throw createRouteError(413, 'transcript-too-large', 'Prime Agent transcript is too large to display');
    }
    source = await readWindow(fileHandle, 0, stats.size);
  } finally {
    await fileHandle.close();
  }
  const records = parseSessionFile(source);
  const [header, ...entries] = records;
  if (!isValidSessionHeader(header, sessionID)) {
    throw createRouteError(422, 'invalid-session', 'Invalid Prime Agent session header');
  }
  if (!isRootSessionHeader(header)) {
    throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
  }
  const version = header.version ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > 3) {
    throw createRouteError(422, 'unsupported-session-version', 'Unsupported Prime Agent session version');
  }

  validateSessionTree(entries, version);
  const activeBranch = resolveActiveBranch(entries, version);
  const firstUserEntry = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'user');
  const latestNameEntry = [...entries].reverse().find((entry) => entry.type === 'session_info');
  const firstMessage = firstUserEntry ? extractTextContent(firstUserEntry.message.content) : '';
  const sessionName = typeof latestNameEntry?.name === 'string' ? latestNameEntry.name.trim() : null;
  const title = resolveSessionTitle(sessionName, firstMessage);

  return {
    session: {
      id: sessionID,
      title,
      directory: header.cwd,
      createdAt: typeof header.timestamp === 'string' ? header.timestamp : stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
      parentID: null,
      depth: 0,
    },
    sourceVersion: version,
    totalEntryCount: entries.length,
    branchEntryCount: activeBranch.length,
    items: transcriptItemsFromBranch(activeBranch, { actionableEntries: true }),
  };
};

export const registerPrimeAgentRoutes = (app, dependencies) => {
  const {
    fsPromises,
    os,
    path,
    express,
    env = process.env,
    primeAgentRuntime = null,
    validateDirectoryPath,
    isRequestOriginAllowed,
  } = dependencies;
  const sessionDirectory = resolvePrimeSessionDirectory({ env, os, path });
  const parsePromptJSON = express.json({ limit: '5mb' });
  const summaryCache = new Map();
  const transcriptCache = new Map();
  let catalogCache = null;
  let catalogCacheTimestamp = 0;
  let catalogDirectorySignature = null;
  let catalogLoad = null;
  let artifactCatalogCache = null;
  let artifactCatalogCacheKey = null;
  let artifactCatalogTimestamp = 0;
  let artifactCatalogLoad = null;
  const sameResolvedPath = (left, right) => Boolean(
    left && right && path.resolve(left) === path.resolve(right),
  );

  const getCatalog = async () => {
    let directoryStats;
    try {
      directoryStats = await fsPromises.stat(sessionDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        summaryCache.clear();
        catalogCache = { status: 'not-configured', sessions: [], skippedFileCount: 0, failedSessionIDs: [] };
        catalogCacheTimestamp = Date.now();
        catalogDirectorySignature = null;
        return catalogCache;
      }
      throw error;
    }
    const directorySignature = fileSignature(directoryStats);
    if (
      catalogCache
      && catalogDirectorySignature === directorySignature
      && Date.now() - catalogCacheTimestamp < CATALOG_MAX_AGE_MS
    ) {
      return catalogCache;
    }
    if (catalogLoad) return catalogLoad;
    catalogLoad = listPrimeSessions({ sessionDirectory, fsPromises, path, summaryCache });
    try {
      catalogCache = await catalogLoad;
      catalogCacheTimestamp = Date.now();
      catalogDirectorySignature = directorySignature;
      return catalogCache;
    } finally {
      catalogLoad = null;
    }
  };

  const getArtifactCatalog = async (catalog = null) => {
    const resolvedCatalog = catalog ?? await getCatalog();
    const rootSessionIDs = new Set(resolvedCatalog.sessions.map((session) => session.id));
    const cacheKey = [...rootSessionIDs].sort().join('\0');
    if (
      artifactCatalogCache
      && artifactCatalogCacheKey === cacheKey
      && Date.now() - artifactCatalogTimestamp < CATALOG_MAX_AGE_MS
    ) {
      return artifactCatalogCache;
    }
    if (artifactCatalogLoad) return artifactCatalogLoad;
    artifactCatalogLoad = listArtifactChildSessions({ sessionDirectory, rootSessionIDs, fsPromises, path });
    try {
      artifactCatalogCache = await artifactCatalogLoad;
      artifactCatalogCacheKey = cacheKey;
      artifactCatalogTimestamp = Date.now();
      return artifactCatalogCache;
    } finally {
      artifactCatalogLoad = null;
    }
  };

  const getSessionPath = (sessionID) => {
    if (!PRIME_SESSION_ID_PATTERN.test(sessionID)) {
      throw createRouteError(400, 'invalid-session-id', 'Prime Agent session ID is invalid');
    }
    return path.join(sessionDirectory, `${sessionID}.jsonl`);
  };
  const hasCanonicalSessionPath = (session) => sameResolvedPath(
    session.sessionFile,
    getSessionPath(session.id),
  );
  const getAuthorizedLiveChild = async (sessionID) => {
    if (!primeAgentRuntime?.getStatus().interactive) return null;
    const liveSessions = await primeAgentRuntime.listSessions({ includeChildren: true });
    const sessionsByID = new Map(liveSessions.map((session) => [session.id, session]));
    const child = sessionsByID.get(sessionID);
    if (!child?.isChild) return null;
    const visited = new Set([child.id]);
    let ancestor = child;
    while (ancestor.isChild) {
      if (!ancestor.parentID || visited.has(ancestor.parentID)) return null;
      visited.add(ancestor.parentID);
      ancestor = sessionsByID.get(ancestor.parentID);
      if (!ancestor) return null;
    }
    const catalog = await getCatalog();
    if (!catalog.sessions.some((session) => session.id === ancestor.id)) return null;
    if (!hasCanonicalSessionPath(ancestor)) return null;
    return child;
  };
  const readStoredTranscript = async (sessionID) => {
    const transcript = await readPrimeTranscript({
      sessionID,
      sessionDirectory,
      fsPromises,
      path,
    });
    transcriptCache.delete(sessionID);
    transcriptCache.set(sessionID, transcript);
    while (transcriptCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
      transcriptCache.delete(transcriptCache.keys().next().value);
    }
    return transcript;
  };
  const resolveAuthorizedSessionPath = async (sessionID) => {
    const sessionPath = getSessionPath(sessionID);
    const catalog = await getCatalog();
    if (catalog.sessions.some((session) => session.id === sessionID)) return sessionPath;
    const artifactChild = (await getArtifactCatalog(catalog)).find((session) => session.id === sessionID);
    if (artifactChild?.sessionFile) return artifactChild.sessionFile;
    const child = await getAuthorizedLiveChild(sessionID);
    if (child?.sessionFile) return child.sessionFile;
    throw createRouteError(404, 'session-not-found', 'Prime Agent session not found');
  };

  const requireAllowedOrigin = async (req, res) => {
    if (typeof isRequestOriginAllowed !== 'function' || await isRequestOriginAllowed(req)) return true;
    res.status(403).json({ schemaVersion: 1, error: 'Request origin is not allowed', code: 'origin-not-allowed' });
    return false;
  };

  const requirePrompt = (value) => {
    if (typeof value !== 'string') return null;
    const prompt = value.trim();
    return prompt && prompt.length <= MAX_PROMPT_LENGTH ? prompt : null;
  };

  const runtimeErrorResponse = (res, error, fallback) => {
    let statusCode = 502;
    if (error?.code === 'not-configured' || error?.code === 'unavailable' || error?.code === 'incompatible') {
      statusCode = 409;
    } else if (error?.code === 'command-timeout') {
      statusCode = 504;
    }
    const code = typeof error?.code === 'string' && SAFE_RUNTIME_ERROR_CODES.has(error.code)
      ? error.code
      : 'prime-runtime-failed';
    const message = typeof error?.publicMessage === 'string'
      ? error.publicMessage
      : SAFE_RUNTIME_ERROR_CODES.has(error?.code) && error instanceof Error
        ? error.message
        : fallback;
    return res.status(statusCode).json({
      schemaVersion: 1,
      error: message,
      code,
      ambiguous: error?.ambiguous === true,
      ...(error?.session ? { session: summaryFromLiveSession(error.session) } : {}),
    });
  };
  const sessionErrorResponse = (res, error, fallback) => {
    if (Number.isInteger(error?.statusCode)) {
      return res.status(error.statusCode).json({ schemaVersion: 1, error: error.message, code: error.code });
    }
    return runtimeErrorResponse(res, error, fallback);
  };
  const withAuthorizedSession = async (req, res, fallback, operation) => {
    try {
      const sessionID = req.params.sessionId;
      const sessionPath = await resolveAuthorizedSessionPath(sessionID);
      return await operation(sessionID, sessionPath);
    } catch (error) {
      return sessionErrorResponse(res, error, fallback);
    }
  };
  const acceptAuthorizedSessionOperation = (req, res, fallback, operation, input = {}) => withAuthorizedSession(
    req,
    res,
    fallback,
    async (sessionID, sessionPath) => {
      await operation({ sessionID, sessionPath, ...input });
      return res.json({ schemaVersion: 1, accepted: true });
    },
  );

  app.get('/api/prime/status', (_req, res) => {
    if (!primeAgentRuntime) {
      return res.json({
        schemaVersion: 1,
        state: 'unsupported',
        interactive: false,
        authentication: 'unknown',
        binarySource: null,
        version: null,
        message: 'Prime Agent interaction is not supported by this server',
      });
    }
    return res.json(primeAgentRuntime.getStatus());
  });

  app.post('/api/prime/reconnect', async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    if (!primeAgentRuntime) {
      return res.status(409).json({ schemaVersion: 1, error: 'Prime Agent is not supported by this server', code: 'unsupported' });
    }
    try {
      return res.json(await primeAgentRuntime.reconcile());
    } catch (error) {
      return runtimeErrorResponse(res, error, 'Failed to reconnect Prime Agent');
    }
  });

  app.get('/api/prime/sessions', async (_req, res) => {
    try {
      const catalog = await getCatalog();
      const runtimeStatus = primeAgentRuntime?.getStatus();
      let liveSessions = [];
      if (runtimeStatus?.interactive) {
        liveSessions = await primeAgentRuntime.listSessions({ includeChildren: true });
      }
      const sessionsByID = new Map(catalog.sessions.map((session) => [session.id, {
        ...session,
        activity: 'idle',
        interactive: runtimeStatus?.interactive === true,
      }]));
      const artifactChildren = await getArtifactCatalog(catalog);
      for (const child of artifactChildren) {
        sessionsByID.set(child.id, {
          ...summaryFromLiveSession(child),
          interactive: runtimeStatus?.interactive === true,
        });
      }
      for (const liveSession of liveSessions.filter((session) => !session.isChild)) {
        const current = sessionsByID.get(liveSession.id);
        if (!current) continue;
        if (!hasCanonicalSessionPath(liveSession)) continue;
        sessionsByID.set(liveSession.id, {
          ...current,
          ...summaryFromLiveSession(liveSession, current?.title ?? null),
        });
      }
      const authorizedSessionIDs = new Set(sessionsByID.keys());
      const pendingChildren = liveSessions
        .filter((session) => session.isChild)
        .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
      let addedChild = true;
      while (pendingChildren.length > 0 && addedChild) {
        addedChild = false;
        for (let index = pendingChildren.length - 1; index >= 0; index -= 1) {
          const child = pendingChildren[index];
          if (!child.parentID || !authorizedSessionIDs.has(child.parentID)) continue;
          sessionsByID.set(child.id, summaryFromLiveSession(child));
          authorizedSessionIDs.add(child.id);
          pendingChildren.splice(index, 1);
          addedChild = true;
        }
      }
      const sessions = [...sessionsByID.values()].sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
      return res.json({
        ...catalog,
        schemaVersion: 1,
        sessions,
      });
    } catch (error) {
      console.error('[PrimeAgent] failed to list sessions:', error);
      return res.status(500).json({ schemaVersion: 1, error: 'Failed to list Prime Agent sessions', code: 'catalog-failed' });
    }
  });

  app.post('/api/prime/controls', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const validated = await validateDirectoryPath?.(req.body?.directory);
    if (!validated?.ok) {
      return res.status(400).json({ schemaVersion: 1, error: validated?.error || 'Directory is required', code: 'invalid-directory' });
    }
    try {
      const controls = await primeAgentRuntime.getDraftControls(validated.directory);
      return res.json({ schemaVersion: 1, ...controls });
    } catch (error) {
      return runtimeErrorResponse(res, error, 'Failed to read Prime Agent controls');
    }
  });

  app.get('/api/prime/sessions/:sessionId/transcript', async (req, res) => {
    try {
      const sessionID = req.params.sessionId;
      const cachedLive = primeAgentRuntime?.getLiveTranscript(sessionID);
      if (cachedLive) {
        let fallback = cachedLive.summary.activity === 'working' ? transcriptCache.get(sessionID) ?? null : null;
        if (!fallback) {
          try {
            fallback = await readStoredTranscript(sessionID);
          } catch {
            // Live state remains authoritative when the optional disk fallback
            // is absent, stale, or temporarily incomplete.
          }
        }
        return res.json(transcriptFromLiveSession(cachedLive, fallback));
      }

      const transcript = await readStoredTranscript(sessionID);
      return res.json({
        ...transcript,
        schemaVersion: 1,
        session: {
          ...transcript.session,
          activity: 'idle',
          interactive: primeAgentRuntime?.getStatus().interactive === true,
        },
      });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (statusCode >= 500) console.error('[PrimeAgent] failed to read transcript:', error);
      return res.status(statusCode).json({
        schemaVersion: 1,
        error: statusCode >= 500 ? 'Failed to read Prime Agent transcript' : error.message,
        code: typeof error?.code === 'string' ? error.code : 'transcript-failed',
      });
    }
  });

  app.post('/api/prime/sessions/:sessionId/attach', async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    return await withAuthorizedSession(req, res, 'Failed to attach Prime Agent session', async (sessionID, sessionPath) => {
      const session = await primeAgentRuntime.attachSession(sessionID, sessionPath);
      return res.json({ schemaVersion: 1, session: summaryFromLiveSession(session) });
    });
  });

  app.post('/api/prime/sessions', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const prompt = requirePrompt(req.body?.prompt);
    if (!prompt) return res.status(400).json({ schemaVersion: 1, error: 'Prompt is required', code: 'invalid-prompt' });
    const validated = await validateDirectoryPath?.(req.body?.directory);
    if (!validated?.ok) {
      return res.status(400).json({ schemaVersion: 1, error: validated?.error || 'Directory is required', code: 'invalid-directory' });
    }
    const provider = boundedLabel(req.body?.provider);
    const modelID = boundedLabel(req.body?.modelID);
    const thinkingLevel = boundedLabel(req.body?.thinkingLevel);
    if ((provider === null) !== (modelID === null)) {
      return res.status(400).json({ schemaVersion: 1, error: 'Provider and model must be selected together', code: 'invalid-model' });
    }
    if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
      return res.status(400).json({ schemaVersion: 1, error: 'Thinking level is invalid', code: 'invalid-thinking-level' });
    }
    try {
      const session = await primeAgentRuntime.createSession({
        directory: validated.directory,
        prompt,
        sessionPathForID: getSessionPath,
        provider,
        modelID,
        thinkingLevel,
      });
      return res.status(201).json({ schemaVersion: 1, session: summaryFromLiveSession(session) });
    } catch (error) {
      return runtimeErrorResponse(res, error, 'Failed to create Prime Agent session');
    }
  });

  app.post('/api/prime/sessions/:sessionId/prompts', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const prompt = requirePrompt(req.body?.prompt);
    if (!prompt) return res.status(400).json({ schemaVersion: 1, error: 'Prompt is required', code: 'invalid-prompt' });
    return await acceptAuthorizedSessionOperation(
      req,
      res,
      'Failed to send Prime Agent prompt',
      (input) => primeAgentRuntime.sendPrompt(input),
      { prompt },
    );
  });

  app.post('/api/prime/sessions/:sessionId/controls', async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    return await withAuthorizedSession(req, res, 'Failed to read Prime Agent controls', async (sessionID, sessionPath) => {
      const controls = await primeAgentRuntime.getSessionControls({
        sessionID,
        sessionPath,
      });
      return res.json({ schemaVersion: 1, ...controls });
    });
  });

  app.post('/api/prime/sessions/:sessionId/model', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const provider = boundedLabel(req.body?.provider);
    const modelID = boundedLabel(req.body?.modelID);
    if (!provider || !modelID) {
      return res.status(400).json({ schemaVersion: 1, error: 'Provider and model are required', code: 'invalid-model' });
    }
    return await acceptAuthorizedSessionOperation(
      req,
      res,
      'Failed to change the Prime Agent model',
      (input) => primeAgentRuntime.setSessionModel(input),
      { provider, modelID },
    );
  });

  app.post('/api/prime/sessions/:sessionId/thinking-level', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const level = boundedLabel(req.body?.level);
    if (!level || !THINKING_LEVELS.has(level)) {
      return res.status(400).json({ schemaVersion: 1, error: 'Thinking level is invalid', code: 'invalid-thinking-level' });
    }
    return await acceptAuthorizedSessionOperation(
      req,
      res,
      'Failed to change the Prime Agent thinking level',
      (input) => primeAgentRuntime.setSessionThinkingLevel(input),
      { level },
    );
  });

  app.post('/api/prime/sessions/:sessionId/fork', parsePromptJSON, async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    const entryID = typeof req.body?.entryID === 'string' && PRIME_ENTRY_ID_PATTERN.test(req.body.entryID)
      ? req.body.entryID
      : null;
    if (!entryID) {
      return res.status(400).json({ schemaVersion: 1, error: 'Prime Agent fork target is invalid', code: 'invalid-fork-target' });
    }
    return await withAuthorizedSession(req, res, 'Failed to fork Prime Agent session', async (sessionID, sessionPath) => {
      if (!sessionPath) {
        return res.status(409).json({ schemaVersion: 1, error: 'Prime Agent child sessions cannot be forked here', code: 'unsupported' });
      }
      const authorizedTranscript = await readStoredTranscript(sessionID);
      const authorizedEntry = authorizedTranscript?.items.find(
        (item) => item.role === 'user' && item.branchEntryID === entryID,
      ) ?? null;
      if (!authorizedEntry) {
        return res.status(409).json({ schemaVersion: 1, error: 'Prime Agent fork target is no longer active', code: 'stale-fork-target' });
      }
      const result = await primeAgentRuntime.forkSession({
        sessionID,
        sessionPath,
        entryID,
        position: 'before',
        selectedText: authorizedEntry.text,
        sessionPathForID: getSessionPath,
      });
      catalogCacheTimestamp = 0;
      return res.json({
        schemaVersion: 1,
        session: summaryFromLiveSession(result.session),
        selectedText: result.selectedText,
        cancelled: result.cancelled,
      });
    });
  });

  app.post('/api/prime/sessions/:sessionId/abort', async (req, res) => {
    if (!await requireAllowedOrigin(req, res)) return;
    return await acceptAuthorizedSessionOperation(
      req,
      res,
      'Failed to abort Prime Agent session',
      (input) => primeAgentRuntime.abortSession(input),
    );
  });
};
