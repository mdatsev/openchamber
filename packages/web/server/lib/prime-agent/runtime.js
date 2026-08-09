const PRIME_PROTOCOL = { name: 'prime-agent.daemon', version: 7 };
const PRIME_SCHEMA_ID = 'protocol-7-schema-13-816309b1cd50';
const PRIME_CLIENT_CAPABILITIES = ['attach_snapshot', 'event_sequence', 'slim_attach', 'chunked_snapshot'];
const MUTATION_COMMANDS = new Set([
  'create',
  'attach',
  'detach',
  'prompt',
  'abort',
  'kill',
  'set_model',
  'set_thinking_level',
]);
const MAX_DAEMON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_LIVE_MESSAGES = 50_000;
const COMMAND_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const SESSION_EVENT_COALESCE_MS = 100;
const MAX_REMEMBERED_ATTACHMENTS = 100;
const MAX_MUTATION_ACKS = 1_000;
const MAX_LIVE_TOOL_EXECUTIONS = 1_000;
const DRAFT_CONTROLS_MAX_AGE_MS = 30_000;
const MAX_DRAFT_CONTROLS_ENTRIES = 20;

const asString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const normalizeThinkingLevel = (value) => THINKING_LEVELS.has(value) ? value : null;

const trimOldestEntries = (collection, maximumSize) => {
  while (collection.size > maximumSize) collection.delete(collection.keys().next().value);
};

const normalizeModel = (model) => {
  if (!model || typeof model !== 'object') return null;
  const id = asString(model.id);
  const provider = asString(model.provider);
  if (!id || !provider) return null;
  return {
    id,
    name: asString(model.name) ?? id,
    provider,
    reasoning: model.reasoning === true,
    contextWindow: Number.isFinite(model.contextWindow) && model.contextWindow >= 0 ? model.contextWindow : null,
    maxTokens: Number.isFinite(model.maxTokens) && model.maxTokens >= 0 ? model.maxTokens : null,
  };
};

const normalizeSlashCommand = (command) => {
  if (!command || typeof command !== 'object') return null;
  const name = asString(command.name)?.slice(0, 256);
  if (!name) return null;
  return {
    name,
    description: asString(command.description)?.slice(0, 2_048) ?? null,
    argumentHint: asString(command.argumentHint)?.slice(0, 512) ?? null,
    source: command.source === 'extension' || command.source === 'prompt' || command.source === 'skill'
      ? command.source
      : 'extension',
  };
};

const runtimeError = (message, code) => Object.assign(new Error(message), { code, publicMessage: message });

const defaultSocketPath = ({ os, path, processLike }) => {
  if (processLike.platform === 'win32') return '\\\\.\\pipe\\prime-agent-daemon';
  const userID = typeof processLike.getuid === 'function' ? processLike.getuid() : 'user';
  return path.join(os.tmpdir(), `prime-agent-${userID}`, 'daemon.sock');
};

const normalizeSummary = (summary) => {
  if (!summary || typeof summary !== 'object') return null;
  const sessionID = asString(summary.sessionId) ?? asString(summary.id);
  const activeSessionID = asString(summary.activeSessionId) ?? (summary.isSessionActive ? asString(summary.id) : null);
  const directory = asString(summary.cwd);
  if (!sessionID || !directory) return null;
  const depth = Number.isInteger(summary.rlmDepth) && summary.rlmDepth >= 0 ? summary.rlmDepth : 0;
  const parentID = asString(summary.parentSessionId);
  return {
    id: sessionID,
    activeSessionID,
    title: asString(summary.sessionName) ?? asString(summary.firstMessage),
    directory,
    createdAt: asString(summary.created) ?? asString(summary.lastActivityAt) ?? new Date(0).toISOString(),
    updatedAt: asString(summary.modified) ?? asString(summary.lastActivityAt) ?? asString(summary.created) ?? new Date(0).toISOString(),
    activity: summary.activity === 'working' || summary.isStreaming === true ? 'working' : 'idle',
    isSessionActive: summary.isSessionActive === true,
    sessionFile: asString(summary.sessionFile),
    parentID,
    depth,
    childNodeID: asString(summary.rlmChildId),
    parentNodeID: asString(summary.rlmParentNodeId),
    isChild: depth > 0 || summary.runtimeKind === 'subagent' || parentID !== null,
    raw: summary,
  };
};

const messageIdentity = (message) => {
  if (!message || typeof message !== 'object') return null;
  const role = asString(message.role);
  const timestamp = Number.isFinite(message.timestamp) ? Number(message.timestamp) : null;
  if (!role || timestamp === null) return null;
  const toolCallID = asString(message.toolCallId) ?? '';
  return `${role}:${timestamp}:${toolCallID}`;
};

const replaceOrAppendMessage = (messages, message) => {
  const identity = messageIdentity(message);
  if (!identity) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageIdentity(messages[index]) !== identity) continue;
    const next = messages.slice();
    next[index] = message;
    return next;
  }
  return [...messages, message].slice(-MAX_LIVE_MESSAGES);
};

const mergeMessages = (messages, incoming) => {
  let next = messages;
  for (const message of incoming) next = replaceOrAppendMessage(next, message);
  return next;
};

const toolExecutionText = (result) => {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return null;
  const text = result.content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text || null;
};

const normalizeEventCursor = (value) => {
  if (!value || typeof value !== 'object') return null;
  const generation = asString(value.generation);
  const sequence = Number.isInteger(value.sequence) && value.sequence >= 0 ? value.sequence : null;
  return generation && sequence !== null ? { generation, sequence } : null;
};

const messageEventCursor = (message) => normalizeEventCursor(message?.meta?.cursor ?? message?.cursor);

