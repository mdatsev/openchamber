import type { OpenCodeMessageRecord } from '../../transcript/openCodeTypes';
import type { TranscriptChangedFile, TranscriptMessage, TranscriptPart } from '../../transcript/types';

/** @deprecated OpenCode-shaped compatibility input for existing turn helpers. */
export type ChatMessageEntry = OpenCodeMessageRecord;
export type TranscriptMessageEntry = TranscriptMessage;

type TurnActivityKind = 'tool' | 'reasoning' | 'justification';

export interface TurnMessageRecord<TMessage = ChatMessageEntry> {
    messageId: string;
    role: string;
    parentMessageId?: string;
    message: TMessage;
    order: number;
}

export interface TurnPartRecord {
    id: string;
    turnId: string;
    messageId: string;
    part: TranscriptPart;
    partIndex: number;
    endedAt?: number;
}

export interface TurnActivityRecord extends TurnPartRecord { kind: TurnActivityKind; }
export interface TurnDiffStats { additions: number; deletions: number; files: number; }
export type TurnChangedFile = TranscriptChangedFile;
export interface TurnActivityGroup {
    id: string;
    anchorMessageId: string;
    afterToolPartId: string | null;
    parts: TurnActivityRecord[];
}
export interface TurnSummaryRecord { text?: string; sourceMessageId?: string; sourcePartId?: string; }
export interface TurnStreamState {
    isStreaming: boolean;
    isRetrying: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

export interface TurnRecord<TMessage = ChatMessageEntry> {
    turnId: string;
    userMessageId: string;
    userMessage: TMessage;
    headerMessageId?: string;
    messages: TurnMessageRecord<TMessage>[];
    assistantMessageIds: string[];
    assistantMessages: TMessage[];
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    summary: TurnSummaryRecord;
    summaryText?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    changedFiles?: TurnChangedFile[];
    stream: TurnStreamState;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

interface TurnMessageMeta {
    turnId: string;
    messageId: string;
    userMessageId: string;
    isUserMessage: boolean;
    isAssistantMessage: boolean;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    headerMessageId?: string;
}

export interface TurnIndexes<TMessage = ChatMessageEntry> {
    turnById: Map<string, TurnRecord<TMessage>>;
    messageToTurnId: Map<string, string>;
    messageMetaById: Map<string, TurnMessageMeta>;
}

export interface TurnProjectionResult<TMessage = ChatMessageEntry> {
    turns: TurnRecord<TMessage>[];
    indexes: TurnIndexes<TMessage>;
    lastTurnId: string | null;
    lastTurnMessageIds: Set<string>;
    ungroupedMessageIds: Set<string>;
}

export type Turn<TMessage = ChatMessageEntry> = Pick<TurnRecord<TMessage>, 'turnId' | 'userMessage' | 'assistantMessages'>;

export type TranscriptTurnMessageRecord = TurnMessageRecord<TranscriptMessageEntry>;
export type TranscriptTurnRecord = TurnRecord<TranscriptMessageEntry>;
export type TranscriptTurnIndexes = TurnIndexes<TranscriptMessageEntry>;
export type TranscriptTurnProjectionResult = TurnProjectionResult<TranscriptMessageEntry>;
export type TranscriptTurn = Turn<TranscriptMessageEntry>;

export interface TurnGroupingContext {
    turnId: string;
    activityOwnerMessageId?: string;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    isLatestTurn: boolean;
    summaryBody?: string;
    activityParts?: TurnActivityRecord[];
    activityGroupSegments?: TurnActivityGroup[];
    headerMessageId?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    changedFiles?: TurnChangedFile[];
    userMessageCreatedAt?: number;
    userMessageVariant?: string;
    isWorking: boolean;
    isGroupExpanded?: boolean;
    toggleGroup?: () => void;
}
