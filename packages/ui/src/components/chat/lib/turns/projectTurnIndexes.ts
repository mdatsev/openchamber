import type { TranscriptTurnIndexes, TranscriptTurnProjectionResult, TranscriptTurnRecord } from './types';

export const projectTurnIndexes = (turns: TranscriptTurnRecord[]): TranscriptTurnProjectionResult => {
    const turnById = new Map<string, TranscriptTurnRecord>();
    const messageToTurnId = new Map<string, string>();
    const messageMetaById: TranscriptTurnIndexes['messageMetaById'] = new Map();
    const groupedMessageIds = new Set<string>();

    turns.forEach((turn) => {
        turnById.set(turn.turnId, turn);

        const firstAssistantId = turn.assistantMessages[0]?.id;
        const lastAssistantId = turn.assistantMessages[turn.assistantMessages.length - 1]?.id;

        messageToTurnId.set(turn.userMessageId, turn.turnId);
        groupedMessageIds.add(turn.userMessageId);
        messageMetaById.set(turn.userMessageId, {
            turnId: turn.turnId,
            messageId: turn.userMessageId,
            userMessageId: turn.userMessageId,
            isUserMessage: true,
            isAssistantMessage: false,
            isFirstAssistantInTurn: false,
            isLastAssistantInTurn: false,
            headerMessageId: turn.headerMessageId,
        });

        turn.assistantMessageIds.forEach((assistantMessageId) => {
            messageToTurnId.set(assistantMessageId, turn.turnId);
            groupedMessageIds.add(assistantMessageId);
            messageMetaById.set(assistantMessageId, {
                turnId: turn.turnId,
                messageId: assistantMessageId,
                userMessageId: turn.userMessageId,
                isUserMessage: false,
                isAssistantMessage: true,
                isFirstAssistantInTurn: assistantMessageId === firstAssistantId,
                isLastAssistantInTurn: assistantMessageId === lastAssistantId,
                headerMessageId: turn.headerMessageId,
            });
        });
    });

    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    const lastTurnMessageIds = new Set<string>();
    if (lastTurn) {
        lastTurnMessageIds.add(lastTurn.userMessageId);
        lastTurn.assistantMessageIds.forEach((messageId) => {
            lastTurnMessageIds.add(messageId);
        });
    }

    return {
        turns,
        indexes: {
            turnById,
            messageToTurnId,
            messageMetaById,
        },
        lastTurnId: lastTurn?.turnId ?? null,
        lastTurnMessageIds,
        ungroupedMessageIds: new Set<string>(),
    };
};
