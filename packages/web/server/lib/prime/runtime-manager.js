import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrimeServiceError } from './errors.js';
import { PrimeDaemonConnection, PrimeDaemonProtocolError } from './daemon-protocol.js';
import {
  appendPrimeTranscriptRecord,
  createPrimePublicSnapshot,
  createPrimeTranscriptProjection,
  isRecord,
  normalizePrimeAvailableModels,
  normalizePrimeSessionEvent,
  normalizePrimeSessionStats,
} from './public-runtime.js';
import { openContainedRegularFile, readBoundedHeader } from './secure-files.js';

const PUBLIC_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SOURCE_MESSAGE_COUNT = 100_000;
const MAX_DAEMON_SESSION_COUNT = 2_000;
const MAX_SNAPSHOT_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_EVENT_COUNT = 2_000;
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const RESYNC_BEGIN_TIMEOUT_MS = 5_000;
const ATTACH_TIMEOUT_MS = 30_000;
const DETACH_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 2_000;
const INACTIVE_CACHE_LIMIT = 16;
const ACTIVE_RUNTIME_LIMIT = 8;
const SUBSCRIBER_LIMIT = 16;
const IDEMPOTENCY_LIMIT = 64;
const IDEMPOTENCY_TTL_MS = 15 * 60_000;
const MUTATION_TIMEOUT_MS = 30_000;
const MUTATION_RESNAPSHOT_WAIT_MS = 10_000;
const MESSAGE_UPDATE_FLUSH_MS = 50;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_WORKING_DIRECTORY_BYTES = 16 * 1024;
const CREATE_ROOT_TIMEOUT_MS = 30_000;
const CREATE_ROOT_IN_FLIGHT_LIMIT = 4;
const SAFE_FENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,128}$/;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Keep this schema-13 set aligned with normalizePrimeSessionEvent and applyActivityCauses.
const PROJECTED_SESSION_EVENT_TYPES = new Set([
  'agent_start',
  'agent_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'bash_start',
  'bash_end',
  'thinking_level_changed',
  'recap_update',
]);
const SAFE_PRIVATE_ID = /^[A-Za-z0-9:._-]{1,256}$/;
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

const fixedRuntimeError = (code = 'prime_runtime_unavailable') => {
  if (code === 'prime_daemon_incompatible') {
    return new PrimeServiceError(409, code, 'The Prime daemon protocol is incompatible');
  }
  if (code === 'prime_snapshot_unavailable') {
    return new PrimeServiceError(503, code, 'The Prime live snapshot is unavailable');
  }
  return new PrimeServiceError(503, 'prime_runtime_unavailable', 'The Prime runtime is unavailable');
};

const mutationError = (statusCode, code, message) => new PrimeServiceError(statusCode, code, message);
const invalidMutation = () => mutationError(400, 'prime_invalid_mutation', 'Invalid Prime mutation request');
const invalidCreation = () => new PrimeServiceError(
  400,
  'prime_invalid_creation',
  'Invalid Prime creation request',
);
const creationFailed = (statusCode) => new PrimeServiceError(
  statusCode,
  'prime_creation_failed',
  'Prime session creation failed',
);
const creationUncertain = () => new PrimeServiceError(
  503,
  'prime_creation_uncertain',
  'Prime session creation may have succeeded; check the Prime session list before trying again',
);
const creationConfigurationUnavailable = () => new PrimeServiceError(
  409,
  'prime_creation_configuration_unavailable',
  'The selected Prime creation configuration is no longer authoritative',
);

const isBoundedSelector = (value) => typeof value === 'string'
  && value.length > 0
  && value === value.trim()
  && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);

const normalizeCreationRequest = (body) => {
  if (!isRecord(body)
    || !Object.hasOwn(body, 'workingDirectory')
    || !Object.hasOwn(body, 'message')
    || typeof body.workingDirectory !== 'string'
    || !body.workingDirectory
    || !path.isAbsolute(body.workingDirectory)
    || Buffer.byteLength(body.workingDirectory, 'utf8') > MAX_WORKING_DIRECTORY_BYTES
    || /[\u0000-\u001f\u007f-\u009f]/u.test(body.workingDirectory)
    || typeof body.message !== 'string'
    || !body.message.trim()
    || Buffer.byteLength(body.message, 'utf8') > MAX_PROMPT_BYTES) {
    throw invalidCreation();
  }
  const configured = Object.hasOwn(body, 'sourceSessionId');
  if (!configured) {
    if (Object.keys(body).length !== 2) throw invalidCreation();
    return { workingDirectory: body.workingDirectory, message: body.message, configuration: null };
  }
  const hasThinkingLevel = Object.hasOwn(body, 'thinkingLevel');
  const expectedKeys = new Set([
    'workingDirectory',
    'message',
    'sourceSessionId',
    'generation',
    'revision',
    'provider',
    'modelId',
    ...(hasThinkingLevel ? ['thinkingLevel'] : []),
  ]);
  if (Object.keys(body).length !== expectedKeys.size
    || Object.keys(body).some((key) => !expectedKeys.has(key))
    || typeof body.sourceSessionId !== 'string'
    || !PUBLIC_SESSION_ID.test(body.sourceSessionId)
    || typeof body.generation !== 'string'
    || !SAFE_FENCE_ID.test(body.generation)
    || !Number.isSafeInteger(body.revision)
    || body.revision < 1
    || !isBoundedSelector(body.provider)
    || !isBoundedSelector(body.modelId)
    || (hasThinkingLevel && !THINKING_LEVELS.has(body.thinkingLevel))) {
    throw invalidCreation();
  }
  return {
    workingDirectory: body.workingDirectory,
    message: body.message,
    configuration: {
      sourceSessionId: body.sourceSessionId,
      generation: body.generation,
      revision: body.revision,
      provider: body.provider,
      modelId: body.modelId,
      ...(hasThinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
    },
  };
};

const normalizeMutationRequest = (action, body) => {
  if (!isRecord(body)) throw invalidMutation();
  const expected = new Set(['generation', 'revision', 'turnToken', 'idempotencyKey']);
  if (action === 'prompt') expected.add('message');
  else if (action === 'set_model') {
    expected.add('provider');
    expected.add('modelId');
  } else if (action === 'set_thinking_level') expected.add('level');
  else if (action !== 'abort') throw invalidMutation();
  if (Object.keys(body).some((key) => !expected.has(key))
    || !SAFE_FENCE_ID.test(body.generation)
    || !Number.isSafeInteger(body.revision)
    || body.revision < 1
    || !SAFE_FENCE_ID.test(body.turnToken)
    || !SAFE_IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    throw invalidMutation();
  }
  const request = {
    action,
    generation: body.generation,
    revision: body.revision,
    turnToken: body.turnToken,
    idempotencyKey: body.idempotencyKey,
  };
  if (action === 'prompt') {
    if (typeof body.message !== 'string'
      || !body.message.trim()
      || Buffer.byteLength(body.message, 'utf8') > MAX_PROMPT_BYTES) throw invalidMutation();
    request.message = body.message;
  } else if (action === 'set_model') {
    for (const value of [body.provider, body.modelId]) {
      if (typeof value !== 'string'
        || !value
        || value !== value.trim()
        || value.length > 160
        || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        throw invalidMutation();
      }
    }
    request.provider = body.provider;
    request.modelId = body.modelId;
  } else if (action === 'set_thinking_level') {
    if (!THINKING_LEVELS.has(body.level)) throw invalidMutation();
    request.level = body.level;
  }
  const fingerprintPayload = { action };
  if (action === 'prompt') fingerprintPayload.message = request.message;
  else if (action === 'set_model') {
    fingerprintPayload.provider = request.provider;
    fingerprintPayload.modelId = request.modelId;
  } else if (action === 'set_thinking_level') fingerprintPayload.level = request.level;
  request.fingerprint = createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('base64url');
  return request;
};

const defaultDaemonSocketPath = () => {
  if (process.platform === 'win32') return '\\\\.\\pipe\\prime-agent-daemon';
  const suffix = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(os.tmpdir(), `prime-agent-${suffix}`, 'daemon.sock');
};

const delay = (milliseconds) => new Promise((resolve) => {
  const timeout = setTimeout(resolve, milliseconds);
  timeout.unref?.();
});

const requestData = async (connection, command, timeoutMs) => {
  const response = await connection.request(command, timeoutMs);
  if (!response.success) throw new PrimeDaemonProtocolError('prime_daemon_command_failed');
  return response.data;
};

const validateSocketBoundary = async (socketPath) => {
  if (process.platform === 'win32') return;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(path.dirname(socketPath));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new PrimeDaemonProtocolError('prime_daemon_socket_unsafe');
  }
  if (!directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || (expectedUid !== undefined && directoryMetadata.uid !== expectedUid)
    || (directoryMetadata.mode & 0o077) !== 0) {
    throw new PrimeDaemonProtocolError('prime_daemon_socket_unsafe');
  }
  let socketMetadata;
  try {
    socketMetadata = await lstat(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new PrimeDaemonProtocolError('prime_daemon_socket_unsafe');
  }
  if (!socketMetadata.isSocket()
    || socketMetadata.isSymbolicLink()
    || (expectedUid !== undefined && socketMetadata.uid !== expectedUid)
    || (socketMetadata.mode & 0o077) !== 0) {
    throw new PrimeDaemonProtocolError('prime_daemon_socket_unsafe');
  }
};

const executableLaunchSpec = async (candidate) => {
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = await realpath(candidate);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) return null;
    await access(resolved, fsConstants.X_OK);
    if (process.platform === 'win32' && ['.js', '.mjs', '.cjs'].includes(path.extname(resolved).toLowerCase())) {
      return { executable: process.execPath, prefixArgs: [resolved] };
    }
    if (process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(resolved).toLowerCase())) {
      return null;
    }
    return { executable: resolved, prefixArgs: [] };
  } catch {
    return null;
  }
};

