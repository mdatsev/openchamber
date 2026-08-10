import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HEADER_MAX_BYTES = 64 * 1024;

export class PrimeFileAccessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrimeFileAccessError';
    this.code = code;
  }
}

const expandTilde = (value, homeDirectory) => {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/')) return path.join(homeDirectory, value.slice(2));
  return value;
};

export const resolvePrimeStoragePaths = ({ env = process.env, homeDirectory = os.homedir() } = {}) => {
  const configuredAgentRoot = expandTilde(
    env.PRIME_AGENT_CODING_AGENT_DIR || path.join(homeDirectory, '.prime', 'agent'),
    homeDirectory,
  );
  const configuredSessionsRoot = expandTilde(
    env.PRIME_AGENT_SESSION_DIR
      || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR
      || path.join(configuredAgentRoot, 'sessions'),
    homeDirectory,
  );
  return {
    agentRoot: path.resolve(configuredAgentRoot),
    sessionsRoot: path.resolve(configuredSessionsRoot),
  };
};

const isContainedPath = (rootPath, candidatePath) => {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export const resolveRequiredDirectory = async (configuredPath, errorCode) => {
  try {
    await lstat(configuredPath);
    const resolvedPath = await realpath(configuredPath);
    const metadata = await stat(resolvedPath);
    if (!metadata.isDirectory()) throw new PrimeFileAccessError(errorCode);
    return resolvedPath;
  } catch (error) {
    if (error instanceof PrimeFileAccessError) throw error;
    const code = error?.code === 'ENOENT' ? 'prime_sessions_root_missing' : errorCode;
    throw new PrimeFileAccessError(code);
  }
};

export const resolveOptionalContainedDirectory = async (directoryPath, containmentRoot) => {
  try {
    const linkMetadata = await lstat(directoryPath);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isDirectory()) {
      throw new PrimeFileAccessError('unsafe_directory');
    }
    const resolvedPath = await realpath(directoryPath);
    if (!isContainedPath(containmentRoot, resolvedPath)) throw new PrimeFileAccessError('unsafe_directory');
    const resolvedMetadata = await stat(resolvedPath);
    if (!resolvedMetadata.isDirectory()) throw new PrimeFileAccessError('unsafe_directory');
    return resolvedPath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof PrimeFileAccessError) throw error;
    throw new PrimeFileAccessError('directory_unavailable');
  }
};

export const openContainedRegularFile = async (filePath, containmentRoot) => {
  let handle;
  try {
    const linkMetadata = await lstat(filePath);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
      throw new PrimeFileAccessError('unsafe_file');
    }
    const beforeRealPath = await realpath(filePath);
    if (!isContainedPath(containmentRoot, beforeRealPath)) throw new PrimeFileAccessError('unsafe_file');
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(beforeRealPath, fsConstants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()
      || openedMetadata.dev !== linkMetadata.dev
      || openedMetadata.ino !== linkMetadata.ino) {
      throw new PrimeFileAccessError('unsafe_file');
    }
    const afterRealPath = await realpath(filePath);
    if (afterRealPath !== beforeRealPath || !isContainedPath(containmentRoot, afterRealPath)) {
      throw new PrimeFileAccessError('unsafe_file');
    }
    return { handle, metadata: openedMetadata, realPath: afterRealPath };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof PrimeFileAccessError) throw error;
    throw new PrimeFileAccessError(error?.code === 'ENOENT' ? 'file_missing' : 'file_unavailable');
  }
};

export const readFileRange = async (handle, offset, length) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new PrimeFileAccessError('invalid_read_range');
  }
  const buffer = Buffer.alloc(length);
  let readOffset = 0;
  while (readOffset < length) {
    const result = await handle.read(buffer, readOffset, length - readOffset, offset + readOffset);
    if (result.bytesRead === 0) break;
    readOffset += result.bytesRead;
  }
  return readOffset === length ? buffer : buffer.subarray(0, readOffset);
};

export const readBoundedFile = async (openedFile, maxBytes) => {
  if (openedFile.metadata.size > maxBytes) throw new PrimeFileAccessError('file_too_large');
  return readFileRange(openedFile.handle, 0, openedFile.metadata.size);
};

export const readBoundedHeader = async (openedFile) => {
  const length = Math.min(openedFile.metadata.size, HEADER_MAX_BYTES + 1);
  const buffer = await readFileRange(openedFile.handle, 0, length);
  const newlineIndex = buffer.indexOf(0x0a);
  if (newlineIndex < 0 || newlineIndex > HEADER_MAX_BYTES) {
    throw new PrimeFileAccessError('invalid_session_header');
  }
  const line = buffer.subarray(0, newlineIndex).toString('utf8');
  if (!line || line.trim() !== line) throw new PrimeFileAccessError('invalid_session_header');
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    throw new PrimeFileAccessError('invalid_session_header');
  }
  return header;
};

export const openBoundedDirectory = async (directoryPath, containmentRoot) => {
  const resolvedPath = await resolveOptionalContainedDirectory(directoryPath, containmentRoot);
  if (!resolvedPath) return null;
  try {
    return await opendir(resolvedPath);
  } catch {
    throw new PrimeFileAccessError('directory_unavailable');
  }
};
