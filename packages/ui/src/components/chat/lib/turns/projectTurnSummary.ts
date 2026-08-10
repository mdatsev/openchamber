import type { TranscriptMessageEntry, TurnChangedFile, TurnDiffStats, TurnSummaryRecord } from './types';

export const projectTurnSummary = (assistantMessages: TranscriptMessageEntry[]): TurnSummaryRecord => {
    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage || assistantMessage.isCompactionSummary) continue;
        if (assistantMessage.finish !== 'stop') continue;

        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || part.kind !== 'text' || part.text.trim().length === 0) continue;
            return { text: part.text, sourceMessageId: assistantMessage.id, sourcePartId: part.id };
        }
    }

    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage || assistantMessage.isCompactionSummary) continue;
        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || part.kind !== 'text' || part.text.trim().length === 0) continue;
            return { text: part.text, sourceMessageId: assistantMessage.id, sourcePartId: part.id };
        }
    }

    return {};
};

export const projectTurnDiffStats = (userMessage: TranscriptMessageEntry): TurnDiffStats | undefined => userMessage.diffStats;

export const projectTurnChangedFiles = (userMessage: TranscriptMessageEntry): TurnChangedFile[] | undefined => userMessage.changedFiles;