const resolvePrimeLaunchSpec = async ({ env, buildAugmentedPath }) => {
  if (typeof env.PRIME_AGENT_CLI_PATH === 'string' && env.PRIME_AGENT_CLI_PATH.trim()) {
    const configuredPath = env.PRIME_AGENT_CLI_PATH.trim();
    return path.isAbsolute(configuredPath) ? executableLaunchSpec(configuredPath) : null;
  }
  let searchPath = env.PATH || '';
  try {
    if (typeof buildAugmentedPath === 'function') searchPath = buildAugmentedPath() || searchPath;
  } catch {
    // The inherited PATH remains the bounded fallback.
  }
  const names = process.platform === 'win32'
    ? ['pi.exe', 'prime-agent.exe', 'pi', 'prime-agent']
    : ['pi', 'prime-agent'];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const spec = await executableLaunchSpec(path.join(directory, name));
      if (spec) return spec;
    }
  }
  return null;
};

const safeLaunchEnvironment = (env, augmentedPath) => {
  const launchEnv = { ...env, ...(augmentedPath ? { PATH: augmentedPath } : {}) };
  for (const key of Object.keys(launchEnv)) {
    if (key.startsWith('PRIME_AGENT_INTERNAL_')) delete launchEnv[key];
  }
  return launchEnv;
};

const validateActivationEntity = async (entity) => {
  const opened = await openContainedRegularFile(entity.filePath, entity.containmentRoot).catch(() => {
    throw new PrimeServiceError(404, 'prime_session_unavailable', 'Prime session is unavailable');
  });
  try {
    const header = await readBoundedHeader(opened);
    if (header?.type !== 'session'
      || header.id !== entity.sessionId
      || path.basename(opened.realPath) !== `${entity.sessionId}.jsonl`
      || opened.realPath !== entity.filePath) {
      throw new PrimeServiceError(404, 'prime_session_unavailable', 'Prime session is unavailable');
    }
    if (typeof header.cwd !== 'string'
      || !header.cwd
      || !path.isAbsolute(header.cwd)
      || path.normalize(header.cwd) !== header.cwd) {
      throw new PrimeServiceError(409, 'prime_session_not_activatable', 'Prime session cannot be activated');
    }
    let workingDirectory;
    let workingDirectoryStat;
    try {
      workingDirectory = await realpath(header.cwd);
      workingDirectoryStat = await stat(workingDirectory);
    } catch {
      throw new PrimeServiceError(409, 'prime_session_not_activatable', 'Prime session cannot be activated');
    }
    if (!workingDirectoryStat.isDirectory()) {
      throw new PrimeServiceError(409, 'prime_session_not_activatable', 'Prime session cannot be activated');
    }
    return { ...entity, filePath: opened.realPath, workingDirectory };
  } finally {
    await opened.handle.close();
  }
};

const readSummaryActiveSessionId = (summary, allowDurableId = false) => {
  const activeSessionId = summary?.activeSessionId ?? (allowDurableId ? summary?.id : null);
  return typeof activeSessionId === 'string' && SAFE_PRIVATE_ID.test(activeSessionId) ? activeSessionId : null;
};

const summaryMatchesEntity = async (summary, entity, allowDurableId = false) => {
  if (!isRecord(summary)
    || summary.sessionId !== entity.sessionId
    || !readSummaryActiveSessionId(summary, allowDurableId)
    || typeof summary.sessionFile !== 'string'
    || !path.isAbsolute(summary.sessionFile)) return false;
  try {
    return await realpath(summary.sessionFile) === entity.filePath;
  } catch {
    return false;
  }
};

const readLiveSummaries = (payload) => {
  if (!isRecord(payload)
    || !Array.isArray(payload.sessions)
    || payload.sessions.length > MAX_DAEMON_SESSION_COUNT) {
    throw new PrimeDaemonProtocolError('prime_daemon_invalid_session_list');
  }
  return payload.sessions;
};

const matchingLiveSummaries = async (payload, entity) => {
  const summaries = readLiveSummaries(payload);
  const matches = await Promise.all(summaries.map(async (summary) => (
    await summaryMatchesEntity(summary, entity) ? summary : null
  )));
  return matches.filter(Boolean);
};

const validCursor = (cursor, lastEventSequence) => (
  isRecord(cursor)
  && typeof cursor.generation === 'string'
  && SAFE_PRIVATE_ID.test(cursor.generation)
  && Number.isSafeInteger(cursor.sequence)
  && cursor.sequence >= 0
  && cursor.sequence === lastEventSequence
);

const cursorsEqual = (left, right) => (
  left?.generation === right?.generation && left?.sequence === right?.sequence
);

const snapshotIdentityValid = (snapshot, sessionId, activeSessionId) => (
  isRecord(snapshot)
  && snapshot.activeSessionId === activeSessionId
  && isRecord(snapshot.summary)
  && snapshot.summary.sessionId === sessionId
  && isRecord(snapshot.state)
  && snapshot.state.sessionId === sessionId
  && snapshot.state.activeSessionId === activeSessionId
);

class PrimeSnapshotStage {
  constructor(begin, sessionId, activeSessionId, workingDirectory) {
    if (!SAFE_PRIVATE_ID.test(begin.snapshotId)
      || begin.activeSessionId !== activeSessionId
      || !snapshotIdentityValid(begin.snapshot, sessionId, activeSessionId)
      || !Number.isSafeInteger(begin.messageCount)
      || begin.messageCount < 0
      || begin.messageCount > MAX_SOURCE_MESSAGE_COUNT
      || begin.snapshot.summary.messageCount !== begin.messageCount
      || !Number.isSafeInteger(begin.targetChunkBytes)
      || begin.targetChunkBytes <= 0) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot');
    }
    this.id = begin.snapshotId;
    this.purpose = begin.purpose || 'attach';
    if (!['attach', 'replacement', 'resync'].includes(this.purpose)) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot');
    }
    this.sessionId = sessionId;
    this.activeSessionId = activeSessionId;
    this.header = begin.snapshot;
    this.messageCount = begin.messageCount;
    this.nextChunkIndex = 0;
    this.receivedMessages = 0;
    this.sourceBytes = 0;
    this.projector = createPrimeTranscriptProjection(workingDirectory);
    this.timeout = null;
  }

  addChunk(chunk) {
    if (chunk.activeSessionId !== this.activeSessionId
      || chunk.snapshotId !== this.id
      || chunk.index !== this.nextChunkIndex
      || !Array.isArray(chunk.messages)) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot');
    }
    this.sourceBytes += Buffer.byteLength(JSON.stringify(chunk.messages));
    this.receivedMessages += chunk.messages.length;
    if (this.sourceBytes > MAX_SNAPSHOT_SOURCE_BYTES || this.receivedMessages > this.messageCount) {
      throw new PrimeDaemonProtocolError('prime_daemon_snapshot_limit');
    }
    for (const message of chunk.messages) this.projector.add(message);
    this.nextChunkIndex += 1;
  }

  finish(end) {
    if (end.activeSessionId !== this.activeSessionId
      || end.snapshotId !== this.id
      || !Number.isSafeInteger(end.chunkCount)
      || end.chunkCount !== this.nextChunkIndex
      || this.receivedMessages !== this.messageCount
      || !Number.isSafeInteger(end.lastEventSequence)
      || end.lastEventSequence < 0
      || !validCursor(end.lastEventCursor, end.lastEventSequence)
      || this.header.lastEventSequence !== end.lastEventSequence
      || !validCursor(this.header.lastEventCursor, this.header.lastEventSequence)
      || !cursorsEqual(this.header.lastEventCursor, end.lastEventCursor)) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot');
    }
    const transcript = this.projector.result();
    if (transcript.sourceMessageCount !== this.messageCount) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot');
    }
    return {
      id: this.id,
      purpose: this.purpose,
      snapshot: this.header,
      transcript,
      cursor: end.lastEventCursor,
      lastEventSequence: end.lastEventSequence,
    };
  }
}

