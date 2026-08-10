import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  PrimeFileAccessError,
  openBoundedDirectory,
  openContainedRegularFile,
  readBoundedFile,
  readBoundedHeader,
  readFileRange,
  resolveOptionalContainedDirectory,
  resolveRequiredDirectory,
} from './secure-files.js';

const execFileAsync = promisify(execFile);
const PUBLIC_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RLM_CHILD_ID = /^sub-[0-9a-f]{8}$/;
const ROOT_DIRECTORY_ENTRY_LIMIT = 10_000;
const ROOT_SESSION_LIMIT = 2_000;
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
const REGISTRY_LINE_MAX_BYTES = 256 * 1024;
const METADATA_RANGE_BYTES = 256 * 1024;
const CATALOG_WORK_MAX_BYTES = 128 * 1024 * 1024;
const RLM_NODE_LIMIT = 2_000;
const RLM_DEPTH_LIMIT = 8;
const ISSUE_LIMIT = 200;
const WORKER_DIRECTORY_LIMIT = 32;
const WORKER_DESCRIPTOR_LIMIT = 32;
const WORKER_DESCRIPTOR_MAX_BYTES = 128 * 1024;
const WORKER_JOURNAL_MAX_BYTES = 1024 * 1024;
const RESIDENCY_WORK_MAX_BYTES = 8 * 1024 * 1024;
const RESIDENCY_DEADLINE_MS = 2_000;

const hashValue = (value) => createHash('sha256').update(value).digest('base64url').slice(0, 24);
const finiteTimestamp = (value) => {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? timestamp : undefined;
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const closeDirectory = async (directory) => {
  try {
    await directory?.close();
  } catch {
    // Async directory iteration may already have closed it.
  }
};

const issueCollector = () => {
  const issues = [];
  const seen = new Set();
  return {
    add(code, sessionId) {
      const key = `${code}:${sessionId || ''}`;
      if (seen.has(key) || issues.length >= ISSUE_LIMIT) return;
      seen.add(key);
      issues.push({ code, ...(sessionId ? { sessionId } : {}) });
    },
    list: issues,
  };
};

const extractText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
};

const parseMetadataBuffer = (buffer, { skipFirstLine, state }) => {
  let text = buffer.toString('utf8');
  if (skipFirstLine) {
    const newlineIndex = text.indexOf('\n');
    text = newlineIndex < 0 ? '' : text.slice(newlineIndex + 1);
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (Buffer.byteLength(line) > REGISTRY_LINE_MAX_BYTES) {
      state.partial = true;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      state.partial = true;
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === 'session_info') {
      state.persistedTitle = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) continue;
    if (!state.firstUserText && entry.message.role === 'user') {
      const textContent = extractText(entry.message.content).trim();
      if (textContent) state.firstUserText = textContent;
    }
  }
};

const scanSessionMetadata = async (openedFile, workBudget) => {
  const state = { partial: false, persistedTitle: undefined, firstUserText: '' };
  const size = openedFile.metadata.size;
  const headLength = Math.min(size, METADATA_RANGE_BYTES);
  if (workBudget.remaining < headLength) return { ...state, partial: true };
  workBudget.remaining -= headLength;
  parseMetadataBuffer(await readFileRange(openedFile.handle, 0, headLength), { skipFirstLine: false, state });
  if (size > headLength) {
    const tailLength = Math.min(size - headLength, METADATA_RANGE_BYTES);
    if (workBudget.remaining < tailLength) return { ...state, partial: true };
    workBudget.remaining -= tailLength;
    parseMetadataBuffer(await readFileRange(openedFile.handle, size - tailLength, tailLength), {
      skipFirstLine: size - tailLength > 0,
      state,
    });
    if (headLength + tailLength < size) state.partial = true;
  }
  return state;
};

