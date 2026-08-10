import type { ChatMessageEntry, TranscriptMessageEntry, TranscriptTurnProjectionResult } from './types';
import { adaptOpenCodeTurnMessages } from '../../transcript/openCodeTurnCompatibility';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const TURN_PROJECTION_CACHE_MAX = 30;
const VSCODE_TURN_PROJECTION_CACHE_MAX = 4;
const MOBILE_TURN_PROJECTION_CACHE_MAX = 4;

const projectionCache = new Map<string, TranscriptTurnProjectionResult>();
const objectVersionByRef = new WeakMap<object, number>();
let nextObjectVersion = 1;

const getProjectionCacheMax = () => {
  if (isVSCodeRuntime()) return VSCODE_TURN_PROJECTION_CACHE_MAX;
  if (isMobileSurfaceRuntime()) return MOBILE_TURN_PROJECTION_CACHE_MAX;
  return TURN_PROJECTION_CACHE_MAX;
};

const getObjectVersion = (value: object): number => {
  const cached = objectVersionByRef.get(value);
  if (cached !== undefined) return cached;
  const next = nextObjectVersion;
  nextObjectVersion += 1;
  objectVersionByRef.set(value, next);
  return next;
};

const buildMessagesVersionSignature = (messages: TranscriptMessageEntry[]): string => {
  return messages.map((message) => {
    const messageVersion = getObjectVersion(message);
    const partsVersion = getObjectVersion(message.parts);
    const partVersions = message.parts.map((part) => getObjectVersion(part as object)).join(',');
    return `${messageVersion}:${partsVersion}:${partVersions}`;
  }).join(';');
};

const buildTranscriptProjectionCacheKey = (
  sessionKey: string,
  messages: TranscriptMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string => {
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastMessageId = lastMessage?.id ?? '';
  const lastMessagePartCount = lastMessage?.parts?.length ?? 0;
  return [
    sessionKey,
    messages.length,
    lastMessageId,
    lastMessagePartCount,
    buildMessagesVersionSignature(messages),
    showTextJustificationActivity ? '1' : '0',
    showTurnChangedFiles ? '1' : '0',
    mergeHiddenUserTurnsKey,
  ].join('|');
};

export const getCachedProjection = (key: string): TranscriptTurnProjectionResult | undefined => {
  const cached = projectionCache.get(key);
  if (cached) {
    // LRU re-order: move hit to the end (most recent) so it survives
    // eviction longer than entries that haven't been read recently.
    projectionCache.delete(key);
    projectionCache.set(key, cached);
  }
  return cached;
};

export const setCachedProjection = (
  key: string,
  projection: TranscriptTurnProjectionResult,
): void => {
  projectionCache.delete(key);
  const max = getProjectionCacheMax();
  while (projectionCache.size >= max) {
    const oldest = projectionCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    projectionCache.delete(oldest);
  }
  projectionCache.set(key, projection);
};


export function buildProjectionCacheKey(
  sessionKey: string,
  messages: TranscriptMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string;
/** @deprecated Pass TranscriptMessage values instead. */
export function buildProjectionCacheKey(
  sessionKey: string,
  messages: ChatMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string;
export function buildProjectionCacheKey(
  sessionKey: string,
  messages: TranscriptMessageEntry[] | ChatMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string {
  const first = messages[0];
  const transcriptMessages = first && 'info' in first
    ? adaptOpenCodeTurnMessages(messages as ChatMessageEntry[])
    : messages as TranscriptMessageEntry[];
  return buildTranscriptProjectionCacheKey(sessionKey, transcriptMessages, showTextJustificationActivity, showTurnChangedFiles, mergeHiddenUserTurnsKey);
}