class PrimeRuntimeAttempt {
  constructor(runtime, connection, entity, activeSessionId) {
    this.runtime = runtime;
    this.connection = connection;
    this.entity = entity;
    this.activeSessionId = activeSessionId;
    this.stage = null;
    this.completedStage = null;
    this.resyncBeginTimeout = null;
    this.ready = false;
    this.closed = false;
    this.unsubscribeMessage = connection.onMessage((message) => this.handleMessage(message));
    this.unsubscribeClose = connection.onClose((error) => this.handleClose(error));
  }

  dispose() {
    this.releaseConnection()?.close();
  }

  releaseConnection() {
    if (this.closed) return null;
    this.closed = true;
    this.clearStage();
    this.unsubscribeMessage();
    this.unsubscribeClose();
    return this.connection;
  }

  clearStage() {
    if (this.stage?.timeout) clearTimeout(this.stage.timeout);
    if (this.resyncBeginTimeout) clearTimeout(this.resyncBeginTimeout);
    this.stage = null;
    this.resyncBeginTimeout = null;
  }

  waitForResyncBegin() {
    if (this.closed || this.stage || this.resyncBeginTimeout) return;
    this.resyncBeginTimeout = setTimeout(() => {
      this.resyncBeginTimeout = null;
      this.runtime.handleAttemptFailure(this, new PrimeDaemonProtocolError('prime_daemon_snapshot_resync_timeout'));
    }, RESYNC_BEGIN_TIMEOUT_MS);
    this.resyncBeginTimeout.unref?.();
  }

  handleClose(error) {
    if (this.closed) return;
    this.runtime.handleAttemptFailure(this, error);
  }

  handleMessage(message) {
    if (this.closed || message.type === 'daemon_hello') return;
    try {
      if (message.type === 'session_snapshot_begin') {
        if (this.stage) throw new PrimeDaemonProtocolError('prime_daemon_overlapping_snapshot');
        if (this.resyncBeginTimeout) clearTimeout(this.resyncBeginTimeout);
        this.resyncBeginTimeout = null;
        this.runtime.blockAuthority(this, 'resynchronizing');
        this.stage = new PrimeSnapshotStage(
          message,
          this.entity.sessionId,
          this.activeSessionId,
          this.entity.workingDirectory,
        );
        this.stage.timeout = setTimeout(() => {
          this.runtime.handleAttemptFailure(this, new PrimeDaemonProtocolError('prime_daemon_snapshot_timeout'));
        }, SNAPSHOT_TIMEOUT_MS);
        this.stage.timeout.unref?.();
        return;
      }
      if (message.type === 'session_snapshot_chunk') {
        if (!this.stage || message.snapshotId !== this.stage.id) {
          throw new PrimeDaemonProtocolError('prime_daemon_snapshot_without_begin');
        }
        this.stage.addChunk(message);
        return;
      }
      if (message.type === 'session_snapshot_end') {
        if (!this.stage || message.snapshotId !== this.stage.id) {
          throw new PrimeDaemonProtocolError('prime_daemon_snapshot_without_begin');
        }
        const completed = this.stage.finish(message);
        clearTimeout(this.stage.timeout);
        this.stage = null;
        this.completedStage = completed;
        if (this.ready) {
          void this.runtime.completeSnapshotStage(this, completed).catch((error) => {
            this.runtime.handleAttemptFailure(this, error);
          });
        }
        return;
      }
      if (message.type === 'session_snapshot_failed') {
        throw new PrimeDaemonProtocolError('prime_daemon_snapshot_failed');
      }
      this.runtime.handleDaemonMessage(this, message);
    } catch (error) {
      this.runtime.handleAttemptFailure(this, error);
    }
  }
}

class PrimeSessionRuntime {
  constructor(manager, entity) {
    this.manager = manager;
    this.entity = entity;
    this.sessionId = entity.sessionId;
    this.desiredActive = false;
    this.attempt = null;
    this.pendingConnection = null;
    this.activationPromise = null;
    this.reconnectPromise = null;
    this.cachedSnapshot = null;
    this.publicRevision = 0;
    this.publicGeneration = randomUUID();
    this.turnToken = randomUUID();
    this.sourceCursor = null;
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    this.pendingMessageUpdate = null;
    this.messageUpdateTimer = null;
    this.authorityBlocked = true;
    this.activityCauses = new Set();
    this.abortPending = false;
    this.idempotency = new Map();
    this.mutationInFlight = false;
    this.statsRefreshPromise = null;
    this.statsRefreshQueued = false;
    this.subscribers = new Set();
    this.lastAccessedAt = Date.now();
  }

  async activate(entity) {
    this.entity = entity;
    this.desiredActive = true;
    this.lastAccessedAt = Date.now();
    if (this.cachedSnapshot?.freshness.state === 'fresh' && this.attempt?.ready) {
      return this.cachedSnapshot;
    }
    if (!this.activationPromise) {
      this.activationPromise = this.connectAndSnapshot(entity, true).finally(() => {
        this.activationPromise = null;
      });
    }
    try {
      return await this.activationPromise;
    } catch (error) {
      if (!this.cachedSnapshot) this.desiredActive = false;
      throw error;
    }
  }

  async connectAndSnapshot(entity, allowWorkerRetry) {
    let connection;
    let attempt;
    try {
      connection = await this.manager.connectDaemon();
      this.pendingConnection = connection;
      if (!this.desiredActive) throw new PrimeDaemonProtocolError('prime_runtime_deactivated');
      const listPayload = await requestData(connection, { type: 'list' }, ATTACH_TIMEOUT_MS);
      if (!this.desiredActive) throw new PrimeDaemonProtocolError('prime_runtime_deactivated');
      let matches = await matchingLiveSummaries(listPayload, entity);
      if (matches.length > 1) throw new PrimeDaemonProtocolError('prime_daemon_duplicate_session');
      let summary = matches[0];
      let createdSummary = false;
      if (!summary) {
        try {
          const created = await requestData(connection, {
            type: 'create',
            sessionPath: entity.filePath,
            config: {
              cwd: entity.workingDirectory,
              agentDir: this.manager.agentRoot,
              sessionDir: path.dirname(entity.filePath),
            },
          }, ATTACH_TIMEOUT_MS);
          if (!await summaryMatchesEntity(created, entity, true)) {
            throw new PrimeDaemonProtocolError('prime_daemon_invalid_create_response');
          }
          summary = created;
          createdSummary = true;
        } catch (error) {
          if (!this.desiredActive) throw new PrimeDaemonProtocolError('prime_runtime_deactivated');
          const retryPayload = await requestData(connection, { type: 'list' }, ATTACH_TIMEOUT_MS);
          matches = await matchingLiveSummaries(retryPayload, entity);
          if (matches.length !== 1) throw error;
          [summary] = matches;
        }
      }
      if (!this.desiredActive) throw new PrimeDaemonProtocolError('prime_runtime_deactivated');
      let activeSessionId = readSummaryActiveSessionId(summary, createdSummary);
      if (!activeSessionId) throw new PrimeDaemonProtocolError('prime_daemon_invalid_session_list');
      const attachCommand = () => ({
        type: 'attach',
        activeSessionId,
        supportsExtensionUi: false,
        clientId: `openchamber-prime:${randomUUID()}`,
        capabilities: ['attach_snapshot', 'event_sequence', 'slim_attach', 'chunked_snapshot'],
      });
      attempt = new PrimeRuntimeAttempt(this, connection, entity, activeSessionId);
      this.pendingConnection = null;
      this.replaceAttempt(attempt);
      let attachResponse = await connection.request(attachCommand(), ATTACH_TIMEOUT_MS);
      if (!attachResponse.success
        && attachResponse.error === 'Session worker is not connected'
        && allowWorkerRetry) {
        attempt.releaseConnection();
        if (this.attempt === attempt) this.attempt = null;
        attempt = null;
        const retryResponse = await connection.request({ type: 'retry_worker', activeSessionId }, ATTACH_TIMEOUT_MS);
        if (!retryResponse.success) throw new PrimeDaemonProtocolError('prime_daemon_worker_retry_failed');
        const recoveredList = await requestData(connection, { type: 'list' }, ATTACH_TIMEOUT_MS);
        matches = await matchingLiveSummaries(recoveredList, entity);
        if (matches.length !== 1) throw new PrimeDaemonProtocolError('prime_daemon_worker_retry_invalid');
        [summary] = matches;
        activeSessionId = readSummaryActiveSessionId(summary);
        if (!activeSessionId) throw new PrimeDaemonProtocolError('prime_daemon_worker_retry_invalid');
        if (!this.desiredActive) throw new PrimeDaemonProtocolError('prime_runtime_deactivated');
        attempt = new PrimeRuntimeAttempt(this, connection, entity, activeSessionId);
        this.replaceAttempt(attempt);
        attachResponse = await connection.request(attachCommand(), ATTACH_TIMEOUT_MS);
      }
      if (!attachResponse.success) throw new PrimeDaemonProtocolError('prime_daemon_command_failed');
      const completed = await this.readAttachSnapshot(attempt, attachResponse.data);
      if (!this.desiredActive || this.attempt !== attempt) {
        throw new PrimeDaemonProtocolError('prime_runtime_activation_superseded');
      }
      const [availableModels, sessionStats] = await Promise.all([
        this.readAvailableModels(attempt),
        this.readSessionStats(attempt).catch(() => null),
      ]);
      attempt.ready = true;
      if (!this.commitSnapshotStage(attempt, completed, availableModels, sessionStats)) {
        throw new PrimeDaemonProtocolError('prime_runtime_activation_superseded');
      }
      return this.cachedSnapshot;
    } catch (error) {
      attempt?.dispose();
      if (this.attempt === attempt) this.attempt = null;
      if (this.pendingConnection === connection) this.pendingConnection = null;
      connection?.close();
      if (this.desiredActive) this.markStale('snapshot_failed');
      throw this.manager.toPublicError(error);
    }
  }

