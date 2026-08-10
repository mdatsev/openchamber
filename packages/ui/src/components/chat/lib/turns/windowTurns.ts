import type { ChatMessageEntry, TranscriptMessageEntry } from './types';
import { adaptOpenCodeTurnMessages } from '../../transcript/openCodeTurnCompatibility';

const resolveMessageRole = (message: TranscriptMessageEntry): string => message.role;

const resolveParentMessageId = (message: TranscriptMessageEntry): string | undefined => message.parentId;

export interface TurnWindowModel {
    turnIds: string[];
    turnMessageStartIndexes: number[];
    turnIndexById: Map<string, number>;
    messageToTurnId: Map<string, string>;
    messageToTurnIndex: Map<string, number>;
    turnCount: number;
}

const getMessageSignature = (message: TranscriptMessageEntry | undefined): string | null => {
    if (!message) return null;
    const role = resolveMessageRole(message);
    const messageId = message.id;
    const parentId = resolveParentMessageId(message) ?? '';
    return `${messageId}::${role}::${parentId}`;
};

const cloneTurnWindowModel = (model: TurnWindowModel): TurnWindowModel => ({
    turnIds: [...model.turnIds],
    turnMessageStartIndexes: [...model.turnMessageStartIndexes],
    turnIndexById: new Map(model.turnIndexById),
    messageToTurnId: new Map(model.messageToTurnId),
    messageToTurnIndex: new Map(model.messageToTurnIndex),
    turnCount: model.turnCount,
});

const updateTranscriptTurnWindowModelIncremental = (
    previousModel: TurnWindowModel | null,
    previousMessages: TranscriptMessageEntry[] | null,
    nextMessages: TranscriptMessageEntry[],
): TurnWindowModel | null => {
    if (!previousModel || !previousMessages) {
        return null;
    }

    if (previousMessages.length === nextMessages.length) {
        let changedIndex = -1;
        for (let index = 0; index < nextMessages.length; index += 1) {
            if (previousMessages[index] === nextMessages[index]) {
                continue;
            }
            if (changedIndex !== -1) {
                return null;
            }
            changedIndex = index;
        }

        if (changedIndex === -1) {
            return previousModel;
        }

        if (changedIndex !== nextMessages.length - 1) {
            return null;
        }

        return getMessageSignature(previousMessages[changedIndex]) === getMessageSignature(nextMessages[changedIndex])
            ? previousModel
            : null;
    }

    if (nextMessages.length !== previousMessages.length + 1) {
        return null;
    }

    for (let index = 0; index < previousMessages.length; index += 1) {
        if (previousMessages[index] !== nextMessages[index]) {
            return null;
        }
    }

    const nextMessage = nextMessages[nextMessages.length - 1];
    if (!nextMessage) {
        return null;
    }

    const role = resolveMessageRole(nextMessage);
    const messageId = nextMessage.id;
    const nextModel = cloneTurnWindowModel(previousModel);

    if (role === 'user') {
        const nextTurnIndex = nextModel.turnIds.length;
        nextModel.turnIds.push(messageId);
        nextModel.turnMessageStartIndexes.push(nextMessages.length - 1);
        nextModel.turnIndexById.set(messageId, nextTurnIndex);
        nextModel.messageToTurnId.set(messageId, messageId);
        nextModel.messageToTurnIndex.set(messageId, nextTurnIndex);
        nextModel.turnCount = nextModel.turnIds.length;
        return nextModel;
    }

    if (role !== 'assistant') {
        const currentTurnIndex = nextModel.turnIds.length - 1;
        if (currentTurnIndex < 0) {
            return null;
        }
        const turnId = nextModel.turnIds[currentTurnIndex];
        if (!turnId) {
            return null;
        }
        nextModel.messageToTurnId.set(messageId, turnId);
        nextModel.messageToTurnIndex.set(messageId, currentTurnIndex);
        return nextModel;
    }

    const parentId = resolveParentMessageId(nextMessage);
    if (!parentId) {
        return nextModel;
    }
    const targetTurnIndex = nextModel.turnIndexById.get(parentId);
    if (typeof targetTurnIndex !== 'number' || targetTurnIndex < 0) {
        return null;
    }

    const turnId = nextModel.turnIds[targetTurnIndex];
    if (!turnId) {
        return null;
    }

    nextModel.messageToTurnId.set(messageId, turnId);
    nextModel.messageToTurnIndex.set(messageId, targetTurnIndex);
    return nextModel;
};