const messageEventSequence = (message) => {
  const sequence = message?.meta?.sequence ?? message?.sequence;
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
};

export const createPrimeAgentRuntime = (dependencies) => {
  const {
    crypto,
    net,
    os,
    path,
    process: processLike,
    spawn,
    readSettingsFromDiskMigrated,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    onEvent,
    env = processLike.env,
  } = dependencies;

  const sameResolvedPath = (left, right) => Boolean(
    left && right && path.resolve(left) === path.resolve(right),
  );
  const socketPath = defaultSocketPath({ os, path, processLike });
  const clientID = `openchamber:${crypto.randomUUID()}`;
  const pending = new Map();
  const liveSessions = new Map();
  const activeSessionToSession = new Map();
  const rememberedAttachments = new Map();
  const attachmentPromises = new Map();
  const sessionResyncs = new Set();
  const sessionEventTimers = new Map();
  const mutationResultsAwaitingAck = new Map();
  const draftControlsCache = new Map();
  const draftControlsPromises = new Map();
  let socket = null;
  let socketBuffer = '';
  let hello = null;
  let desired = false;
  let connectPromise = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  let status = {
    schemaVersion: 1,
    state: 'starting',
    interactive: false,
    authentication: 'unknown',
    binarySource: null,
    version: null,
    message: null,
  };

  const getStatus = () => ({ ...status });

  const publishStatus = (next) => {
    const previous = status;
    status = { ...status, ...next, schemaVersion: 1 };
    if (
      previous.state === status.state
      && previous.interactive === status.interactive
      && previous.authentication === status.authentication
      && previous.binarySource === status.binarySource
      && previous.version === status.version
      && previous.message === status.message
    ) return;
    onEvent?.({ type: 'runtime-changed', status: getStatus() });
  };

  const publishSessionChanged = (sessionID, options = {}) => {
    if (!sessionID) return;
    const existing = sessionEventTimers.get(sessionID);
    if (existing) clearTimeout(existing);
    const emit = () => {
      sessionEventTimers.delete(sessionID);
      const live = liveSessions.get(sessionID);
      onEvent?.({
        type: 'session-changed',
        sessionID,
        activity: live?.summary?.activity ?? 'idle',
        catalogChanged: options.catalogChanged === true,
      });
    };
    if (options.immediate === true) {
      emit();
      return;
    }
    const timer = setTimeout(emit, SESSION_EVENT_COALESCE_MS);
    timer.unref?.();
    sessionEventTimers.set(sessionID, timer);
  };

  const clearPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      const isMutation = MUTATION_COMMANDS.has(request.command);
      const requestError = new Error(isMutation
        ? 'Prime Agent connection closed; the command may still be processing'
        : error.message);
      requestError.code = isMutation ? 'command-result-uncertain' : 'connection-closed';
      requestError.ambiguous = isMutation;
      request.reject(requestError);
    }
    pending.clear();
  };

  const writeEnvelope = (command, id = crypto.randomUUID()) => {
    if (!socket || socket.destroyed || !socket.writable) {
      throw new Error('Prime Agent daemon is not connected');
    }
    socket.write(`${JSON.stringify({
      type: 'command',
      id,
      protocol: PRIME_PROTOCOL,
      clientId: clientID,
      command: { ...command, id },
    })}\n`);
    return id;
  };

  const acknowledgeResult = (commandID) => {
    try {
      writeEnvelope({ type: 'ack_result', commandId: commandID });
    } catch {
      // The journal remains bounded by Prime when a disconnect races the ack.
    }
  };

  const request = async (command) => {
    if (status.state !== 'ready' || !socket || socket.destroyed) {
      await start();
    }
    if (status.state !== 'ready' || !socket || socket.destroyed) {
      const error = new Error(status.message || 'Prime Agent is unavailable');
      error.code = status.state;
      throw error;
    }

    const id = crypto.randomUUID();
    const isMutation = MUTATION_COMMANDS.has(command.type);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Prime Agent ${command.type} timed out`);
        error.code = 'command-timeout';
        error.ambiguous = isMutation;
        reject(error);
      }, COMMAND_TIMEOUT_MS);
      timeout.unref?.();
      pending.set(id, { command: command.type, resolve, reject, timeout });
      if (isMutation) {
        mutationResultsAwaitingAck.set(id, command);
        trimOldestEntries(mutationResultsAwaitingAck, MAX_MUTATION_ACKS);
      }
      try {
        writeEnvelope(command, id);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        mutationResultsAwaitingAck.delete(id);
        reject(error);
      }
    });
  };

  const rememberAttachment = (sessionID, sessionPath) => {
    rememberedAttachments.delete(sessionID);
    rememberedAttachments.set(sessionID, sessionPath ?? null);
    trimOldestEntries(rememberedAttachments, MAX_REMEMBERED_ATTACHMENTS);
  };

  const invalidateAttachmentAuthority = () => {
    activeSessionToSession.clear();
    draftControlsCache.clear();
    draftControlsPromises.clear();
    for (const current of liveSessions.values()) {
      current.attachedGeneration = 0;
      current.attachingGeneration = 0;
      delete current.snapshotMessages;
    }
  };

  const updateLiveSummary = (summary, expectedSessionID = null) => {
    const normalized = normalizeSummary(summary);
    if (!normalized) return null;
    if (expectedSessionID && normalized.id !== expectedSessionID) {
      throw runtimeError('Prime Agent returned a different root session than requested', 'session-identity-mismatch');
    }
    const current = liveSessions.get(normalized.id);
    const previousActiveSessionID = current?.summary?.activeSessionID ?? null;
    const preservesAttachment = Boolean(
      current
      && previousActiveSessionID
      && previousActiveSessionID === normalized.activeSessionID
      && sameResolvedPath(current.summary.sessionFile, normalized.sessionFile),
    );
    if (
      previousActiveSessionID
      && previousActiveSessionID !== normalized.activeSessionID
      && activeSessionToSession.get(previousActiveSessionID) === normalized.id
    ) {
      activeSessionToSession.delete(previousActiveSessionID);
    }
    if (normalized.activeSessionID) {
      const activeOwner = activeSessionToSession.get(normalized.activeSessionID);
      if (activeOwner && activeOwner !== normalized.id) {
        throw runtimeError('Prime Agent returned a conflicting active session identity', 'session-identity-mismatch');
      }
      activeSessionToSession.set(normalized.activeSessionID, normalized.id);
    }
    liveSessions.set(normalized.id, {
      ...current,
      summary: normalized,
      messages: preservesAttachment ? current.messages : [],
      toolExecutions: preservesAttachment ? current.toolExecutions ?? new Map() : new Map(),
      streamingContent: preservesAttachment ? current.streamingContent ?? null : null,
      attachedGeneration: preservesAttachment ? current.attachedGeneration : 0,
      attachingGeneration: preservesAttachment ? current.attachingGeneration : 0,
      lastEventCursor: preservesAttachment ? current.lastEventCursor : null,
      lastEventSequence: preservesAttachment ? current.lastEventSequence : null,
      retiredEventGenerations: preservesAttachment ? current.retiredEventGenerations : new Set(),
    });
    return normalized;
  };

  const isStaleEvent = (current, message) => {
    const cursor = messageEventCursor(message);
    if (cursor) {
      if (current.retiredEventGenerations.has(cursor.generation)) return true;
      return current.lastEventCursor?.generation === cursor.generation
        && cursor.sequence <= current.lastEventCursor.sequence;
    }
    const sequence = messageEventSequence(message);
    return sequence !== null
      && current.lastEventSequence !== null
      && sequence <= current.lastEventSequence;
  };

  const hasEventGap = (current, message) => {
    const cursor = messageEventCursor(message);
    if (cursor && current.lastEventCursor?.generation === cursor.generation) {
      return cursor.sequence > current.lastEventCursor.sequence + 1;
    }
    const sequence = messageEventSequence(message);
    return !cursor
      && sequence !== null
      && current.lastEventSequence !== null
      && sequence > current.lastEventSequence + 1;
  };

  const observeEventPosition = (current, cursorValue, sequenceValue) => {
    const cursor = normalizeEventCursor(cursorValue);
    const sequence = Number.isInteger(sequenceValue) && sequenceValue >= 0 ? sequenceValue : null;
    if (cursor) {
      if (current.lastEventCursor && current.lastEventCursor.generation !== cursor.generation) {
        current.retiredEventGenerations.add(current.lastEventCursor.generation);
        trimOldestEntries(current.retiredEventGenerations, 8);
      }
      if (
        !current.lastEventCursor
        || current.lastEventCursor.generation !== cursor.generation
        || cursor.sequence > current.lastEventCursor.sequence
      ) {
        current.lastEventCursor = cursor;
      }
      current.lastEventSequence = cursor.sequence;
      return;
    }
    if (sequence === null) return;
    current.lastEventSequence = current.lastEventSequence === null
      ? sequence
      : Math.max(current.lastEventSequence, sequence);
    if (current.lastEventCursor) {
      current.lastEventCursor = {
        ...current.lastEventCursor,
        sequence: Math.max(current.lastEventCursor.sequence, sequence),
      };
    }
  };

  const scheduleSessionResync = (sessionID) => {
    if (sessionResyncs.has(sessionID)) return;
    const current = liveSessions.get(sessionID);
    if (!current) return;
    current.attachedGeneration = 0;
    current.attachingGeneration = 0;
    delete current.snapshotMessages;
    sessionResyncs.add(sessionID);
    publishSessionChanged(sessionID, { immediate: true });
    void Promise.resolve().then(async () => {
      const sessionPath = rememberedAttachments.get(sessionID) ?? current.summary.sessionFile;
      await attachSession(sessionID, sessionPath).catch(() => {});
      if (liveSessions.get(sessionID)?.attachedGeneration === connectionGeneration) {
        publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      }
    }).finally(() => {
      sessionResyncs.delete(sessionID);
    });
  };

  const applySessionEvent = (message) => {
    const activeSessionID = asString(message.activeSessionId);
    const sessionID = activeSessionID ? activeSessionToSession.get(activeSessionID) : null;
    if (!sessionID) return;
    const current = liveSessions.get(sessionID);
    if (
      !current
      || (current.attachedGeneration !== connectionGeneration && current.attachingGeneration !== connectionGeneration)
    ) return;

    if (message.type === 'session_snapshot_begin') {
      current.snapshotMessages = [];
      return;
    }
    if (message.type === 'session_snapshot_chunk') {
      if (!Array.isArray(message.messages) || !Array.isArray(current.snapshotMessages)) return;
      current.snapshotMessages.push(...message.messages);
      if (current.snapshotMessages.length > MAX_LIVE_MESSAGES) {
        current.snapshotMessages = current.snapshotMessages.slice(-MAX_LIVE_MESSAGES);
      }
      return;
    }
    if (message.type === 'session_snapshot_end') {
      if (Array.isArray(current.snapshotMessages)) {
        current.messages = current.snapshotMessages;
        current.toolExecutions.clear();
        current.streamingContent = null;
      }
      delete current.snapshotMessages;
      observeEventPosition(current, message.lastEventCursor, message.lastEventSequence);
      publishSessionChanged(sessionID, { immediate: true });
      return;
    }
    if (message.type === 'session_snapshot_failed') {
      delete current.snapshotMessages;
      return;
    }
    if (isStaleEvent(current, message)) return;
    const carriesAuthoritativeSnapshot = message.type === 'session_replaced'
      || message.type === 'session_resynced'
      || message.type === 'session_closed'
      || (message.type === 'session_event' && message.event?.type === 'agent_end' && Array.isArray(message.event.messages));
    if (!carriesAuthoritativeSnapshot && hasEventGap(current, message)) {
      scheduleSessionResync(sessionID);
      return;
    }
    observeEventPosition(current, message.meta?.cursor ?? message.cursor, message.meta?.sequence ?? message.sequence);
    if (message.type === 'session_replaced') {
      if (message.state) updateLiveSummary(message.state, sessionID);
      const next = liveSessions.get(sessionID);
      if (next && Array.isArray(message.messages)) {
        next.messages = message.messages.slice(-MAX_LIVE_MESSAGES);
        next.toolExecutions.clear();
        next.streamingContent = null;
      }
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (message.type === 'session_resynced') {
      if (message.snapshot?.summary) updateLiveSummary(message.snapshot.summary, sessionID);
      const next = liveSessions.get(sessionID);
      if (next && Array.isArray(message.snapshot?.messages)) {
        next.messages = message.snapshot.messages.slice(-MAX_LIVE_MESSAGES);
        const streamingMessage = message.snapshot?.summary?.streamingMessage;
        if (streamingMessage) next.messages = replaceOrAppendMessage(next.messages, streamingMessage);
        next.toolExecutions.clear();
        next.streamingContent = streamingMessage
          ? { messageIdentity: messageIdentity(streamingMessage), contentIndex: Math.max(0, (streamingMessage.content?.length ?? 1) - 1) }
          : null;
      }
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (message.type === 'session_closed') {
      current.summary = { ...current.summary, activity: 'idle', isSessionActive: false, activeSessionID: null };
      current.attachedGeneration = 0;
      current.attachingGeneration = 0;
      if (activeSessionID && activeSessionToSession.get(activeSessionID) === sessionID) {
        activeSessionToSession.delete(activeSessionID);
      }
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (message.type !== 'session_event' || !message.event || typeof message.event !== 'object') return;

    const event = message.event;
    if (event.type === 'agent_start') {
      current.summary = { ...current.summary, activity: 'working' };
      current.toolExecutions.clear();
      current.streamingContent = null;
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (event.type === 'agent_end') {
      if (Array.isArray(event.messages)) current.messages = mergeMessages(current.messages, event.messages);
      current.summary = { ...current.summary, activity: 'idle', updatedAt: new Date().toISOString() };
      current.streamingContent = null;
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
      current.messages = replaceOrAppendMessage(current.messages, event.message);
      if (event.type === 'message_end') {
        current.streamingContent = null;
      } else {
        const contentEvent = event.assistantMessageEvent;
        const contentIndex = Number.isInteger(contentEvent?.contentIndex) && contentEvent.contentIndex >= 0
          ? contentEvent.contentIndex
          : null;
        const contentEventType = asString(contentEvent?.type);
        if (contentIndex !== null && contentEventType?.endsWith('_end')) {
          current.streamingContent = null;
        } else if (contentIndex !== null && contentEventType) {
          current.streamingContent = {
            messageIdentity: messageIdentity(event.message),
            contentIndex,
          };
        }
      }
      publishSessionChanged(sessionID);
      return;
    }
    if (
      event.type === 'tool_execution_start'
      || event.type === 'tool_execution_update'
      || event.type === 'tool_execution_end'
    ) {
      const toolCallID = asString(event.toolCallId);
      if (!toolCallID) return;
      const previous = current.toolExecutions.get(toolCallID);
      current.toolExecutions.delete(toolCallID);
      current.toolExecutions.set(toolCallID, {
        callID: toolCallID,
        name: asString(event.toolName) ?? previous?.name ?? 'tool',
        input: event.args && typeof event.args === 'object' ? event.args : previous?.input ?? null,
        output: event.type === 'tool_execution_end'
          ? toolExecutionText(event.result)
          : toolExecutionText(event.partialResult) ?? previous?.output ?? null,
        status: event.type === 'tool_execution_end'
          ? event.isError === true ? 'error' : 'completed'
          : 'running',
      });
      trimOldestEntries(current.toolExecutions, MAX_LIVE_TOOL_EXECUTIONS);
      publishSessionChanged(sessionID);
      return;
    }
    if (event.type === 'rlm_child_update') {
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (event.type === 'session_info_changed') {
      current.summary = { ...current.summary, title: asString(event.name) };
      publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
      return;
    }
    if (event.type === 'thinking_level_changed') {
      publishSessionChanged(sessionID, { immediate: true });
    }
  };

  const handleMessage = (message, helloHandlers) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'daemon_hello') {
      if (
        message.protocol?.name !== PRIME_PROTOCOL.name
        || message.protocol?.version !== PRIME_PROTOCOL.version
        || message.schemaId !== PRIME_SCHEMA_ID
      ) {
        const error = new Error('Prime Agent daemon protocol is incompatible with this OpenChamber build');
        error.code = 'incompatible';
        helloHandlers?.reject(error);
        socket?.destroy(error);
        return;
      }
      hello = message;
      helloHandlers?.resolve(message);
      return;
    }

    if (message.type === 'response' && asString(message.id)) {
      const commandID = message.id;
      const requestState = pending.get(commandID);
      if (!requestState) {
        const lateCommand = mutationResultsAwaitingAck.get(commandID);
        if (lateCommand) {
          mutationResultsAwaitingAck.delete(commandID);
          acknowledgeResult(commandID);
          const activeSessionID = asString(lateCommand.activeSessionId);
          const sessionID = activeSessionID ? activeSessionToSession.get(activeSessionID) : null;
          if (message.success === true && sessionID) {
            publishSessionChanged(sessionID, {
              immediate: true,
              catalogChanged: lateCommand.type === 'prompt',
            });
          }
        }
        return;
      }
      pending.delete(commandID);
      clearTimeout(requestState.timeout);
      if (MUTATION_COMMANDS.has(requestState.command)) {
        mutationResultsAwaitingAck.delete(commandID);
        acknowledgeResult(commandID);
      }
      if (message.success === true) {
        requestState.resolve(message.data);
      } else {
        const error = new Error(asString(message.error) || `Prime Agent ${requestState.command} failed`);
        error.code = asString(message.errorInfo?.code) || 'command-failed';
        error.errorInfo = message.errorInfo;
        requestState.reject(error);
      }
      return;
    }

    applySessionEvent(message);
  };

  const scheduleReconnect = () => {
    if (!desired || reconnectTimer) return;
    const delay = Math.min(500 * (2 ** Math.min(reconnectAttempt, 6)), 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      void connectOrLaunch();
    }, delay);
    reconnectTimer.unref?.();
  };

  const openSocket = async () => {
    if (socket && !socket.destroyed && hello) return hello;
    return await new Promise((resolve, reject) => {
      let settled = false;
      socketBuffer = '';
      const candidate = net.createConnection(socketPath);
      candidate.setEncoding('utf8');
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        candidate.destroy();
        reject(error);
      };
      const helloTimeout = setTimeout(() => finishReject(new Error('Prime Agent daemon did not become ready')), 2_000);
      helloTimeout.unref?.();

      const helloHandlers = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(helloTimeout);
          socket = candidate;
          connectionGeneration += 1;
          resolve(value);
        },
        reject: finishReject,
      };

      candidate.on('data', (chunk) => {
        socketBuffer += chunk;
        if (Buffer.byteLength(socketBuffer, 'utf8') > MAX_DAEMON_LINE_BYTES) {
          candidate.destroy(new Error('Prime Agent daemon frame exceeded the OpenChamber limit'));
          return;
        }
        while (true) {
          const newline = socketBuffer.indexOf('\n');
          if (newline < 0) break;
          let line = socketBuffer.slice(0, newline);
          socketBuffer = socketBuffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) continue;
          try {
            handleMessage(JSON.parse(line), settled ? null : helloHandlers);
          } catch {
            candidate.destroy(new Error('Prime Agent daemon sent invalid JSON'));
          }
        }
      });
      candidate.once('error', finishReject);
      candidate.on('close', () => {
        clearTimeout(helloTimeout);
        if (!settled) {
          finishReject(new Error('Prime Agent daemon connection closed before readiness'));
          return;
        }
        if (socket !== candidate) return;
        socket = null;
        hello = null;
        invalidateAttachmentAuthority();
        clearPending(new Error('Prime Agent daemon connection closed'));
        publishStatus({
          state: 'unavailable',
          interactive: false,
          authentication: 'unknown',
          version: null,
          message: 'Prime Agent daemon disconnected',
        });
        scheduleReconnect();
      });
    });
  };

  const resolveBinary = async () => {
    let settings;
    try {
      settings = await readSettingsFromDiskMigrated();
    } catch {
      throw runtimeError('OpenChamber could not read the Prime Agent executable setting', 'settings-unavailable');
    }
    const configured = asString(settings?.primeAgentBinary);
    if (configured) {
      if (!isExecutable(configured)) {
        throw runtimeError(`Configured Prime Agent executable is not runnable: ${configured}`, 'invalid-binary');
      }
      return { binary: configured, source: 'settings' };
    }
    const environmentBinary = asString(env.PRIME_AGENT_BINARY);
    if (environmentBinary) {
      if (!isExecutable(environmentBinary)) {
        throw runtimeError(`PRIME_AGENT_BINARY is not runnable: ${environmentBinary}`, 'invalid-binary');
      }
      return { binary: environmentBinary, source: 'environment' };
    }
    for (const name of processLike.platform === 'win32'
      ? ['prime-agent.exe', 'prime-agent.cmd', 'prime-agent']
      : ['prime-agent']) {
      const candidate = searchPathFor(name, buildAugmentedPath());
      if (candidate && isExecutable(candidate)) return { binary: candidate, source: 'path' };
    }
    return null;
  };

  const launchDaemon = (resolved) => {
    if (!resolved) {
      publishStatus({
        state: 'not-configured',
        interactive: false,
        authentication: 'unknown',
        binarySource: null,
        version: null,
        message: 'Prime Agent executable was not found',
      });
      return null;
    }

    publishStatus({
      state: 'starting',
      interactive: false,
      authentication: 'unknown',
      binarySource: resolved.source,
      message: null,
    });
    let failure = null;
    const fail = (message) => {
      if (failure) return;
      failure = runtimeError(message, 'launch-failed');
      publishStatus({ state: 'unavailable', interactive: false, authentication: 'unknown', message });
    };
    let child;
    try {
      child = spawn(resolved.binary, ['--mode', 'daemon', '--daemon-socket', socketPath], {
        cwd: processLike.cwd(),
        detached: processLike.platform !== 'win32',
        env: { ...env, PATH: buildAugmentedPath() },
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      fail('Prime Agent could not start the configured executable');
      return { getFailure: () => failure };
    }
    child.once('error', () => fail('Prime Agent could not start the configured executable'));
    child.once('exit', (code, signal) => {
      if (socket && !socket.destroyed) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      fail(`Prime Agent exited before its daemon became ready (${reason})`);
    });
    child.unref?.();
    return { getFailure: () => failure };
  };

  const assertSelectedBinaryMatchesRuntime = (resolved) => {
    if (!resolved || resolved.source === 'path') return;
    const expected = path.resolve(resolved.binary);
    const runtimePaths = [hello?.runtime?.launcherPath, hello?.runtime?.executablePath, hello?.runtime?.entrypointPath]
      .map(asString)
      .filter(Boolean)
      .map((candidate) => path.resolve(candidate));
    if (runtimePaths.length === 0 || runtimePaths.includes(expected)) return;
    throw runtimeError(
      `The running Prime Agent daemon does not match the selected executable: ${resolved.binary}. Stop the existing Prime Agent daemon and retry.`,
      'binary-mismatch',
    );
  };

  const probeAuthentication = async () => {
    let activeSessionID = null;
    try {
      const created = await request({
        type: 'create',
        noSession: true,
        lifecycle: 'client_owned',
        config: { cwd: processLike.cwd() },
      });
      activeSessionID = asString(created?.activeSessionId);
      if (!activeSessionID) return 'unknown';
      const catalog = await request({ type: 'get_model_catalog', activeSessionId: activeSessionID });
      return Array.isArray(catalog?.configuredProviders) && catalog.configuredProviders.length > 0
        ? 'authenticated'
        : 'unauthenticated';
    } catch {
      return 'unknown';
    } finally {
      if (activeSessionID) await request({ type: 'kill', activeSessionId: activeSessionID }).catch(() => {});
    }
  };

  const connectOrLaunch = async () => {
    if (!desired) return getStatus();
    if (connectPromise) return await connectPromise;
    connectPromise = (async () => {
      publishStatus({ state: 'starting', interactive: false, authentication: 'unknown', message: null });
      try {
        const resolved = await resolveBinary();
        try {
          await openSocket();
        } catch (initialError) {
          if (initialError?.code === 'incompatible') throw initialError;
          const launch = launchDaemon(resolved);
          if (!launch) return getStatus();
          const deadline = Date.now() + START_TIMEOUT_MS;
          let lastError = initialError;
          while (desired && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (launch.getFailure()) throw launch.getFailure();
            try {
              await openSocket();
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError) throw lastError;
        }

        assertSelectedBinaryMatchesRuntime(resolved);
        reconnectAttempt = 0;
        publishStatus({
          state: 'ready',
          interactive: false,
          authentication: 'unknown',
          binarySource: resolved?.source ?? null,
          version: asString(hello?.appVersion),
          message: null,
        });
        const authentication = await probeAuthentication();
        publishStatus({
          state: 'ready',
          interactive: authentication !== 'unauthenticated',
          authentication,
          message: authentication === 'unauthenticated'
            ? 'Prime Agent has no authenticated model available. Sign in with Prime Agent, then retry.'
            : null,
        });
        try {
          const summaries = await listSessions({ scheduleReattach: false, includeChildren: true });
          for (const [sessionID, sessionPath] of rememberedAttachments) {
            if (status.state !== 'ready') break;
            await attachSession(sessionID, sessionPath, { summaries, remember: false }).catch(() => {});
          }
        } catch {
          // Catalog and attachment recovery are retried by normal UI reconciliation.
        }
      } catch (error) {
        const incompatible = error?.code === 'incompatible';
        const notConfigured = error?.code === 'invalid-binary';
        publishStatus({
          state: incompatible ? 'incompatible' : notConfigured ? 'not-configured' : 'unavailable',
          interactive: false,
          authentication: 'unknown',
          version: null,
          message: asString(error?.publicMessage)
            ?? (incompatible ? error.message : 'Prime Agent daemon is unavailable'),
        });
        scheduleReconnect();
      }
      return getStatus();
    })();
    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  };

  const start = async () => {
    desired = true;
    return await connectOrLaunch();
  };

  const reconcile = async () => {
    desired = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (status.state === 'not-configured' || status.state === 'unavailable' || status.state === 'incompatible') {
      socket?.destroy();
      socket = null;
      hello = null;
      invalidateAttachmentAuthority();
    }
    return await connectOrLaunch();
  };

  async function listSessions(options = {}) {
    const response = await request({ type: 'list', all: true });
    const summaries = Array.isArray(response?.sessions) ? response.sessions : [];
    const normalized = [];
    for (const summary of summaries) {
      const next = normalizeSummary(summary);
      if (!next) continue;
      updateLiveSummary(summary);
      if (next.isChild && options.includeChildren !== true) continue;
      normalized.push(next);
      if (normalized.length >= 5_000) break;
    }
    if (options.scheduleReattach !== false) {
      for (const summary of normalized) {
        const rememberedPath = rememberedAttachments.get(summary.id);
        const current = liveSessions.get(summary.id);
        if (
          rememberedPath
          && sameResolvedPath(rememberedPath, summary.sessionFile)
          && current?.attachedGeneration !== connectionGeneration
          && current?.attachingGeneration !== connectionGeneration
        ) {
          scheduleSessionResync(summary.id);
        }
      }
    }
    return normalized;
  }

  async function attachSessionInternal(sessionID, sessionPath = null, options = {}) {
    let summaries = options.summaries ?? await listSessions({ scheduleReattach: false, includeChildren: true });
    let summary = summaries.find((candidate) => candidate.id === sessionID) ?? null;
    if (!summary?.activeSessionID) {
      if (summary?.isChild) {
        summary = { ...summary, activeSessionID: summary.id };
      } else {
        if (!sessionPath) throw new Error('Prime Agent session is not active and has no saved transcript path');
        const created = await request({ type: 'create', sessionPath, lifecycle: 'resident' });
        summary = updateLiveSummary(created, sessionID);
        if (!summary?.activeSessionID) throw new Error('Prime Agent did not return an active session');
        summaries = [summary, ...summaries.filter((candidate) => candidate.id !== summary.id)];
      }
    }

    if (sessionPath && !sameResolvedPath(summary.sessionFile, sessionPath)) {
      throw runtimeError('Prime Agent returned a different session file than requested', 'session-identity-mismatch');
    }

    const beforeAttach = liveSessions.get(sessionID);
    if (!beforeAttach) throw new Error('Prime Agent session state is unavailable');
    beforeAttach.attachingGeneration = connectionGeneration;

    try {
      const attached = await request({
        type: 'attach',
        activeSessionId: summary.activeSessionID,
        clientId: clientID,
        capabilities: PRIME_CLIENT_CAPABILITIES,
      });
      const snapshotSummary = attached?.snapshot?.summary ?? attached?.state ?? summary.raw;
      const normalized = updateLiveSummary(snapshotSummary, sessionID) ?? summary;
      if (sessionPath && !sameResolvedPath(normalized.sessionFile, sessionPath)) {
        throw runtimeError('Prime Agent attached a different session file than requested', 'session-identity-mismatch');
      }
      const current = liveSessions.get(sessionID);
      if (current) {
        current.messages = Array.isArray(attached?.snapshot?.messages)
          ? attached.snapshot.messages.slice(-MAX_LIVE_MESSAGES)
          : current.messages;
        const streamingMessage = attached?.snapshot?.summary?.streamingMessage;
        if (streamingMessage) current.messages = replaceOrAppendMessage(current.messages, streamingMessage);
        current.toolExecutions.clear();
        current.streamingContent = streamingMessage
          ? { messageIdentity: messageIdentity(streamingMessage), contentIndex: Math.max(0, (streamingMessage.content?.length ?? 1) - 1) }
          : null;
        current.attachedGeneration = connectionGeneration;
        current.attachingGeneration = 0;
        observeEventPosition(
          current,
          attached?.snapshot?.lastEventCursor ?? attached?.lastEventCursor,
          attached?.snapshot?.lastEventSequence ?? attached?.lastEventSequence,
        );
      }
      if (options.remember !== false) rememberAttachment(sessionID, sessionPath ?? normalized.sessionFile);
      return normalized;
    } catch (error) {
      const current = liveSessions.get(sessionID);
      if (current?.attachingGeneration === connectionGeneration) {
        current.attachingGeneration = 0;
        delete current.snapshotMessages;
      }
      throw error;
    }
  }

  async function attachSession(sessionID, sessionPath = null, options = {}) {
    const current = liveSessions.get(sessionID);
    if (
      current?.attachedGeneration === connectionGeneration
      && current.summary.activeSessionID
      && (!sessionPath || sameResolvedPath(current.summary.sessionFile, sessionPath))
    ) {
      if (options.remember !== false) rememberAttachment(sessionID, sessionPath ?? current.summary.sessionFile);
      return current.summary;
    }
    const attachmentKey = `${sessionID}\0${sessionPath ? path.resolve(sessionPath) : ''}`;
    const existing = attachmentPromises.get(attachmentKey);
    if (existing) return await existing;
    const operation = attachSessionInternal(sessionID, sessionPath, options);
    attachmentPromises.set(attachmentKey, operation);
    try {
      return await operation;
    } finally {
      if (attachmentPromises.get(attachmentKey) === operation) attachmentPromises.delete(attachmentKey);
    }
  }

  const getDraftControls = async (directory) => {
    const cacheKey = path.resolve(directory);
    const cached = draftControlsCache.get(cacheKey);
    if (
      cached
      && cached.generation === connectionGeneration
      && Date.now() - cached.loadedAt < DRAFT_CONTROLS_MAX_AGE_MS
    ) {
      draftControlsCache.delete(cacheKey);
      draftControlsCache.set(cacheKey, cached);
      return cached.controls;
    }
    const existing = draftControlsPromises.get(cacheKey);
    if (existing) return await existing;

    const operation = (async () => {
      let activeSessionID = null;
      try {
        const created = await request({
          type: 'create',
          noSession: true,
          lifecycle: 'client_owned',
          config: { cwd: cacheKey },
        });
        activeSessionID = asString(created?.activeSessionId);
        if (!activeSessionID) throw new Error('Prime Agent did not return draft controls');
        const controls = await readSessionControls({ activeSessionID });
        draftControlsCache.delete(cacheKey);
        draftControlsCache.set(cacheKey, {
          generation: connectionGeneration,
          loadedAt: Date.now(),
          controls,
        });
        trimOldestEntries(draftControlsCache, MAX_DRAFT_CONTROLS_ENTRIES);
        return controls;
      } finally {
        if (activeSessionID) await request({ type: 'kill', activeSessionId: activeSessionID }).catch(() => {});
      }
    })();
    draftControlsPromises.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      if (draftControlsPromises.get(cacheKey) === operation) draftControlsPromises.delete(cacheKey);
    }
  };

  const createSession = async ({ directory, prompt, sessionPathForID, provider, modelID, thinkingLevel }) => {
    const created = await request({
      type: 'create',
      config: {
        cwd: directory,
        ...(provider ? { provider } : {}),
        ...(modelID ? { model: modelID } : {}),
        ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
      },
      lifecycle: 'resident',
    });
    const summary = updateLiveSummary(created);
    if (!summary?.activeSessionID) throw new Error('Prime Agent did not return an active session');
    const cleanupCreatedSession = () => request({ type: 'kill', activeSessionId: summary.activeSessionID }).catch(() => {});
    let expectedSessionPath;
    try {
      expectedSessionPath = sessionPathForID(summary.id);
    } catch (error) {
      await cleanupCreatedSession();
      throw error;
    }
    if (!sameResolvedPath(summary.sessionFile, expectedSessionPath)) {
      await cleanupCreatedSession();
      throw runtimeError('Prime Agent created the session outside the configured session directory', 'session-identity-mismatch');
    }
    try {
      const attached = await attachSession(summary.id, expectedSessionPath);
      await request({
        type: 'prompt',
        activeSessionId: attached.activeSessionID,
        message: prompt,
        source: 'interactive',
      });
    } catch (error) {
      error.session = summary;
      throw error;
    }
    publishSessionChanged(summary.id, { immediate: true, catalogChanged: true });
    return summary;
  };

  const sendPrompt = async ({ sessionID, sessionPath, prompt }) => {
    const summary = await attachSession(sessionID, sessionPath);
    await request({
      type: 'prompt',
      activeSessionId: summary.activeSessionID,
      message: prompt,
      streamingBehavior: summary.activity === 'working' ? 'followUp' : undefined,
      source: 'interactive',
    });
    publishSessionChanged(sessionID, { immediate: true, catalogChanged: true });
  };

  const abortSession = async ({ sessionID, sessionPath }) => {
    const summary = await attachSession(sessionID, sessionPath);
    await request({ type: 'abort', activeSessionId: summary.activeSessionID });
    publishSessionChanged(sessionID, { immediate: true });
  };

  const readSessionControls = async (summary) => {
    const [connectionState, availableModelsResult, commandsResult] = await Promise.all([
      request({ type: 'get_connection_state', activeSessionId: summary.activeSessionID }),
      request({ type: 'get_available_models', activeSessionId: summary.activeSessionID }),
      request({ type: 'get_commands', activeSessionId: summary.activeSessionID }),
    ]);
    const currentModel = normalizeModel(connectionState?.model);
    const modelsByKey = new Map();
    for (const candidate of Array.isArray(availableModelsResult?.models) ? availableModelsResult.models : []) {
      const model = normalizeModel(candidate);
      if (model) modelsByKey.set(`${model.provider}\0${model.id}`, model);
    }
    if (currentModel) modelsByKey.set(`${currentModel.provider}\0${currentModel.id}`, currentModel);
    return {
      model: currentModel,
      thinkingLevel: normalizeThinkingLevel(connectionState?.thinkingLevel) ?? 'off',
      availableThinkingLevels: Array.from(new Set(
        (Array.isArray(connectionState?.availableThinkingLevels) ? connectionState.availableThinkingLevels : [])
          .map(normalizeThinkingLevel)
          .filter(Boolean),
      )),
      models: [...modelsByKey.values()],
      commands: (Array.isArray(commandsResult?.commands) ? commandsResult.commands : [])
        .map(normalizeSlashCommand)
        .filter(Boolean),
    };
  };

  const getSessionControls = async ({ sessionID, sessionPath }) => {
    const summary = await attachSession(sessionID, sessionPath);
    return await readSessionControls(summary);
  };

  const setSessionModel = async ({ sessionID, sessionPath, provider, modelID }) => {
    const summary = await attachSession(sessionID, sessionPath);
    await request({ type: 'set_model', activeSessionId: summary.activeSessionID, provider, modelId: modelID });
    publishSessionChanged(sessionID, { immediate: true });
  };

  const setSessionThinkingLevel = async ({ sessionID, sessionPath, level }) => {
    const summary = await attachSession(sessionID, sessionPath);
    await request({ type: 'set_thinking_level', activeSessionId: summary.activeSessionID, level });
    publishSessionChanged(sessionID, { immediate: true });
  };

  const getLiveTranscript = (sessionID) => {
    if (status.state !== 'ready') return null;
    const current = liveSessions.get(sessionID);
    const rememberedPath = rememberedAttachments.get(sessionID);
    if (
      !current
      || !rememberedAttachments.has(sessionID)
      || (
        rememberedPath
        && !sameResolvedPath(rememberedPath, current.summary.sessionFile)
      )
    ) return null;
    if (current.attachedGeneration !== connectionGeneration) {
      scheduleSessionResync(sessionID);
      return null;
    }
    if (current.messages.length === 0) return null;
    return {
      summary: { ...current.summary },
      messages: current.messages.slice(),
      toolExecutions: [...current.toolExecutions.values()],
      streamingContent: current.streamingContent ? { ...current.streamingContent } : null,
    };
  };

  const dispose = async () => {
    desired = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const timer of sessionEventTimers.values()) clearTimeout(timer);
    sessionEventTimers.clear();
    if (socket && !socket.destroyed) {
      try {
        writeEnvelope({ type: 'detach' });
      } catch {
        // Best effort: resident Prime sessions continue without this client.
      }
      socket.end();
    }
    socket = null;
    hello = null;
    invalidateAttachmentAuthority();
    attachmentPromises.clear();
    draftControlsCache.clear();
    draftControlsPromises.clear();
    clearPending(new Error('Prime Agent runtime stopped'));
    mutationResultsAwaitingAck.clear();
    publishStatus({ state: 'unavailable', interactive: false, message: 'Prime Agent runtime stopped' });
  };

  return {
    start,
    reconcile,
    dispose,
    getStatus,
    listSessions,
    attachSession,
    getDraftControls,
    createSession,
    sendPrompt,
    abortSession,
    getSessionControls,
    setSessionModel,
    setSessionThinkingLevel,
    getLiveTranscript,
  };
};