  async readAttachSnapshot(attempt, result) {
    if (!isRecord(result)
      || result.activeSessionId !== attempt.activeSessionId
      || !isRecord(result.snapshot)
      || !snapshotIdentityValid(result.snapshot, this.sessionId, attempt.activeSessionId)) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_attach_response');
    }
    const stream = result.snapshotStream;
    if (!isRecord(stream)
      || !SAFE_PRIVATE_ID.test(stream.id)
      || !Number.isSafeInteger(stream.messageCount)
      || stream.messageCount < 0
      || stream.messageCount > MAX_SOURCE_MESSAGE_COUNT) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_attach_response');
    }
    const matchesResponse = (completed) => completed
      && completed.id === stream.id
      && completed.transcript.sourceMessageCount === stream.messageCount
      && completed.lastEventSequence === result.snapshot.lastEventSequence
      && cursorsEqual(completed.cursor, result.snapshot.lastEventCursor);
    if (matchesResponse(attempt.completedStage)) return attempt.completedStage;
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (attempt.closed || this.attempt !== attempt) {
        throw new PrimeDaemonProtocolError('prime_daemon_snapshot_interrupted');
      }
      if (matchesResponse(attempt.completedStage)) return attempt.completedStage;
      await delay(10);
    }
    throw new PrimeDaemonProtocolError('prime_daemon_snapshot_timeout');
  }

  async readAvailableModels(attempt) {
    const payload = await requestData(attempt.connection, {
      type: 'get_available_models',
      activeSessionId: attempt.activeSessionId,
    }, ATTACH_TIMEOUT_MS);
    const models = normalizePrimeAvailableModels(payload);
    if (!models) throw new PrimeDaemonProtocolError('prime_daemon_invalid_model_catalog');
    return models;
  }

  async readSessionStats(attempt) {
    const payload = await requestData(attempt.connection, {
      type: 'get_session_stats',
      activeSessionId: attempt.activeSessionId,
    }, ATTACH_TIMEOUT_MS);
    const stats = normalizePrimeSessionStats(payload);
    if (!stats) throw new PrimeDaemonProtocolError('prime_daemon_invalid_session_stats');
    return stats;
  }

  refreshSessionStats(attempt) {
    if (this.statsRefreshPromise) {
      this.statsRefreshQueued = true;
      return;
    }
    const refresh = this.readSessionStats(attempt).then((stats) => {
      if (attempt !== this.attempt || !this.desiredActive || this.authorityBlocked || !this.cachedSnapshot) return;
      this.publicRevision += 1;
      this.cachedSnapshot = {
        ...this.cachedSnapshot,
        revision: this.publicRevision,
        freshness: { state: 'fresh', observedAt: Date.now() },
        context: stats.context,
      };
      this.publish({ type: 'snapshot', snapshot: this.cachedSnapshot });
    }).catch(() => undefined).finally(() => {
      if (this.statsRefreshPromise !== refresh) return;
      this.statsRefreshPromise = null;
      if (this.statsRefreshQueued) {
        this.statsRefreshQueued = false;
        if (attempt === this.attempt && this.desiredActive && !this.authorityBlocked) {
          this.refreshSessionStats(attempt);
        }
      }
    });
    this.statsRefreshPromise = refresh;
  }

  async completeSnapshotStage(attempt, completed) {
    if (attempt !== this.attempt || !this.desiredActive) return;
    const [availableModels, sessionStats] = await Promise.all([
      this.readAvailableModels(attempt),
      this.readSessionStats(attempt).catch(() => null),
    ]);
    this.commitSnapshotStage(attempt, completed, availableModels, sessionStats);
  }

  replaceAttempt(attempt) {
    const previous = this.attempt;
    this.attempt = attempt;
    previous?.dispose();
  }

  blockAuthority(attempt, reason) {
    if (this.attempt !== attempt) return;
    const pendingUpdate = this.takePendingMessageUpdate();
    this.authorityBlocked = true;
    if (pendingUpdate?.attempt === attempt && !attempt.closed) {
      this.queuePendingEvent(attempt, pendingUpdate.message);
      if (attempt.closed) return;
    }
    this.markStale(reason);
  }

  commitSnapshotStage(attempt, completed, availableModels, sessionStats) {
    if (this.attempt !== attempt
      || !this.desiredActive
      || attempt.stage
      || attempt.completedStage?.id !== completed.id) return false;
    if (!snapshotIdentityValid(completed.snapshot, this.sessionId, attempt.activeSessionId)
      || !validCursor(completed.cursor, completed.lastEventSequence)) {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_invalid_snapshot'));
      return false;
    }
    this.sourceCursor = completed.cursor;
    this.publicGeneration = randomUUID();
    this.turnToken = randomUUID();
    this.publicRevision += 1;
    this.activityCauses = new Set();
    this.abortPending = false;
    const observedAt = Date.now();
    if (attempt.completedStage?.id === completed.id) attempt.completedStage = null;
    this.cachedSnapshot = createPrimePublicSnapshot({
      sessionId: this.sessionId,
      generation: this.publicGeneration,
      revision: this.publicRevision,
      turnToken: this.turnToken,
      observedAt,
      snapshot: completed.snapshot,
      transcript: completed.transcript,
      availableModels,
      sessionStats,
      workingDirectory: this.entity.workingDirectory,
    });
    if (this.cachedSnapshot.status.activity === 'working') this.activityCauses.add('snapshot');
    this.authorityBlocked = false;
    this.lastAccessedAt = observedAt;
    this.publish({ type: 'snapshot', snapshot: this.cachedSnapshot });
    this.drainPendingEvents();
    return true;
  }

  handleDaemonMessage(attempt, message) {
    if (this.attempt !== attempt || !this.desiredActive) return;
    const scopedTypes = ['session_event', 'session_status', 'session_closed', 'session_replaced', 'session_resynced', 'session_detached'];
    if (scopedTypes.includes(message.type) && message.activeSessionId !== attempt.activeSessionId) {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_identity_mismatch'));
      return;
    }
    if (message.type === 'daemon_closing') {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_closing'));
      return;
    }
    if (message.type === 'session_closed' || message.type === 'session_detached') {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError(`prime_daemon_${message.type}`));
      return;
    }
    if (message.type === 'session_replaced') {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_session_replaced'));
      return;
    }
    if (message.type === 'session_resynced') {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_unexpected_inline_snapshot'));
      return;
    }
    if (message.type !== 'session_event' && message.type !== 'session_status') return;
    this.acceptSequencedMessage(attempt, message);
  }

  acceptSequencedMessage(attempt, message) {
    const cursor = message.meta?.cursor;
    if (!validCursor(cursor, cursor?.sequence)) {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_unsequenced_event'));
      return;
    }
    if (this.authorityBlocked || !this.sourceCursor) {
      this.queuePendingEvent(attempt, message);
      return;
    }
    if (cursor.generation !== this.sourceCursor.generation) {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_generation_changed'));
      return;
    }
    if (cursor.sequence <= this.sourceCursor.sequence) return;
    if (cursor.sequence !== this.sourceCursor.sequence + 1) {
      this.blockAuthority(attempt, 'resynchronizing');
      this.sourceCursor = null;
      this.queuePendingEvent(attempt, message);
      if (!attempt.closed) attempt.waitForResyncBegin();
      return;
    }
    this.sourceCursor = cursor;
    const eventType = message.type === 'session_event' ? message.event?.type : null;
    if (message.type === 'session_event' && !PROJECTED_SESSION_EVENT_TYPES.has(eventType)) return;
    if (eventType === 'message_update' && message.event?.message?.role === 'assistant') {
      this.queueMessageUpdate(attempt, message);
      return;
    }
    this.flushPendingMessageUpdate();
    this.applySequencedMessage(message);
  }

  queuePendingEvent(attempt, message) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.pendingEvents.length >= MAX_PENDING_EVENT_COUNT
      || this.pendingEventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_pending_event_limit'));
      return;
    }
    this.pendingEvents.push(message);
    this.pendingEventBytes += bytes;
  }

  drainPendingEvents() {
    const pending = this.pendingEvents;
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    const attempt = this.attempt;
    if (!attempt) return;
    for (let index = 0; index < pending.length; index += 1) {
      if (this.attempt !== attempt || attempt.closed) return;
      if (this.authorityBlocked) {
        for (const remaining of pending.slice(index)) {
          this.queuePendingEvent(attempt, remaining);
          if (attempt.closed) return;
        }
        return;
      }
      this.acceptSequencedMessage(attempt, pending[index]);
    }
  }

  takePendingMessageUpdate() {
    if (this.messageUpdateTimer) clearTimeout(this.messageUpdateTimer);
    this.messageUpdateTimer = null;
    const pending = this.pendingMessageUpdate;
    this.pendingMessageUpdate = null;
    return pending;
  }

  clearPendingMessageUpdate() {
    this.takePendingMessageUpdate();
  }

  flushPendingMessageUpdate() {
    const pending = this.takePendingMessageUpdate();
    if (!pending || this.authorityBlocked || this.attempt !== pending.attempt || pending.attempt.closed) return;
    this.applySequencedMessage(pending.message);
  }

  queueMessageUpdate(attempt, message) {
    this.pendingMessageUpdate = { attempt, message };
    if (this.messageUpdateTimer) return;
    this.messageUpdateTimer = setTimeout(() => this.flushPendingMessageUpdate(), MESSAGE_UPDATE_FLUSH_MS);
    this.messageUpdateTimer.unref?.();
  }

  applySequencedMessage(message) {
    if (!this.cachedSnapshot) return;
    let event = null;
    if (message.type === 'session_event') {
      event = normalizePrimeSessionEvent(message.event, this.entity.workingDirectory);
    }
    if (message.type === 'session_status') {
      const recap = typeof message.recap === 'string' && message.recap.trim()
        ? message.recap.trim().slice(0, 160)
        : undefined;
      event = { type: 'status', ...(recap ? { recap } : {}) };
    }
    this.publicRevision += 1;
    const previousActivity = this.cachedSnapshot.status.activity;
    if (message.type === 'session_event') this.applyActivityCauses(message.event);
    const activity = this.activityCauses.size > 0 ? 'working' : 'idle';
    if (activity !== previousActivity) this.turnToken = randomUUID();
    const transcript = { ...this.cachedSnapshot.transcript };
    if (message.type === 'session_event'
      && ['message_start', 'message_update'].includes(message.event?.type)
      && message.event.message?.role === 'assistant') {
      transcript.streamingRecord = event?.record;
    }
    if (message.type === 'session_event' && message.event?.type === 'message_end') {
      const appended = appendPrimeTranscriptRecord(
        transcript,
        message.event.message,
        this.entity.workingDirectory,
      );
      transcript.records = appended.records;
      transcript.sourceMessageCount = appended.sourceMessageCount;
      transcript.omittedOlderRecords = appended.omittedOlderRecords;
      if (message.event.message?.role === 'assistant') delete transcript.streamingRecord;
    }
    const recap = event?.type === 'status' ? event.recap : this.cachedSnapshot.status.recap;
    const configuration = event?.type === 'thinking'
      ? {
          ...this.cachedSnapshot.configuration,
          thinking: { ...this.cachedSnapshot.configuration.thinking, current: event.current },
        }
      : this.cachedSnapshot.configuration;
    this.cachedSnapshot = {
      ...this.cachedSnapshot,
      revision: this.publicRevision,
      turn: { token: this.turnToken, active: activity === 'working' },
      freshness: { state: 'fresh', observedAt: Date.now() },
      status: { activity, ...(recap ? { recap } : {}) },
      transcript,
      configuration,
      capabilities: {
        ...this.cachedSnapshot.capabilities,
        mutations: true,
        actions: {
          canSend: activity === 'idle',
          canAbort: activity === 'working' && !this.abortPending,
          canChangeModel: activity === 'idle',
        },
      },
    };
    this.publish({
      type: 'event',
      sessionId: this.sessionId,
      generation: this.publicGeneration,
      revision: this.publicRevision,
      turn: this.cachedSnapshot.turn,
      freshness: this.cachedSnapshot.freshness,
      event: event || { type: 'state_changed' },
    });
    if (message.type === 'session_event'
      && message.event?.type === 'message_end'
      && message.event.message?.role === 'assistant'
      && this.attempt) {
      this.refreshSessionStats(this.attempt);
    }
  }

  applyActivityCauses(event) {
    if (!isRecord(event)) return;
    if (event.type === 'agent_start') {
      this.activityCauses.delete('snapshot');
      this.activityCauses.add('agent');
      return;
    }
    if (event.type === 'agent_end') {
      this.activityCauses.clear();
      this.abortPending = false;
      return;
    }
    if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'tool_execution_start') {
      this.activityCauses.delete('snapshot');
      this.activityCauses.add('agent');
      return;
    }
    const edges = {
      compaction_start: ['compaction', true],
      compaction_end: ['compaction', false],
      auto_retry_start: ['retry', true],
      auto_retry_end: ['retry', false],
      bash_start: ['bash', true],
      bash_end: ['bash', false],
    };
    const edge = edges[event.type];
    if (!edge) return;
    this.activityCauses.delete('snapshot');
    if (edge[1]) this.activityCauses.add(edge[0]);
    else this.activityCauses.delete(edge[0]);
  }

  handleAttemptFailure(attempt, error) {
    if (this.attempt !== attempt || attempt.closed) return;
    this.clearPendingMessageUpdate();
    attempt.dispose();
    this.attempt = null;
    this.authorityBlocked = true;
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    const code = error?.code || '';
    const reason = code.includes('sequence') ? 'sequence_gap'
      : code.includes('generation') || code.includes('replaced') || code.includes('identity') ? 'identity_changed'
        : code.includes('snapshot') ? 'snapshot_failed'
          : code.includes('protocol') || code.includes('invalid') ? 'protocol_error'
            : 'disconnected';
    this.markStale(reason);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.desiredActive || this.reconnectPromise) return;
    this.reconnectPromise = (async () => {
      const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
      let attemptIndex = 0;
      this.markStale('reconnecting');
      while (this.desiredActive && Date.now() < deadline) {
        try {
          const entity = await validateActivationEntity(await this.manager.resolveEntity(this.sessionId));
          await this.connectAndSnapshot(entity, false);
          return;
        } catch {
          if (!this.desiredActive) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const waitMs = Math.min(remaining, MAX_RECONNECT_DELAY_MS, 100 * 2 ** Math.min(attemptIndex, 5));
          attemptIndex += 1;
          await delay(waitMs);
        }
      }
      if (this.desiredActive) this.markStale('reconnect_failed');
    })().finally(() => {
      this.reconnectPromise = null;
    });
  }

  markStale(rawReason) {
    if (!this.cachedSnapshot) return;
    const reason = STALE_REASONS.has(rawReason) ? rawReason : 'protocol_error';
    if (this.cachedSnapshot.freshness.state === 'stale'
      && this.cachedSnapshot.freshness.reason === reason) return;
    this.publicRevision += 1;
    this.turnToken = randomUUID();
    this.cachedSnapshot = {
      ...this.cachedSnapshot,
      revision: this.publicRevision,
      turn: { token: this.turnToken, active: false },
      freshness: { state: 'stale', reason, observedAt: Date.now() },
      status: {
        activity: 'unknown',
        ...(this.cachedSnapshot.status.recap ? { recap: this.cachedSnapshot.status.recap } : {}),
      },
      capabilities: {
        ...this.cachedSnapshot.capabilities,
        mutations: false,
        actions: { canSend: false, canAbort: false, canChangeModel: false },
      },
    };
    this.publish({
      type: 'freshness',
      sessionId: this.sessionId,
      generation: this.publicGeneration,
      revision: this.publicRevision,
      turn: this.cachedSnapshot.turn,
      freshness: this.cachedSnapshot.freshness,
      status: this.cachedSnapshot.status,
    });
  }

  pruneIdempotency(now = Date.now()) {
    for (const [key, entry] of this.idempotency) {
      if (!entry.promise && now - (entry.settledAt || entry.createdAt) > IDEMPOTENCY_TTL_MS) this.idempotency.delete(key);
    }
    while (this.idempotency.size >= IDEMPOTENCY_LIMIT) {
      const completed = [...this.idempotency].find(([, entry]) => !entry.promise);
      if (!completed) throw mutationError(429, 'prime_idempotency_limit', 'Too many Prime mutations are pending');
      this.idempotency.delete(completed[0]);
    }
  }

  replayIdempotency(entry) {
    if (entry.promise) return entry.promise;
    if (entry.error) throw mutationError(entry.error.statusCode, entry.error.code, entry.error.message);
    return entry.result;
  }

  async mutate(request) {
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) {
        throw mutationError(409, 'prime_idempotency_conflict', 'Prime idempotency key was reused with different input');
      }
      return this.replayIdempotency(existing);
    }
    this.pruneIdempotency();
    const entry = {
      fingerprint: request.fingerprint,
      commandId: `openchamber_mut_${randomUUID()}`,
      createdAt: Date.now(),
      promise: null,
      result: null,
      error: null,
    };
    this.idempotency.set(request.idempotencyKey, entry);
    entry.promise = this.executeMutation(request, entry.commandId).then((result) => {
      entry.result = result;
      entry.settledAt = Date.now();
      entry.promise = null;
      return result;
    }).catch((error) => {
      const stable = error instanceof PrimeServiceError
        ? error
        : mutationError(503, 'prime_mutation_uncertain', 'The Prime mutation result is uncertain');
      entry.error = { statusCode: stable.statusCode, code: stable.code, message: stable.message };
      entry.settledAt = Date.now();
      entry.promise = null;
      throw stable;
    });
    return entry.promise;
  }

  assertMutationAuthority(request) {
    const snapshot = this.cachedSnapshot;
    const attempt = this.attempt;
    if (!this.desiredActive
      || !attempt?.ready
      || this.authorityBlocked
      || snapshot?.freshness.state !== 'fresh'
      || snapshot.capabilities.mutations !== true) {
      throw mutationError(409, 'prime_mutation_unavailable', 'Prime session is not ready for mutations');
    }
    if (request.generation !== snapshot.generation
      || request.revision !== snapshot.revision
      || request.turnToken !== snapshot.turn.token) {
      throw mutationError(409, 'prime_mutation_fence_mismatch', 'Prime session state changed before mutation');
    }
    const activity = snapshot.status.activity;
    if ((request.action === 'prompt' && (activity !== 'idle' || !snapshot.capabilities.actions.canSend))
      || (request.action === 'abort' && (activity !== 'working'
        || !snapshot.turn.active
        || !snapshot.capabilities.actions.canAbort))
      || ((request.action === 'set_model' || request.action === 'set_thinking_level')
        && (activity !== 'idle' || !snapshot.capabilities.actions.canChangeModel))) {
      throw mutationError(409, 'prime_mutation_not_allowed', 'Prime mutation is not allowed in the current state');
    }
    let selectedModel = null;
    if (request.action === 'set_model') {
      selectedModel = snapshot.configuration.models.find(
        (model) => model.provider === request.provider && model.id === request.modelId,
      );
      if (!selectedModel) throw mutationError(400, 'prime_model_unavailable', 'Prime model is unavailable');
    }
    if (request.action === 'set_thinking_level'
      && !snapshot.configuration.thinking.available.includes(request.level)) {
      throw mutationError(400, 'prime_thinking_level_unavailable', 'Prime thinking level is unavailable');
    }
    return { attempt };
  }

  mutationCommand(request, activeSessionId) {
    if (request.action === 'prompt') {
      return {
        type: 'prompt',
        activeSessionId,
        message: request.message,
        queueIfBusy: false,
        expandPromptTemplates: false,
      };
    }
    if (request.action === 'abort') return { type: 'abort', activeSessionId };
    if (request.action === 'set_model') {
      return {
        type: 'set_model',
        activeSessionId,
        provider: request.provider,
        modelId: request.modelId,
      };
    }
    return { type: 'set_thinking_level', activeSessionId, level: request.level };
  }

  async resynchronizeAfterModelChange(attempt) {
    if (attempt !== this.attempt || !this.desiredActive) return null;
    if (!this.authorityBlocked) this.blockAuthority(attempt, 'resynchronizing');
    this.attempt = null;
    attempt.dispose();
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
    const recovery = this.reconnectPromise || Promise.resolve();
    let timer;
    await Promise.race([
      recovery,
      new Promise((resolve) => {
        timer = setTimeout(resolve, MUTATION_RESNAPSHOT_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    const snapshot = this.cachedSnapshot;
    return snapshot?.freshness.state === 'fresh'
      ? { generation: snapshot.generation, revision: snapshot.revision, turnToken: snapshot.turn.token }
      : null;
  }

  applyMutationSuccess(request, attempt) {
    const snapshot = this.cachedSnapshot;
    if (attempt !== this.attempt || this.authorityBlocked || snapshot?.freshness.state !== 'fresh') return null;
    if ((request.action === 'prompt' || request.action === 'abort')
      && snapshot.revision !== request.revision) {
      return {
        generation: snapshot.generation,
        revision: snapshot.revision,
        turnToken: snapshot.turn.token,
      };
    }
    let activity = snapshot.status.activity;
    let configuration = snapshot.configuration;
    if (request.action === 'prompt') {
      this.activityCauses.add('agent');
      activity = 'working';
      this.turnToken = randomUUID();
    } else if (request.action === 'abort') {
      this.abortPending = true;
    } else if (request.action === 'set_thinking_level') {
      configuration = {
        ...configuration,
        thinking: { ...configuration.thinking, current: request.level },
      };
    }
    this.publicRevision += 1;
    this.cachedSnapshot = {
      ...snapshot,
      revision: this.publicRevision,
      turn: { token: this.turnToken, active: activity === 'working' },
      freshness: { state: 'fresh', observedAt: Date.now() },
      status: { ...snapshot.status, activity },
      configuration,
      capabilities: {
        ...snapshot.capabilities,
        mutations: true,
        actions: {
          canSend: activity === 'idle',
          canAbort: activity === 'working' && !this.abortPending,
          canChangeModel: activity === 'idle',
        },
      },
    };
    this.publish({ type: 'snapshot', snapshot: this.cachedSnapshot });
    return {
      generation: this.cachedSnapshot.generation,
      revision: this.cachedSnapshot.revision,
      turnToken: this.cachedSnapshot.turn.token,
    };
  }

  async executeMutation(request, commandId) {
    const authority = this.assertMutationAuthority(request);
    if (this.mutationInFlight) {
      throw mutationError(409, 'prime_mutation_in_progress', 'Another Prime mutation is in progress');
    }
    this.mutationInFlight = true;
    try {
      return await this.dispatchMutation(request, commandId, authority);
    } finally {
      this.mutationInFlight = false;
    }
  }

  async dispatchMutation(request, commandId, { attempt }) {
    if (request.action === 'set_model') this.blockAuthority(attempt, 'resynchronizing');
    let response;
    try {
      response = await attempt.connection.request(
        this.mutationCommand(request, attempt.activeSessionId),
        MUTATION_TIMEOUT_MS,
        { commandId },
      );
    } catch {
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_mutation_uncertain'));
      throw mutationError(503, 'prime_mutation_uncertain', 'The Prime mutation result is uncertain');
    }
    if (!response.success) {
      if (response.errorInfo?.code !== 'command_result_uncertain') attempt.connection.acknowledge(commandId);
      this.handleAttemptFailure(attempt, new PrimeDaemonProtocolError('prime_daemon_mutation_rejected'));
      const uncertain = response.errorInfo?.code === 'command_result_uncertain';
      throw uncertain
        ? mutationError(503, 'prime_mutation_uncertain', 'The Prime mutation result is uncertain')
        : mutationError(409, 'prime_mutation_rejected', 'The Prime mutation was rejected');
    }
    attempt.connection.acknowledge(commandId);
    const authority = request.action === 'set_model'
      ? await this.resynchronizeAfterModelChange(attempt)
      : this.applyMutationSuccess(request, attempt);
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      action: request.action,
      accepted: true,
      ...(authority ? { authority } : {}),
      ...(request.action === 'set_model'
        ? { result: { model: { provider: request.provider, id: request.modelId } } }
        : request.action === 'set_thinking_level'
          ? { result: { thinkingLevel: request.level } }
          : {}),
    };
  }

  async deactivate() {
    const activationPromise = this.activationPromise;
    const reconnectPromise = this.reconnectPromise;
    this.desiredActive = false;
    this.lastAccessedAt = Date.now();
    this.clearPendingMessageUpdate();
    this.markStale('deactivated');
    this.pendingConnection?.close();
    this.pendingConnection = null;
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      try {
        await requestData(attempt.connection, {
          type: 'detach',
          activeSessionId: attempt.activeSessionId,
        }, DETACH_TIMEOUT_MS);
      } catch {
        // Closing the owned attachment is authoritative cleanup even if detach acknowledgement is lost.
      }
      attempt.dispose();
    }
    await Promise.allSettled([activationPromise, reconnectPromise].filter(Boolean));
    this.pendingEvents = [];
    this.pendingEventBytes = 0;
    this.authorityBlocked = true;
    this.publish({ type: 'closed', sessionId: this.sessionId });
    this.subscribers.clear();
    return this.cachedSnapshot;
  }

  subscribe(listener) {
    if (this.subscribers.size >= SUBSCRIBER_LIMIT) {
      throw new PrimeServiceError(429, 'prime_event_subscriber_limit', 'Too many Prime event subscribers');
    }
    this.lastAccessedAt = Date.now();
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  publish(event) {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        this.subscribers.delete(listener);
      }
    }
  }
}

export const createPrimeRuntimeManager = ({
  resolveEntity,
  agentRoot,
  sessionsRoot,
  env = process.env,
  buildAugmentedPath,
  socketPath = defaultDaemonSocketPath(),
} = {}) => {
  const runtimes = new Map();
  const creationOperations = new Set();
  const creationConnections = new Set();
  const daemonProtocolClientId = `openchamber:prime:${randomUUID()}`;
  let launchPromise = null;
  let launchingChild = null;
  let disposed = false;

  const connectExisting = async () => {
    await validateSocketBoundary(socketPath);
    const connection = new PrimeDaemonConnection(socketPath, { protocolClientId: daemonProtocolClientId });
    await connection.connect();
    return connection;
  };

  const launchAndConnect = async () => {
    let connection;
    try {
      connection = await connectExisting();
      return connection;
    } catch (error) {
      connection?.close();
      if (error instanceof PrimeDaemonProtocolError && error.code === 'prime_daemon_incompatible') throw error;
      if (error instanceof PrimeDaemonProtocolError
        && !['prime_daemon_connect_timeout', 'prime_daemon_disconnected'].includes(error.code)) throw error;
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code)
        && !(error instanceof PrimeDaemonProtocolError)) throw error;
    }
    const launchSpec = await resolvePrimeLaunchSpec({ env, buildAugmentedPath });
    if (!launchSpec) throw new PrimeDaemonProtocolError('prime_daemon_cli_unavailable');
    let augmentedPath = env.PATH || '';
    try {
      if (typeof buildAugmentedPath === 'function') augmentedPath = buildAugmentedPath() || augmentedPath;
    } catch {
      // Inherited PATH remains available.
    }
    const child = spawn(
      launchSpec.executable,
      [...launchSpec.prefixArgs, '--mode', 'daemon', '--daemon-socket', socketPath],
      {
        cwd: process.cwd(),
        detached: true,
        env: safeLaunchEnvironment(env, augmentedPath),
        stdio: 'ignore',
        shell: false,
      },
    );
    launchingChild = child;
    let childFailure = null;
    child.once('error', () => { childFailure = new PrimeDaemonProtocolError('prime_daemon_launch_failed'); });
    child.once('exit', () => { childFailure ||= new PrimeDaemonProtocolError('prime_daemon_launch_failed'); });
    child.unref();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        try {
          const readyConnection = await connectExisting();
          if (launchingChild === child) launchingChild = null;
          return readyConnection;
        } catch (error) {
          if (error instanceof PrimeDaemonProtocolError && error.code === 'prime_daemon_incompatible') throw error;
          if (childFailure) throw childFailure;
          await delay(50);
        }
      }
      throw new PrimeDaemonProtocolError('prime_daemon_startup_timeout');
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (launchingChild === child) launchingChild = null;
      throw error;
    }
  };

  const connectDaemon = async () => {
    try {
      return await connectExisting();
    } catch (error) {
      if (error instanceof PrimeDaemonProtocolError && error.code === 'prime_daemon_incompatible') throw error;
    }
    if (!launchPromise) {
      launchPromise = launchAndConnect()
        .then((launchConnection) => launchConnection.close())
        .finally(() => { launchPromise = null; });
    }
    await launchPromise;
    // Every activated session owns an independent socket attachment so one
    // connection failure cannot interrupt another session runtime.
    return connectExisting();
  };

  const toPublicError = (error) => {
    if (error instanceof PrimeServiceError) return error;
    if (error instanceof PrimeDaemonProtocolError && error.code === 'prime_daemon_incompatible') {
      return fixedRuntimeError('prime_daemon_incompatible');
    }
    if (error instanceof PrimeDaemonProtocolError && error.code.includes('snapshot')) {
      return fixedRuntimeError('prime_snapshot_unavailable');
    }
    return fixedRuntimeError();
  };

  const trimInactive = () => {
    const inactive = [...runtimes.values()]
      .filter((runtime) => !runtime.desiredActive)
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
    for (const runtime of inactive.slice(INACTIVE_CACHE_LIMIT)) runtimes.delete(runtime.sessionId);
  };

  const daemonConfigurationForCreation = (configuration) => {
    if (!configuration) return {};
    const sourceRuntime = runtimes.get(configuration.sourceSessionId);
    const snapshot = sourceRuntime?.cachedSnapshot;
    if (!sourceRuntime?.desiredActive
      || !sourceRuntime.attempt?.ready
      || sourceRuntime.authorityBlocked
      || snapshot?.freshness.state !== 'fresh'
      || snapshot.sessionId !== configuration.sourceSessionId
      || snapshot.generation !== configuration.generation
      || snapshot.revision < configuration.revision) {
      throw creationConfigurationUnavailable();
    }
    const modelAvailable = snapshot.configuration.models.some((model) => (
      model.provider === configuration.provider && model.id === configuration.modelId
    ));
    if (!modelAvailable) throw creationConfigurationUnavailable();
    if (configuration.thinkingLevel !== undefined) {
      const currentModel = snapshot.configuration.currentModel;
      if (currentModel?.provider !== configuration.provider
        || currentModel.id !== configuration.modelId
        || !snapshot.configuration.thinking.available.includes(configuration.thinkingLevel)) {
        throw creationConfigurationUnavailable();
      }
    }
    return {
      provider: configuration.provider,
      model: configuration.modelId,
      ...(configuration.thinkingLevel === undefined ? {} : { thinking: configuration.thinkingLevel }),
    };
  };

  const createRoot = (body) => {
    if (disposed) throw fixedRuntimeError();
    const request = normalizeCreationRequest(body);
    if (creationOperations.size >= CREATE_ROOT_IN_FLIGHT_LIMIT) {
      throw new PrimeServiceError(429, 'prime_creation_limit', 'Too many Prime sessions are being created');
    }
    let operation;
    operation = (async () => {
      let connection;
      let opened;
      try {
        let workingDirectory;
        let workingDirectoryMetadata;
        try {
          workingDirectory = await realpath(request.workingDirectory);
          workingDirectoryMetadata = await stat(workingDirectory);
        } catch {
          throw invalidCreation();
        }
        if (!workingDirectoryMetadata.isDirectory()
          || !path.isAbsolute(workingDirectory)
          || Buffer.byteLength(workingDirectory, 'utf8') > MAX_WORKING_DIRECTORY_BYTES
          || /[\u0000-\u001f\u007f-\u009f]/u.test(workingDirectory)) {
          throw invalidCreation();
        }

        let resolvedSessionsRoot;
        let sessionsRootMetadata;
        try {
          resolvedSessionsRoot = await realpath(sessionsRoot);
          sessionsRootMetadata = await stat(resolvedSessionsRoot);
        } catch {
          throw creationFailed(503);
        }
        if (!sessionsRootMetadata.isDirectory() || !path.isAbsolute(resolvedSessionsRoot)) {
          throw creationFailed(503);
        }
        if (disposed) throw fixedRuntimeError();
        daemonConfigurationForCreation(request.configuration);

        try {
          connection = await connectDaemon();
        } catch (error) {
          throw toPublicError(error);
        }
        creationConnections.add(connection);
        if (disposed) throw fixedRuntimeError();

        const daemonConfiguration = daemonConfigurationForCreation(request.configuration);
        const createCommandId = `openchamber_create_${randomUUID()}`;
        let createResponse;
        try {
          createResponse = await connection.request({
            type: 'create',
            config: {
              cwd: workingDirectory,
              agentDir: agentRoot,
              sessionDir: resolvedSessionsRoot,
              ...daemonConfiguration,
            },
          }, CREATE_ROOT_TIMEOUT_MS, { commandId: createCommandId });
        } catch {
          throw creationUncertain();
        }
        if (!isRecord(createResponse) || typeof createResponse.success !== 'boolean') {
          throw creationUncertain();
        }
        if (!createResponse.success) {
          if (createResponse.errorInfo?.code === 'command_result_uncertain'
            || typeof createResponse.error !== 'string'
            || (createResponse.errorInfo !== undefined && !isRecord(createResponse.errorInfo))) {
            throw creationUncertain();
          }
          connection.acknowledge(createCommandId);
          throw creationFailed(503);
        }
        connection.acknowledge(createCommandId);

        const summary = createResponse.data;
        if (!isRecord(summary)
          || !PUBLIC_SESSION_ID.test(summary.sessionId)
          || typeof summary.activeSessionId !== 'string'
          || !SAFE_PRIVATE_ID.test(summary.activeSessionId)
          || typeof summary.sessionFile !== 'string'
          || !path.isAbsolute(summary.sessionFile)) {
          throw creationUncertain();
        }
        const expectedSessionFile = path.join(resolvedSessionsRoot, `${summary.sessionId}.jsonl`);
        if (summary.sessionFile !== expectedSessionFile) throw creationUncertain();
        if (disposed) throw creationUncertain();

        const promptCommandId = `openchamber_prompt_${randomUUID()}`;
        let promptResponse;
        try {
          promptResponse = await connection.request({
            type: 'prompt',
            activeSessionId: summary.activeSessionId,
            message: request.message,
            queueIfBusy: false,
            expandPromptTemplates: false,
          }, CREATE_ROOT_TIMEOUT_MS, { commandId: promptCommandId });
        } catch {
          throw creationUncertain();
        }
        if (!isRecord(promptResponse) || typeof promptResponse.success !== 'boolean') {
          throw creationUncertain();
        }
        if (!promptResponse.success) {
          if (promptResponse.errorInfo?.code === 'command_result_uncertain'
            || typeof promptResponse.error !== 'string'
            || (promptResponse.errorInfo !== undefined && !isRecord(promptResponse.errorInfo))) {
            throw creationUncertain();
          }
          connection.acknowledge(promptCommandId);
          throw creationFailed(409);
        }
        connection.acknowledge(promptCommandId);

        try {
          opened = await openContainedRegularFile(expectedSessionFile, resolvedSessionsRoot);
          const header = await readBoundedHeader(opened);
          if (opened.realPath !== expectedSessionFile
            || header?.type !== 'session'
            || header.id !== summary.sessionId
            || header.cwd !== workingDirectory) {
            throw creationUncertain();
          }
        } catch (error) {
          if (error instanceof PrimeServiceError) throw error;
          throw creationUncertain();
        } finally {
          await opened?.handle.close().catch(() => undefined);
          opened = null;
        }

        return { schemaVersion: 1, sessionId: summary.sessionId, accepted: true };
      } finally {
        await opened?.handle.close().catch(() => undefined);
        if (connection) creationConnections.delete(connection);
        connection?.close();
      }
    })().finally(() => creationOperations.delete(operation));
    creationOperations.add(operation);
    return operation;
  };

  const activate = async (sessionId) => {
    if (disposed) throw fixedRuntimeError();
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
    }
    const entity = await validateActivationEntity(await resolveEntity(sessionId));
    if (disposed) throw fixedRuntimeError();
    let runtime = runtimes.get(sessionId);
    if (!runtime?.desiredActive
      && [...runtimes.values()].filter((candidate) => candidate.desiredActive).length >= ACTIVE_RUNTIME_LIMIT) {
      throw new PrimeServiceError(429, 'prime_runtime_limit', 'Too many Prime sessions are activated');
    }
    if (!runtime) {
      runtime = new PrimeSessionRuntime(api, entity);
      runtimes.set(sessionId, runtime);
    }
    try {
      const snapshot = await runtime.activate(entity);
      trimInactive();
      return { schemaVersion: 1, sessionId, active: true, snapshot };
    } catch (error) {
      await runtime.deactivate();
      if (!runtime.cachedSnapshot) runtimes.delete(sessionId);
      trimInactive();
      throw toPublicError(error);
    }
  };

  const mutate = async (action, sessionId, body) => {
    if (disposed) throw fixedRuntimeError();
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
    }
    const request = normalizeMutationRequest(action, body);
    const runtime = runtimes.get(sessionId);
    if (!runtime) throw mutationError(409, 'prime_mutation_unavailable', 'Prime session is not ready for mutations');
    return runtime.mutate(request);
  };

  const deactivate = async (sessionId) => {
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
    }
    const runtime = runtimes.get(sessionId);
    if (!runtime) return { schemaVersion: 1, sessionId, active: false };
    const snapshot = await runtime.deactivate();
    trimInactive();
    return { schemaVersion: 1, sessionId, active: false, ...(snapshot ? { snapshot } : {}) };
  };

  const getSnapshot = (sessionId) => {
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
    }
    const runtime = runtimes.get(sessionId);
    if (!runtime?.cachedSnapshot) {
      throw new PrimeServiceError(409, 'prime_runtime_not_activated', 'Prime session is not activated');
    }
    runtime.lastAccessedAt = Date.now();
    return runtime.cachedSnapshot;
  };

  const openEventSubscription = (sessionId, listener) => {
    if (disposed) throw fixedRuntimeError();
    if (!PUBLIC_SESSION_ID.test(sessionId)) {
      throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
    }
    const runtime = runtimes.get(sessionId);
    if (!runtime?.desiredActive || !runtime.cachedSnapshot) {
      throw new PrimeServiceError(409, 'prime_runtime_not_activated', 'Prime session is not activated');
    }
    return {
      initial: runtime.cachedSnapshot,
      unsubscribe: runtime.subscribe(listener),
    };
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (launchingChild?.exitCode === null && launchingChild.signalCode === null) launchingChild.kill('SIGTERM');
    for (const connection of creationConnections) connection.close();
    await Promise.allSettled([
      ...[...runtimes.values()].map((runtime) => runtime.deactivate()),
      ...creationOperations,
    ]);
    creationConnections.clear();
    runtimes.clear();
  };

  const api = {
    resolveEntity,
    agentRoot,
    sessionsRoot,
    connectDaemon,
    toPublicError,
    createRoot,
    activate,
    deactivate,
    prompt: (sessionId, body) => mutate('prompt', sessionId, body),
    abort: (sessionId, body) => mutate('abort', sessionId, body),
    setModel: (sessionId, body) => mutate('set_model', sessionId, body),
    setThinkingLevel: (sessionId, body) => mutate('set_thinking_level', sessionId, body),
    getSnapshot,
    openEventSubscription,
    dispose,
  };
  return api;
};