const buildTranscriptTurnWindowModel = (messages: TranscriptMessageEntry[]): TurnWindowModel => {
    const turnIds: string[] = [];
    const turnMessageStartIndexes: number[] = [];
    const turnIndexById = new Map<string, number>();
    const messageToTurnId = new Map<string, string>();
    const messageToTurnIndex = new Map<string, number>();
    const userMessageToTurnIndex = new Map<string, number>();

    let currentTurnIndex = -1;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        const messageId = message.id;

        if (role === 'user') {
            currentTurnIndex = turnIds.length;
            turnIds.push(messageId);
            turnMessageStartIndexes.push(index);
            turnIndexById.set(messageId, currentTurnIndex);
            userMessageToTurnIndex.set(messageId, currentTurnIndex);
            messageToTurnId.set(messageId, messageId);
            messageToTurnIndex.set(messageId, currentTurnIndex);
            return;
        }

        if (role !== 'assistant') {
            if (currentTurnIndex >= 0) {
                const turnId = turnIds[currentTurnIndex];
                if (turnId) {
                    messageToTurnId.set(messageId, turnId);
                    messageToTurnIndex.set(messageId, currentTurnIndex);
                }
            }
            return;
        }

        const parentId = resolveParentMessageId(message);
        if (!parentId) {
            return;
        }
        const targetTurnIndex = userMessageToTurnIndex.get(parentId);
        if (typeof targetTurnIndex !== 'number') {
            return;
        }
        if (targetTurnIndex < 0) {
            return;
        }

        const turnId = turnIds[targetTurnIndex];
        if (!turnId) {
            return;
        }

        messageToTurnId.set(messageId, turnId);
        messageToTurnIndex.set(messageId, targetTurnIndex);
    });

    return {
        turnIds,
        turnMessageStartIndexes,
        turnIndexById,
        messageToTurnId,
        messageToTurnIndex,
        turnCount: turnIds.length,
    };
};


export function buildTurnWindowModel(messages: TranscriptMessageEntry[]): TurnWindowModel;
/** @deprecated Pass TranscriptMessage values instead. */
export function buildTurnWindowModel(messages: ChatMessageEntry[]): TurnWindowModel;
export function buildTurnWindowModel(messages: TranscriptMessageEntry[] | ChatMessageEntry[]): TurnWindowModel {
    const first = messages[0];
    return buildTranscriptTurnWindowModel(first && 'info' in first
        ? adaptOpenCodeTurnMessages(messages as ChatMessageEntry[])
        : messages as TranscriptMessageEntry[]);
}

export function updateTurnWindowModelIncremental(
    previousModel: TurnWindowModel | null,
    previousMessages: TranscriptMessageEntry[] | null,
    nextMessages: TranscriptMessageEntry[],
): TurnWindowModel | null;
/** @deprecated Pass TranscriptMessage values instead. */
export function updateTurnWindowModelIncremental(
    previousModel: TurnWindowModel | null,
    previousMessages: ChatMessageEntry[] | null,
    nextMessages: ChatMessageEntry[],
): TurnWindowModel | null;
export function updateTurnWindowModelIncremental(
    previousModel: TurnWindowModel | null,
    previousMessages: TranscriptMessageEntry[] | ChatMessageEntry[] | null,
    nextMessages: TranscriptMessageEntry[] | ChatMessageEntry[],
): TurnWindowModel | null {
    const nextFirst = nextMessages[0];
    const next = nextFirst && 'info' in nextFirst
        ? adaptOpenCodeTurnMessages(nextMessages as ChatMessageEntry[])
        : nextMessages as TranscriptMessageEntry[];
    const previousFirst = previousMessages?.[0];
    const previous = previousMessages && previousFirst && 'info' in previousFirst
        ? adaptOpenCodeTurnMessages(previousMessages as ChatMessageEntry[])
        : previousMessages as TranscriptMessageEntry[] | null;
    return updateTranscriptTurnWindowModelIncremental(previousModel, previous, next);
}