const validateSessionFile = async ({ filePath, containmentRoot, expectedParent, registryTitle, workBudget }) => {
  const openedFile = await openContainedRegularFile(filePath, containmentRoot);
  try {
    const header = await readBoundedHeader(openedFile);
    const sessionId = typeof header?.id === 'string' ? header.id : '';
    if (header?.type !== 'session'
      || !PUBLIC_SESSION_ID.test(sessionId)
      || path.basename(filePath) !== `${sessionId}.jsonl`) {
      throw new PrimeFileAccessError('invalid_session_header');
    }
    if (expectedParent) {
      if (typeof header.parentSession !== 'string') {
        throw new PrimeFileAccessError('invalid_session_ancestry');
      }
      let declaredParent;
      try {
        declaredParent = await realpath(path.resolve(path.dirname(filePath), header.parentSession));
      } catch {
        throw new PrimeFileAccessError('invalid_session_ancestry');
      }
      if (declaredParent !== expectedParent.filePath) {
        throw new PrimeFileAccessError('invalid_session_ancestry');
      }
    }
    const metadata = await scanSessionMetadata(openedFile, workBudget);
    const finalMetadata = await openedFile.handle.stat();
    const changedDuringScan = finalMetadata.size !== openedFile.metadata.size
      || finalMetadata.mtimeMs !== openedFile.metadata.mtimeMs;
    const titleSource = metadata.persistedTitle || registryTitle || metadata.firstUserText || 'Untitled session';
    const title = titleSource.length > 300 ? `${titleSource.slice(0, 299)}…` : titleSource;
    return {
      sessionId,
      filePath: openedFile.realPath,
      containmentRoot,
      header,
      fileRevision: hashValue([
        sessionId,
        finalMetadata.dev,
        finalMetadata.ino,
        finalMetadata.size,
        finalMetadata.mtimeMs,
      ].join(':')),
      size: finalMetadata.size,
      title,
      titleTruncated: title !== titleSource,
      metadataPartial: metadata.partial || changedDuringScan,
      workingDirectory: typeof header.cwd === 'string'
        && path.isAbsolute(header.cwd)
        && path.normalize(header.cwd) === header.cwd
        ? header.cwd
        : undefined,
      createdAt: finiteTimestamp(header.timestamp),
      updatedAt: finiteTimestamp(finalMetadata.mtimeMs),
    };
  } finally {
    await openedFile.handle.close();
  }
};

const validRegistryEntry = (entry, parentSessionId) => (
  isRecord(entry)
  && entry.type === 'rlm_subagent'
  && typeof entry.childId === 'string'
  && RLM_CHILD_ID.test(entry.childId)
  && typeof entry.sessionName === 'string'
  && typeof entry.sessionDir === 'string'
  && typeof entry.sessionFile === 'string'
  && entry.parentSessionId === parentSessionId
  && (entry.status === 'running' || entry.status === 'completed' || entry.status === 'deleted')
  && Number.isFinite(entry.createdAt)
  && typeof entry.updatedAt === 'string'
);

const readRegistry = async ({ registryPath, artifactRoot, parentSessionId, workBudget, issues, markIncomplete }) => {
  let openedFile;
  try {
    openedFile = await openContainedRegularFile(registryPath, artifactRoot);
  } catch (error) {
    if (error?.code === 'file_missing') return [];
    issues.add('prime_registry_unavailable', parentSessionId);
    markIncomplete();
    return [];
  }
  try {
    if (openedFile.metadata.size > REGISTRY_MAX_BYTES || workBudget.remaining < openedFile.metadata.size) {
      issues.add('prime_registry_truncated', parentSessionId);
      markIncomplete();
      return [];
    }
    workBudget.remaining -= openedFile.metadata.size;
    const buffer = await readBoundedFile(openedFile, REGISTRY_MAX_BYTES);
    const finalMetadata = await openedFile.handle.stat();
    if (finalMetadata.size !== openedFile.metadata.size || finalMetadata.mtimeMs !== openedFile.metadata.mtimeMs) {
      issues.add('prime_registry_changed', parentSessionId);
      markIncomplete();
      return [];
    }
    const latest = new Map();
    for (const rawLine of buffer.toString('utf8').split(/\r?\n/)) {
      if (!rawLine) continue;
      if (Buffer.byteLength(rawLine) > REGISTRY_LINE_MAX_BYTES) {
        issues.add('prime_registry_entry_invalid', parentSessionId);
        markIncomplete();
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(rawLine);
      } catch {
        issues.add('prime_registry_entry_invalid', parentSessionId);
        markIncomplete();
        continue;
      }
      if (!validRegistryEntry(entry, parentSessionId)) {
        issues.add('prime_registry_entry_invalid', parentSessionId);
        markIncomplete();
        continue;
      }
      latest.set(entry.childId, entry);
    }
    return [...latest.values()].filter((entry) => entry.status !== 'deleted');
  } finally {
    await openedFile.handle.close();
  }
};

