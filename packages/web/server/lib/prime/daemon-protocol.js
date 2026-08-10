import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const PRIME_DAEMON_PROTOCOL_NAME = 'prime-agent.daemon';
export const PRIME_DAEMON_PROTOCOL_VERSION = 7;
export const PRIME_DAEMON_SCHEMA_REVISION = 13;
export const PRIME_DAEMON_SCHEMA_ID = 'protocol-7-schema-13-816309b1cd50';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 1_000;
const HELLO_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUIRED_CAPABILITIES = ['attach_snapshot', 'event_sequence', 'slim_attach', 'chunked_snapshot'];
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class PrimeDaemonProtocolError extends Error {
  constructor(code) {
    super('Prime daemon protocol failure');
    this.name = 'PrimeDaemonProtocolError';
    this.code = code;
  }
}

const validHello = (message) => isRecord(message)
  && message.type === 'daemon_hello'
  && isRecord(message.protocol)
  && message.protocol.name === PRIME_DAEMON_PROTOCOL_NAME
  && message.protocol.version === PRIME_DAEMON_PROTOCOL_VERSION
  && message.schemaRevision === PRIME_DAEMON_SCHEMA_REVISION
  && message.schemaId === PRIME_DAEMON_SCHEMA_ID
  && typeof message.clientId === 'string'
  && Array.isArray(message.serverCapabilities)
  && REQUIRED_CAPABILITIES.every((capability) => message.serverCapabilities.includes(capability));
const isResponse = (message) => isRecord(message)
  && message.type === 'response'
  && typeof message.id === 'string'
  && typeof message.command === 'string'
  && typeof message.success === 'boolean';

/** Strict bounded JSONL connection to Prime's official public supervisor socket. */
export class PrimeDaemonConnection {
  constructor(socketPath, { protocolClientId = `openchamber:${randomUUID()}` } = {}) {
    this.socketPath = socketPath;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.hello = null;
    this.closed = false;
    this.protocolClientId = protocolClientId;
    this.requestSequence = 0;
    this.pending = new Map();
    this.messageListeners = new Set();
    this.closeListeners = new Set();
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async connect({ connectTimeoutMs = CONNECT_TIMEOUT_MS, helloTimeoutMs = HELLO_TIMEOUT_MS } = {}) {
    if (this.socket || this.closed) throw new PrimeDaemonProtocolError('prime_daemon_invalid_connection_state');
    const socket = net.createConnection({ path: this.socketPath });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.handleBytes(chunk));
    socket.on('error', (error) => this.handleClose(error));
    socket.on('close', () => this.handleClose(new PrimeDaemonProtocolError('prime_daemon_disconnected')));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new PrimeDaemonProtocolError('prime_daemon_connect_timeout')), connectTimeoutMs);
        timer.unref?.();
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      await this.waitForHello(helloTimeoutMs);
      return this.hello;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async request(command, timeoutMs = REQUEST_TIMEOUT_MS, { commandId } = {}) {
    if (!this.socket || this.closed || !this.hello || !isRecord(command) || typeof command.type !== 'string') {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_request');
    }
    const id = commandId || `openchamber_${++this.requestSequence}_${randomUUID()}`;
    if (typeof id !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(id) || this.pending.has(id)) {
      throw new PrimeDaemonProtocolError('prime_daemon_invalid_command_id');
    }
    const payload = JSON.stringify({
      type: 'command',
      id,
      protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
      clientId: this.protocolClientId,
      command: { ...command, id },
    });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) throw new PrimeDaemonProtocolError('prime_daemon_frame_too_large');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrimeDaemonProtocolError('prime_daemon_request_timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        command: command.type,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    try {
      this.socket.write(`${payload}
`);
    } catch (error) {
      this.pending.get(id)?.reject(error);
      this.pending.delete(id);
    }
    return result;
  }

  acknowledge(commandId) {
    if (!this.socket || this.closed || !this.hello || typeof commandId !== 'string') return;
    const id = `openchamber_ack_${++this.requestSequence}_${randomUUID()}`;
    const payload = JSON.stringify({
      type: 'command',
      id,
      protocol: { name: PRIME_DAEMON_PROTOCOL_NAME, version: PRIME_DAEMON_PROTOCOL_VERSION },
      clientId: this.protocolClientId,
      command: { id, type: 'ack_result', commandId },
    });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return;
    try { this.socket.write(`${payload}
`); } catch { /* Recovery entry remains for later compaction. */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new PrimeDaemonProtocolError('prime_daemon_disconnected'));
    this.messageListeners.clear();
    this.closeListeners.clear();
    this.socket?.destroy();
    this.socket = null;
  }

  waitForHello(timeoutMs) {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message.type !== 'daemon_hello') return;
        cleanup();
        resolve(message);
      };
      const onClose = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PrimeDaemonProtocolError('prime_daemon_hello_timeout'));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.messageListeners.delete(onMessage);
        this.closeListeners.delete(onClose);
      };
      this.messageListeners.add(onMessage);
      this.closeListeners.add(onClose);
    });
  }

  handleBytes(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES && this.buffer.indexOf(0x0a) === -1) {
      this.failProtocol('prime_daemon_frame_too_large');
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        this.failProtocol('prime_daemon_frame_too_large');
        return;
      }
      let line = frame.toString('utf8');
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failProtocol('prime_daemon_invalid_json');
        return;
      }
      try {
        this.handleMessage(message);
      } catch (error) {
        this.failProtocol(error instanceof PrimeDaemonProtocolError ? error.code : 'prime_daemon_invalid_message');
        return;
      }
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this.failProtocol('prime_daemon_frame_too_large');
  }

  handleMessage(message) {
    if (!isRecord(message)) throw new PrimeDaemonProtocolError('prime_daemon_invalid_message');
    if (!this.hello) {
      if (!validHello(message)) throw new PrimeDaemonProtocolError('prime_daemon_incompatible');
      this.hello = message;
      this.emitMessage(message);
      return;
    }
    if (message.type === 'daemon_hello') throw new PrimeDaemonProtocolError('prime_daemon_duplicate_hello');
    if (message.type !== 'response') {
      this.emitMessage(message);
      return;
    }
    if (!isResponse(message)) throw new PrimeDaemonProtocolError('prime_daemon_invalid_response');
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.command !== pending.command) {
      pending.reject(new PrimeDaemonProtocolError('prime_daemon_response_mismatch'));
      return;
    }
    pending.resolve(message);
  }

  emitMessage(message) {
    for (const listener of this.messageListeners) {
      try { listener(message); } catch { /* A consumer cannot corrupt framing. */ }
    }
  }

  failProtocol(code) {
    const error = new PrimeDaemonProtocolError(code);
    this.handleClose(error);
    this.close();
  }

  handleClose(error) {
    if (this.closed) return;
    this.rejectPending(error);
    for (const listener of [...this.closeListeners]) {
      try { listener(error); } catch { /* Best-effort teardown notification. */ }
    }
  }

  rejectPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
