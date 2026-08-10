export type TranscriptRole = 'user' | 'assistant' | 'system' | string;

export interface TranscriptPartTime {
  start?: number;
  end?: number;
}

export interface TranscriptShellAction {
  command?: string;
  output?: string;
  status?: string;
}

interface TranscriptPartBase {
  id: string;
  synthetic?: boolean;
  time?: TranscriptPartTime;
}

export interface TranscriptTextPart extends TranscriptPartBase {
  kind: 'text';
  text: string;
  shellAction?: TranscriptShellAction;
}

export interface TranscriptReasoningPart extends TranscriptPartBase {
  kind: 'reasoning';
  text: string;
}

export interface TranscriptFilePart extends TranscriptPartBase {
  kind: 'file';
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  source?: Record<string, unknown>;
}

export interface TranscriptAgentPart extends TranscriptPartBase {
  kind: 'agent';
  name: string;
  source?: { value?: string };
}

export interface TranscriptSubtaskPart extends TranscriptPartBase {
  kind: 'subtask';
  description?: string;
  command?: string;
  agent?: string;
  prompt?: string;
  taskSessionId?: string;
  model?: string;
}

export interface TranscriptToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: TranscriptPartTime;
  attachments?: TranscriptFilePart[];
}

export interface TranscriptToolPart extends TranscriptPartBase {
  kind: 'tool';
  tool: string;
  callId?: string;
  state: TranscriptToolState;
  metadata?: Record<string, unknown>;
  output?: string;
}

export type TranscriptPart =
  | TranscriptTextPart
  | TranscriptReasoningPart
  | TranscriptFilePart
  | TranscriptAgentPart
  | TranscriptSubtaskPart
  | TranscriptToolPart;

export interface TranscriptMessageContext {
  agentName?: string;
  providerId?: string;
  modelId?: string;
  modelName?: string;
  variant?: string;
}

export interface TranscriptMessageError {
  text: string;
  variant: 'error' | 'info';
}

export interface TranscriptDiffStats {
  additions: number;
  deletions: number;
  files: number;
}

export interface TranscriptChangedFile {
  file: string;
  additions: number;
  deletions: number;
}

export interface TranscriptMessage {
  id: string;
  sessionId: string;
  role: TranscriptRole;
  parentId?: string;
  createdAt?: number;
  completedAt?: number;
  finish?: string;
  status?: string;
  mode?: string;
  agent?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
  modelVariant?: string;
  animationSettled?: boolean;
  synthetic?: boolean;
  userMessageMarker?: boolean;
  isCompactionSummary?: boolean;
  summaryBody?: string;
  diffStats?: TranscriptDiffStats;
  changedFiles?: TranscriptChangedFile[];
  context?: TranscriptMessageContext;
  error?: TranscriptMessageError;
  promptPreview?: string;
  hidden?: boolean;
  toolResult?: {
    name?: string;
    error: boolean;
    output: string;
    metadata?: Record<string, unknown>;
  };
  parts: TranscriptPart[];
}

export interface TranscriptMessageActions {
  revert?: (messageId: string) => void;
  fork?: (messageId: string) => void;
  isContextPinned?: (messageId: string) => boolean;
  setContextPinned?: (
    messageId: string,
    createdAt: number,
    role: 'user' | 'assistant',
    pinned: boolean,
  ) => Promise<void>;
}

export interface TranscriptSnapshot {
  key: string;
  messages: TranscriptMessage[];
  activeMessage: TranscriptMessage | null;
  activeStreamPhase: 'idle' | 'streaming' | 'settling';
  isWorking: boolean;
}

export type TranscriptActions = TranscriptMessageActions;