const getProcessStartId = async (pid, deadline) => {
  if (process.platform !== 'win32') {
    try {
      const procStat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = procStat.lastIndexOf(')');
      const startTime = procStat.slice(commandEnd + 2).split(' ')[19];
      if (startTime) return `proc:${startTime}`;
    } catch {
      // Fall through to the portable process query.
    }
    try {
      const timeout = Math.min(300, Math.max(1, deadline - Date.now()));
      if (timeout <= 1) return undefined;
      const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout,
        maxBuffer: 8 * 1024,
      });
      const startTime = String(result.stdout || '').trim();
      return startTime ? `ps:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const isLiveWorker = async (descriptor, deadline) => {
  try {
    process.kill(descriptor.pid, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') return false;
  }
  if (!descriptor.processStartId) return true;
  const currentStartId = await getProcessStartId(descriptor.pid, deadline);
  return currentStartId === undefined || currentStartId === descriptor.processStartId;
};

const readResidency = async ({ agentRoot, entities, issues, markIncomplete }) => {
  const deadline = Date.now() + RESIDENCY_DEADLINE_MS;
  let remainingBytes = RESIDENCY_WORK_MAX_BYTES;
  let agentRootReal;
  try {
    agentRootReal = await resolveRequiredDirectory(agentRoot, 'prime_agent_root_unavailable');
  } catch {
    return;
  }
  const workersRoot = await resolveOptionalContainedDirectory(path.join(agentRootReal, 'daemon-workers'), agentRootReal)
    .catch(() => null);
  if (!workersRoot) return;
  const workersDirectory = await openBoundedDirectory(workersRoot, workersRoot).catch(() => null);
  if (!workersDirectory) return;
  let directoryCount = 0;
  let descriptorCount = 0;
  try {
    for await (const directoryEntry of workersDirectory) {
      if (++directoryCount > WORKER_DIRECTORY_LIMIT || Date.now() >= deadline) {
        issues.add('prime_residency_scan_truncated');
        markIncomplete();
        break;
      }
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) continue;
      const descriptorDirectory = await resolveOptionalContainedDirectory(
        path.join(workersRoot, directoryEntry.name),
        workersRoot,
      ).catch(() => null);
      if (!descriptorDirectory) continue;
      const entries = await openBoundedDirectory(descriptorDirectory, workersRoot).catch(() => null);
      if (!entries) continue;
      try {
        for await (const entry of entries) {
          if (!entry.name.endsWith('.json') || entry.name === 'supervisor-config') continue;
          if (++descriptorCount > WORKER_DESCRIPTOR_LIMIT || Date.now() >= deadline) {
            issues.add('prime_residency_scan_truncated');
            markIncomplete();
            return;
          }
          const workerId = entry.name.slice(0, -5);
          let descriptorFile;
          try {
            descriptorFile = await openContainedRegularFile(path.join(descriptorDirectory, entry.name), workersRoot);
            if (descriptorFile.metadata.size > WORKER_DESCRIPTOR_MAX_BYTES
              || descriptorFile.metadata.size > remainingBytes) {
              issues.add('prime_residency_scan_truncated');
              markIncomplete();
              return;
            }
            remainingBytes -= descriptorFile.metadata.size;
            const descriptor = JSON.parse((await readBoundedFile(descriptorFile, WORKER_DESCRIPTOR_MAX_BYTES)).toString('utf8'));
            if (!isRecord(descriptor)
              || descriptor.version !== 1
              || descriptor.workerId !== workerId
              || descriptor.lifecycle !== 'ready'
              || !Number.isSafeInteger(descriptor.pid)
              || descriptor.pid <= 0
              || (descriptor.processStartId !== undefined && typeof descriptor.processStartId !== 'string')) {
              continue;
            }
            const workerIsLive = await isLiveWorker(descriptor, deadline);
            if (Date.now() >= deadline) {
              issues.add('prime_residency_scan_truncated');
              markIncomplete();
              return;
            }
            if (!workerIsLive) continue;
            let journalFile;
            try {
              journalFile = await openContainedRegularFile(
                path.join(descriptorDirectory, `${workerId}.recovery.jsonl`),
                workersRoot,
              );
              if (journalFile.metadata.size > WORKER_JOURNAL_MAX_BYTES
                || journalFile.metadata.size > remainingBytes) {
                issues.add('prime_residency_scan_truncated');
                markIncomplete();
                return;
              }
              remainingBytes -= journalFile.metadata.size;
              const journal = (await readBoundedFile(journalFile, WORKER_JOURNAL_MAX_BYTES)).toString('utf8');
              const latestByAlias = new Map();
              for (const line of journal.split(/\r?\n/)) {
                if (!line) continue;
                let record;
                try {
                  record = JSON.parse(line);
                } catch {
                  continue;
                }
                if (isRecord(record)
                  && record.version === 1
                  && typeof record.activeSessionId === 'string'
                  && PUBLIC_SESSION_ID.test(record.sessionId)
                  && typeof record.busy === 'boolean'
                  && typeof record.recordedAt === 'string'
                  && finiteTimestamp(record.recordedAt) !== undefined) {
                  latestByAlias.set(record.activeSessionId, record);
                }
              }
              const latestBySession = new Map();
              for (const record of latestByAlias.values()) {
                const previous = latestBySession.get(record.sessionId);
                if (!previous || Date.parse(record.recordedAt) >= Date.parse(previous.recordedAt)) {
                  latestBySession.set(record.sessionId, record);
                }
              }
              for (const [sessionId, record] of latestBySession) {
                const entity = entities.get(sessionId);
                if (!entity) continue;
                const nextResidency = record.busy ? 'working' : 'idle';
                if (entity.residency !== 'working' || nextResidency === 'working') entity.residency = nextResidency;
              }
            } catch {
              // A missing or changing journal leaves residency unknown.
            } finally {
              await journalFile?.handle.close().catch(() => undefined);
            }
          } catch {
            // A malformed or changing descriptor is isolated from other workers.
          } finally {
            await descriptorFile?.handle.close().catch(() => undefined);
          }
        }
      } finally {
        await closeDirectory(entries);
      }
    }
  } finally {
    await closeDirectory(workersDirectory);
  }
};

/**
 * Builds the authenticated web API's passive Prime catalog. Internal paths and
 * Prime runtime aliases never appear in the returned public records.
 */
export const buildPrimeCatalog = async ({ sessionsRoot, agentRoot }) => {
  const issues = issueCollector();
  let complete = true;
  const markIncomplete = () => { complete = false; };
  let sessionsRootReal;
  try {
    sessionsRootReal = await resolveRequiredDirectory(sessionsRoot, 'prime_sessions_root_unavailable');
  } catch (error) {
    return {
      response: {
        schemaVersion: 1,
        revision: hashValue(`unavailable:${error?.code || 'prime_sessions_root_unavailable'}`),
        complete: false,
        sessions: [],
        issues: [{ code: error?.code || 'prime_sessions_root_unavailable' }],
      },
      entities: new Map(),
    };
  }

  const configuredStorageParent = await resolveRequiredDirectory(
    path.dirname(sessionsRoot),
    'prime_storage_parent_unavailable',
  ).catch(() => path.dirname(sessionsRootReal));
  const artifactRootConfigured = path.join(path.dirname(sessionsRoot), 'session-artifacts');
  let artifactRoot;
  try {
    artifactRoot = await resolveOptionalContainedDirectory(
      artifactRootConfigured,
      configuredStorageParent,
    );
  } catch {
    artifactRoot = null;
    issues.add('prime_artifact_root_unavailable');
    markIncomplete();
  }
  const workBudget = { remaining: CATALOG_WORK_MAX_BYTES };
  const entities = new Map();
  let sessionDirectory;
  try {
    sessionDirectory = await openBoundedDirectory(sessionsRootReal, sessionsRootReal);
  } catch {
    return {
      response: {
        schemaVersion: 1,
        revision: hashValue('unavailable:prime_sessions_root_unavailable'),
        complete: false,
        sessions: [],
        issues: [{ code: 'prime_sessions_root_unavailable' }],
      },
      entities,
    };
  }
  let rootEntries = 0;
  let rootSessions = 0;
  try {
    for await (const directoryEntry of sessionDirectory) {
      if (++rootEntries > ROOT_DIRECTORY_ENTRY_LIMIT || rootSessions >= ROOT_SESSION_LIMIT) {
        issues.add('prime_catalog_file_limit');
        markIncomplete();
        break;
      }
      if (!directoryEntry.name.endsWith('.jsonl')) continue;
      rootSessions += 1;
      const filePath = path.join(sessionsRootReal, directoryEntry.name);
      try {
        const scanned = await validateSessionFile({
          filePath,
          containmentRoot: sessionsRootReal,
          workBudget,
        });
        if (entities.has(scanned.sessionId)) {
          issues.add('prime_session_duplicate', scanned.sessionId);
          markIncomplete();
          continue;
        }
        const entity = {
          ...scanned,
          parentSessionId: null,
          rootSessionId: scanned.sessionId,
          residency: 'inactive',
          availability: 'ready',
        };
        entities.set(scanned.sessionId, entity);
        if (scanned.metadataPartial || scanned.titleTruncated) {
          issues.add('prime_session_metadata_truncated', scanned.sessionId);
          markIncomplete();
        }
      } catch {
        issues.add('prime_session_invalid');
        markIncomplete();
      }
    }
  } catch {
    issues.add('prime_sessions_root_scan_partial');
    markIncomplete();
  } finally {
    await closeDirectory(sessionDirectory);
  }

  let nodeCount = 0;
  const visitedFiles = new Set([...entities.values()].map((entity) => entity.filePath));
  const visit = async (parent, parentArtifactDirectory, depth) => {
    if (!artifactRoot || depth > RLM_DEPTH_LIMIT) {
      if (depth > RLM_DEPTH_LIMIT) {
        issues.add('prime_rlm_depth_limit', parent.sessionId);
        markIncomplete();
      }
      return;
    }
    const safeParentArtifactDirectory = await resolveOptionalContainedDirectory(
      parentArtifactDirectory,
      artifactRoot,
    ).catch(() => null);
    if (!safeParentArtifactDirectory) return;
    const entries = await readRegistry({
      registryPath: path.join(safeParentArtifactDirectory, 'rlm-subagents.jsonl'),
      artifactRoot,
      parentSessionId: parent.sessionId,
      workBudget,
      issues,
      markIncomplete,
    });
    for (const entry of entries) {
      if (++nodeCount > RLM_NODE_LIMIT) {
        issues.add('prime_rlm_node_limit', parent.sessionId);
        markIncomplete();
        return;
      }
      if (!path.isAbsolute(entry.sessionDir)
        || !path.isAbsolute(entry.sessionFile)
        || path.basename(path.normalize(entry.sessionDir)) !== entry.childId
        || path.dirname(path.normalize(entry.sessionFile)) !== path.normalize(entry.sessionDir)
        || !path.basename(entry.sessionFile).endsWith('.jsonl')) {
        issues.add('prime_registry_entry_invalid', parent.sessionId);
        markIncomplete();
        continue;
      }
      try {
        const safeChildDirectory = await resolveOptionalContainedDirectory(entry.sessionDir, artifactRoot);
        if (!safeChildDirectory || path.basename(safeChildDirectory) !== entry.childId) {
          throw new PrimeFileAccessError('invalid_session_ancestry');
        }
        const rawSessionFile = path.join(safeChildDirectory, path.basename(entry.sessionFile));
        const scanned = await validateSessionFile({
          filePath: rawSessionFile,
          containmentRoot: artifactRoot,
          expectedParent: parent,
          registryTitle: entry.sessionName.trim() || undefined,
          workBudget,
        });
        if (path.dirname(scanned.filePath) !== safeChildDirectory) {
          throw new PrimeFileAccessError('invalid_session_ancestry');
        }
        if (visitedFiles.has(scanned.filePath) || entities.has(scanned.sessionId)) {
          issues.add('prime_session_duplicate', scanned.sessionId);
          markIncomplete();
          continue;
        }
        visitedFiles.add(scanned.filePath);
        const entity = {
          ...scanned,
          parentSessionId: parent.sessionId,
          rootSessionId: parent.rootSessionId,
          residency: 'inactive',
          availability: 'ready',
          sessionDirectory: safeChildDirectory,
        };
        entities.set(scanned.sessionId, entity);
        if (scanned.metadataPartial || scanned.titleTruncated) {
          issues.add('prime_session_metadata_truncated', scanned.sessionId);
          markIncomplete();
        }
        await visit(
          entity,
          path.join(path.dirname(safeChildDirectory), 'session-artifacts', scanned.sessionId),
          depth + 1,
        );
      } catch {
        issues.add('prime_rlm_session_unavailable', parent.sessionId);
        markIncomplete();
      }
    }
  };

  if (artifactRoot) {
    for (const rootEntity of [...entities.values()]) {
      if (rootEntity.parentSessionId !== null) continue;
      await visit(rootEntity, path.join(artifactRoot, rootEntity.sessionId), 1);
    }
  }

  if (workBudget.remaining <= 0) {
    issues.add('prime_catalog_work_limit');
    markIncomplete();
  }
  await readResidency({ agentRoot, entities, issues, markIncomplete });

  const sessions = [...entities.values()]
    .map((entity) => ({
      sessionId: entity.sessionId,
      title: entity.title,
      parentSessionId: entity.parentSessionId,
      rootSessionId: entity.rootSessionId,
      ...(entity.workingDirectory ? { workingDirectory: entity.workingDirectory } : {}),
      ...(entity.createdAt !== undefined ? { createdAt: entity.createdAt } : {}),
      ...(entity.updatedAt !== undefined ? { updatedAt: entity.updatedAt } : {}),
      residency: entity.residency,
      availability: entity.availability,
    }))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0) || left.sessionId.localeCompare(right.sessionId));
  const revision = hashValue(JSON.stringify({
    complete,
    sessions: sessions.map((session) => ({ ...session, fileRevision: entities.get(session.sessionId).fileRevision })),
    issues: issues.list,
  }));
  return {
    response: { schemaVersion: 1, revision, complete, sessions, issues: issues.list },
    entities,
  };
};
