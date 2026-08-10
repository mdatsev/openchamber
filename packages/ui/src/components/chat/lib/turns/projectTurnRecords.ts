import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnChangedFiles, projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TranscriptMessageEntry,
    TranscriptTurnMessageRecord,
    TranscriptTurnProjectionResult,
    TranscriptTurnRecord,
    TurnStreamState,
} from './types';
import { adaptOpenCodeTurnMessages } from '../../transcript/openCodeTurnCompatibility';

const resolveMessageRole = (message: TranscriptMessageEntry): string => message.role;

const getMessageParentId = (message: TranscriptMessageEntry): string | undefined => message.parentId;

const getMessageCreatedAt = (message: TranscriptMessageEntry): number | undefined => message.createdAt;

const getMessageCompletedAt = (message: TranscriptMessageEntry): number | undefined => message.completedAt;

const getUserSummaryBody = (message: TranscriptMessageEntry): string | undefined => message.summaryBody;

const createTurnMessageRecord = (message: TranscriptMessageEntry, order: number): TranscriptTurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.id,
        role,
        parentMessageId: getMessageParentId(message),
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: TranscriptMessageEntry, assistantMessages: TranscriptMessageEntry[]): TurnStreamState => {
    const startedAt = getMessageCreatedAt(userMessage);
    let completedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
    });

    const durationMs = typeof startedAt === 'number' && typeof completedAt === 'number' && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TranscriptTurnProjectionResult | null;
    showTextJustificationActivity?: boolean;
    showTurnChangedFiles?: boolean;
    /**
     * When set, a turn whose user message is hidden (no visible display parts,
     * e.g. synthetic subagent-completion nudges) is merged into the previous
     * turn instead of starting a new one.
     */
    mergeHiddenUserTurns?: { planModeEnabled: boolean };
}

type ResolvedProjectTurnRecordsOptions = Omit<
    ProjectTurnRecordsOptions,
    'showTextJustificationActivity' | 'showTurnChangedFiles'
> & {
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
};

const DEFAULT_OPTIONS: ResolvedProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
    showTurnChangedFiles: false,
    mergeHiddenUserTurns: undefined,
};

