import type { Message, Part } from '@opencode-ai/sdk/v2';

import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import type { OpenCodeMessageRecord } from './openCodeTypes';
import type {
  TranscriptAgentPart,
  TranscriptChangedFile,
  TranscriptFilePart,
  TranscriptMessage,
  TranscriptMessageError,
  TranscriptPart,
  TranscriptSubtaskPart,
  TranscriptToolPart,
} from './types';

const PREVIEW_MAX_CHARS = 160;
const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';
const USER_SHELL_MARKER = 'The following tool was executed by the user';

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim().length > 0 ? value : undefined
);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

const readText = (part: unknown): string => {
  const raw = asRecord(part);
  const candidates = [raw.text, raw.content, raw.value]
    .filter((value): value is string => typeof value === 'string');
  return candidates.reduce((longest, value) => value.length > longest.length ? value : longest, '');
};

const adaptFilePart = (part: unknown, id: string): TranscriptFilePart => {
  const raw = asRecord(part);
  return {
    kind: 'file',
    id,
    mime: readString(raw.mime),
    url: readString(raw.url),
    filename: readString(raw.filename),
    size: typeof raw.size === 'number' ? raw.size : undefined,
    source: raw.source && typeof raw.source === 'object' ? raw.source as Record<string, unknown> : undefined,
  };
};

const adaptToolPart = (part: unknown, id: string): TranscriptToolPart => {
  const raw = asRecord(part);
  const rawState = asRecord(raw.state);
  const rawTime = asRecord(rawState.time);
  const attachments = Array.isArray(rawState.attachments)
    ? rawState.attachments.map((attachment, index) => {
      const attachmentRecord = asRecord(attachment);
      return adaptFilePart(attachment, readString(attachmentRecord.id) ?? `${id}-attachment-${index}`);
    })
    : undefined;
  return {
    kind: 'tool',
    id,
    tool: readString(raw.tool) ?? '',
    callId: readString(raw.callID),
    state: {
      status: readString(rawState.status) ?? 'pending',
      input: rawState.input && typeof rawState.input === 'object' ? rawState.input as Record<string, unknown> : undefined,
      output: typeof rawState.output === 'string' ? rawState.output : undefined,
      error: typeof rawState.error === 'string' ? rawState.error : undefined,
      metadata: rawState.metadata && typeof rawState.metadata === 'object' ? rawState.metadata as Record<string, unknown> : undefined,
      time: Object.keys(rawTime).length > 0 ? {
        start: typeof rawTime.start === 'number' ? rawTime.start : undefined,
        end: typeof rawTime.end === 'number' ? rawTime.end : undefined,
      } : undefined,
      attachments,
    },
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : undefined,
    output: typeof raw.output === 'string' ? raw.output : undefined,
  };
};

export const adaptOpenCodePart = (part: Part, messageId: string, index: number): TranscriptPart | null => {
  const raw = asRecord(part);
  const type = readString(raw.type);
  const id = readString(raw.id) ?? `${messageId}-part-${index}-${type ?? 'unknown'}`;
  const rawTime = asRecord(raw.time);
  const time = Object.keys(rawTime).length > 0 ? {
    start: typeof rawTime.start === 'number' ? rawTime.start : undefined,
    end: typeof rawTime.end === 'number' ? rawTime.end : undefined,
  } : undefined;
  if (type === 'compaction') return { kind: 'text', id, text: '/compact' };
  if (type === 'text') return { kind: 'text', id, text: readText(part), synthetic: raw.synthetic === true, time };
  if (type === 'reasoning') return { kind: 'reasoning', id, text: readText(part), synthetic: raw.synthetic === true, time };
  if (type === 'tool') return adaptToolPart(part, id);
  if (type === 'file') return adaptFilePart(part, id);
  if (type === 'agent') {
    const source = asRecord(raw.source);
    return { kind: 'agent', id, name: readString(raw.name) ?? '', source: { value: readString(source.value) } } satisfies TranscriptAgentPart;
  }
  if (type === 'subtask') {
    const model = asRecord(raw.model);
    const providerId = readString(model.providerID);
    const modelId = readString(model.modelID);
    return {
      kind: 'subtask', id, description: readString(raw.description), command: readString(raw.command),
      agent: readString(raw.agent), prompt: readString(raw.prompt), taskSessionId: readString(raw.taskSessionID),
      model: providerId && modelId ? `${providerId}/${modelId}` : undefined,
    } satisfies TranscriptSubtaskPart;
  }
  return null;
};