const areSameMessageRefs = (left: TranscriptMessageEntry[], right: TranscriptMessageEntry[]): boolean => {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const canReusePreviousTurn = (previous: TranscriptTurnRecord, next: TranscriptTurnRecord): boolean => {
    return previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areSameMessageRefs(previous.assistantMessages, next.assistantMessages);
};

const hydrateTurnRecord = (
    turn: TranscriptTurnRecord,
    effectiveOptions: ResolvedProjectTurnRecordsOptions,
): TranscriptTurnRecord => {
    turn.summary = projectTurnSummary(turn.assistantMessages);
    turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
    turn.diffStats = projectTurnDiffStats(turn.userMessage);
    turn.changedFiles = effectiveOptions.showTurnChangedFiles
        ? projectTurnChangedFiles(turn.userMessage)
        : undefined;

    const activity = projectTurnActivity({
        turnId: turn.turnId,
        assistantMessages: turn.assistantMessages,
        summarySourceMessageId: turn.summary.sourceMessageId,
        summarySourcePartId: turn.summary.sourcePartId,
        showTextJustificationActivity: effectiveOptions.showTextJustificationActivity,
    });
    turn.activityParts = activity.activityParts;
    turn.activitySegments = activity.activitySegments;
    turn.hasTools = activity.hasTools;
    turn.hasReasoning = activity.hasReasoning;

    turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
    turn.startedAt = turn.stream.startedAt;
    turn.completedAt = turn.stream.completedAt;
    turn.durationMs = turn.stream.durationMs;
    return turn;
};

const hydrateStableTurnRecords = (
    turns: TranscriptTurnRecord[],
    effectiveOptions: ResolvedProjectTurnRecordsOptions,
): TranscriptTurnRecord[] => {
    const previousProjection = effectiveOptions.previousProjection;
    if (!previousProjection || previousProjection.turns.length === 0 || turns.length === 0) {
        return turns.map((turn) => hydrateTurnRecord(turn, effectiveOptions));
    }

    let canReuseTurnArray = previousProjection.turns.length === turns.length;
    let reusedAnyTurn = false;

    const nextTurns = turns.map((turn, index) => {
        const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
        if (previousTurn && canReusePreviousTurn(previousTurn, turn)) {
            reusedAnyTurn = true;
            if (previousProjection.turns[index] !== previousTurn) {
                canReuseTurnArray = false;
            }
            return previousTurn;
        }

        canReuseTurnArray = false;
        return hydrateTurnRecord(turn, effectiveOptions);
    });

    if (canReuseTurnArray && reusedAnyTurn) {
        return previousProjection.turns;
    }

    return nextTurns;
};

const projectTranscriptTurnRecords = (
    messages: TranscriptMessageEntry[],
    options?: ProjectTurnRecordsOptions,
): TranscriptTurnProjectionResult => {
    const effectiveOptions: ResolvedProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
        showTextJustificationActivity: options?.showTextJustificationActivity ?? DEFAULT_OPTIONS.showTextJustificationActivity,
        showTurnChangedFiles: options?.showTurnChangedFiles ?? DEFAULT_OPTIONS.showTurnChangedFiles,
    };

    const turns: TranscriptTurnRecord[] = [];
    const turnByUserId = new Map<string, TranscriptTurnRecord>();
    const groupedMessageIds = new Set<string>();

    const mergeHiddenUserTurns = effectiveOptions.mergeHiddenUserTurns;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'user') {
            return;
        }

        const previousTurn = turns[turns.length - 1];
        if (
            mergeHiddenUserTurns
            && previousTurn
            && isHiddenUserMessage(message, { planModeEnabled: mergeHiddenUserTurns.planModeEnabled })
        ) {
            turnByUserId.set(message.id, previousTurn);
            previousTurn.messages.push(createTurnMessageRecord(message, index));
            groupedMessageIds.add(message.id);
            return;
        }

        const turnId = message.id;
        const turn: TranscriptTurnRecord = {
            turnId,
            userMessageId: message.id,
            userMessage: message,
            headerMessageId: undefined,
            messages: [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            changedFiles: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
        };
        turns.push(turn);
        turnByUserId.set(turn.userMessageId, turn);
        groupedMessageIds.add(message.id);
    });

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'assistant') {
            return;
        }

        const parentId = getMessageParentId(message);
        const targetTurn = parentId ? turnByUserId.get(parentId) : undefined;
        if (!targetTurn) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.id;
        }
        groupedMessageIds.add(message.id);
    });

    const stableTurns = hydrateStableTurnRecords(turns, effectiveOptions);
    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (resolveMessageRole(message) === 'assistant') {
            return;
        }
        if (!groupedMessageIds.has(message.id)) {
            ungroupedMessageIds.add(message.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};


export function projectTurnRecords(
    messages: TranscriptMessageEntry[],
    options?: ProjectTurnRecordsOptions,
): TranscriptTurnProjectionResult;
/** @deprecated Pass TranscriptMessage values instead. Genuine OpenCode records are adapted immediately. */
export function projectTurnRecords(
    messages: ChatMessageEntry[],
    options?: ProjectTurnRecordsOptions,
): TranscriptTurnProjectionResult;
export function projectTurnRecords(
    messages: TranscriptMessageEntry[] | ChatMessageEntry[],
    options: ProjectTurnRecordsOptions = {},
): TranscriptTurnProjectionResult {
    const first = messages[0];
    const transcriptMessages = first && 'info' in first
        ? adaptOpenCodeTurnMessages(messages as ChatMessageEntry[], options.mergeHiddenUserTurns?.planModeEnabled ?? false)
        : messages as TranscriptMessageEntry[];
    return projectTranscriptTurnRecords(transcriptMessages, options);
}