const resolveRole = (info: Message): string => {
  const raw = asRecord(info);
  if (raw.userMessageMarker === true || raw.clientRole === 'user' || raw.role === 'user' || raw.origin === 'user' || raw.source === 'user') return 'user';
  return readString(raw.clientRole) ?? readString(raw.role) ?? 'assistant';
};

export const deriveOpenCodeMessageRole = (info: Message): { role: string; isUser: boolean } => {
  const role = resolveRole(info);
  return { role, isUser: role === 'user' };
};

const resolveAssistantError = (info: Message): TranscriptMessageError | undefined => {
  const error = asRecord(asRecord(info).error);
  if (Object.keys(error).length === 0) return undefined;
  const detail = readString(asRecord(error.data).message) ?? readString(error.message) ?? readString(error.name);
  if (!detail) return undefined;
  const name = readString(error.name);
  if (name === 'SessionRetry') return { text: `Opencode failed to send a message. Retry attempt info: \n\`${detail}\``, variant: 'info' };
  if (isLikelyProviderAuthFailure(detail)) return { text: PROVIDER_AUTH_FAILURE_MESSAGE, variant: 'error' };
  if (detail.trim().toLowerCase() === 'aborted') return { text: 'The running turn was stopped before OpenCode could send the next message.', variant: 'info' };
  return { text: `Opencode failed to send message with error:\n\`${detail}\``, variant: 'error' };
};

const readSummaryDiffs = (info: Message): TranscriptChangedFile[] | undefined => {
  const diffs = asRecord(asRecord(info).summary).diffs;
  if (!Array.isArray(diffs)) return undefined;
  const files = diffs.flatMap((value) => {
    const diff = asRecord(value);
    const file = readString(diff.file);
    const additions = typeof diff.additions === 'number' ? diff.additions : 0;
    const deletions = typeof diff.deletions === 'number' ? diff.deletions : 0;
    return file && (additions || deletions) ? [{ file, additions, deletions }] : [];
  });
  return files.length > 0 ? files : undefined;
};

const parseGitHubAttachment = (text: string, id: string): TranscriptFilePart | null => {
  const trimmed = text.trimStart();
  const isIssue = trimmed.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX);
  const isPr = trimmed.startsWith(GITHUB_PR_CONTEXT_PREFIX);
  if (!isIssue && !isPr) return null;
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const payload = asRecord(JSON.parse(trimmed.slice(jsonStart)));
    const subject = asRecord(isIssue ? payload.issue : payload.pr);
    const number = subject.number;
    const title = readString(subject.title);
    const url = readString(subject.url);
    if (typeof number !== 'number' || number <= 0 || !title || !url) return null;
    return {
      kind: 'file', id, mime: isIssue ? 'application/vnd.github.issue-link' : 'application/vnd.github.pull-request-link',
      filename: `${isIssue ? 'Issue' : 'PR'} #${number}: ${title}`, url,
    };
  } catch { return null; }
};

const shouldKeepSyntheticUserText = (text: string, planModeEnabled: boolean): boolean => {
  const trimmed = text.trim();
  return (planModeEnabled && (trimmed.startsWith('User has requested to enter plan mode') || trimmed.startsWith('The plan at ')))
    || trimmed.startsWith(USER_SHELL_MARKER)
    || trimmed.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX)
    || trimmed.startsWith(GITHUB_PR_CONTEXT_PREFIX);
};

const adaptParts = (message: OpenCodeMessageRecord, role: string, planModeEnabled: boolean): TranscriptPart[] => {
  const validParts = message.parts.filter((part) => readString(asRecord(part).type));
  const hasNonSynthetic = validParts.some((part) => asRecord(part).synthetic !== true);
  return validParts.flatMap((part, index) => {
    const raw = asRecord(part);
    const type = readString(raw.type);
    const synthetic = raw.synthetic === true;
    const text = readText(part);
    if (role === 'user' && synthetic) {
      const githubAttachment = type === 'text' ? parseGitHubAttachment(text, readString(raw.id) ?? `${message.info.id}-part-${index}`) : null;
      if (githubAttachment) return [githubAttachment];
      if (hasNonSynthetic || type !== 'text' || !shouldKeepSyntheticUserText(text, planModeEnabled)) return [];
    }
    const adapted = adaptOpenCodePart(part, message.info.id, index);
    if (!adapted) return [];
    if (role === 'user' && adapted.kind === 'text' && adapted.text.trim().startsWith(USER_SHELL_MARKER)) {
      return [{ ...adapted, text: '/shell', synthetic: false }];
    }
    return [adapted];
  });
};

const buildPreview = (parts: TranscriptPart[]): string | undefined => {
  const preview = parts.flatMap((part) => part.kind === 'text' ? [part.text.trim()] : part.kind === 'file' && part.filename ? [part.filename] : []).filter(Boolean).join(' ');
  return preview ? preview.slice(0, PREVIEW_MAX_CHARS) : undefined;
};

export const adaptOpenCodeMessage = (
  message: OpenCodeMessageRecord,
  options: { planModeEnabled: boolean; roleOverride?: string } = { planModeEnabled: false },
): TranscriptMessage => {
  const info = asRecord(message.info);
  const role = options.roleOverride ?? resolveRole(message.info);
  const parts = adaptParts(message, role, options.planModeEnabled);
  const time = asRecord(info.time);
  const model = asRecord(info.model);
  const summary = asRecord(info.summary);
  const changedFiles = readSummaryDiffs(message.info);
  const additions = changedFiles?.reduce((total, file) => total + file.additions, 0) ?? 0;
  const deletions = changedFiles?.reduce((total, file) => total + file.deletions, 0) ?? 0;
  return {
    id: message.info.id, sessionId: readString(info.sessionID) ?? '', role, parentId: readString(info.parentID),
    createdAt: typeof time.created === 'number' ? time.created : undefined,
    completedAt: typeof time.completed === 'number' ? time.completed : undefined,
    finish: readString(info.finish), status: readString(info.status), mode: readString(info.mode), agent: readString(info.agent),
    providerId: readString(info.providerID), modelId: readString(info.modelID), variant: readString(info.variant),
    modelVariant: readString(model.variant), animationSettled: info.animationSettled === true, userMessageMarker: info.userMessageMarker === true,
    isCompactionSummary: info.summary === true, summaryBody: readString(summary.body),
    diffStats: changedFiles ? { additions, deletions, files: changedFiles.length } : undefined, changedFiles,
    error: role === 'assistant' ? resolveAssistantError(message.info) : undefined,
    promptPreview: role === 'user' ? buildPreview(parts) : undefined,
    hidden: parts.length > 0 && parts.every((part) => 'synthetic' in part && part.synthetic === true),
    parts,
  };
};

interface ShellBridgeDetails {
  command?: string;
  output?: string;
  status?: string;
}

const isUserShellMarkerMessage = (message: OpenCodeMessageRecord): boolean => (
  resolveRole(message.info) === 'user' && message.parts.some((part) => {
    const raw = asRecord(part);
    return raw.type === 'text' && raw.synthetic === true && readText(part).trim().startsWith(USER_SHELL_MARKER);
  })
);

const getShellBridgeAssistantDetails = (
  message: OpenCodeMessageRecord,
  expectedParentId: string,
): { hide: boolean; details: ShellBridgeDetails | null } => {
  if (resolveRole(message.info) !== 'assistant' || readString(asRecord(message.info).parentID) !== expectedParentId || message.parts.length !== 1) {
    return { hide: false, details: null };
  }
  const raw = asRecord(message.parts[0]);
  if (raw.type !== 'tool' || readString(raw.tool)?.toLowerCase() !== 'bash') return { hide: false, details: null };
  const state = asRecord(raw.state);
  const metadata = asRecord(state.metadata);
  return {
    hide: true,
    details: {
      command: readString(asRecord(state.input).command),
      output: typeof state.output === 'string' ? state.output : typeof metadata.output === 'string' ? metadata.output : undefined,
      status: readString(state.status),
    },
  };
};

const readTaskSessionId = (part: Part): string | null => {
  const state = asRecord(asRecord(part).state);
  const metadata = asRecord(state.metadata);
  const fromMetadata = readString(metadata.sessionID) ?? readString(metadata.sessionId);
  if (fromMetadata) return fromMetadata;
  return typeof state.output === 'string' ? state.output.match(/task_id\s*:\s*([^\s<"']+)/i)?.[1] ?? null : null;
};

const subtaskBridge = (message: OpenCodeMessageRecord): { hide: boolean; taskSessionId: string | null } => {
  if (resolveRole(message.info) !== 'assistant' || message.parts.length !== 1) return { hide: false, taskSessionId: null };
  const part = message.parts[0];
  const raw = asRecord(part);
  if (raw.type !== 'tool' || readString(raw.tool)?.toLowerCase() !== 'task') return { hide: false, taskSessionId: null };
  return { hide: true, taskSessionId: readTaskSessionId(part) };
};

const attachTaskSession = (message: TranscriptMessage, taskSessionId: string | null): TranscriptMessage => taskSessionId ? {
  ...message,
  parts: message.parts.map((part) => part.kind === 'subtask' && !part.taskSessionId ? { ...part, taskSessionId } : part),
} : message;

const attachShellAction = (message: TranscriptMessage, details: ShellBridgeDetails | null): TranscriptMessage => ({
  ...message,
  parts: message.parts.map((part) => part.kind === 'text' && part.text === '/shell' ? {
    ...part,
    shellAction: { command: readString(details?.command), output: typeof details?.output === 'string' ? details.output : undefined, status: readString(details?.status) },
  } : part),
});

export const adaptOpenCodeMessages = (
  messages: OpenCodeMessageRecord[],
  options: { planModeEnabled: boolean },
): TranscriptMessage[] => {
  const latestById = new Map(messages.map((message) => [message.info.id, message]));
  const seen = new Set<string>();
  const deduped = messages.flatMap((message) => {
    if (seen.has(message.info.id)) return [];
    seen.add(message.info.id);
    return [latestById.get(message.info.id) ?? message];
  });
  const compactionCommandIds = new Set<string>();
  const output: Array<{ raw: OpenCodeMessageRecord; view: TranscriptMessage }> = [];
  for (const raw of deduped) {
    const rawRole = resolveRole(raw.info);
    const parentId = readString(asRecord(raw.info).parentID);
    const roleOverride = rawRole === 'system' && parentId && compactionCommandIds.has(parentId) ? 'assistant' : undefined;
    const hasCompaction = raw.parts.some((part) => asRecord(part).type === 'compaction' || (asRecord(part).type === 'text' && readText(part).trim() === '/compact'));
    if (hasCompaction) compactionCommandIds.add(raw.info.id);
    const previous = output.at(-1);
    if (previous && previous.view.role === 'user' && previous.view.parts.some((part) => part.kind === 'subtask')) {
      const bridge = subtaskBridge(raw);
      if (bridge.hide) {
        previous.view = attachTaskSession(previous.view, bridge.taskSessionId);
        continue;
      }
    }
    if (previous && isUserShellMarkerMessage(previous.raw)) {
      const bridge = getShellBridgeAssistantDetails(raw, previous.raw.info.id);
      if (bridge.hide) {
        previous.view = attachShellAction(previous.view, bridge.details);
        continue;
      }
    }
    output.push({ raw, view: adaptOpenCodeMessage(raw, { ...options, roleOverride }) });
  }
  return output.map(({ view }) => view);
};
