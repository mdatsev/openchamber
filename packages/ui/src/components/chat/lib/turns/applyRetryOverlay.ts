import type { TranscriptMessage } from '../../transcript/types';

interface RetryOverlayInput {
    sessionId: string | null;
    message: string;
    confirmedAt?: number;
    fallbackTimestamp: number;
}

export const applyRetryOverlay = (
    messages: TranscriptMessage[],
    input: RetryOverlayInput,
): TranscriptMessage[] => {
    if (!input.sessionId) return messages;

    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0) return messages;

    let targetAssistantIndex = -1;
    for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
        if (messages[index]?.role === 'assistant') {
            targetAssistantIndex = index;
            break;
        }
    }

    const error = {
        text: `Opencode failed to send a message. Retry attempt info: 
\`${input.message}\``,
        variant: 'info' as const,
    };
    if (targetAssistantIndex >= 0) {
        const existing = messages[targetAssistantIndex];
        if (existing.error) return messages;
        return messages.map((message, index) => index === targetAssistantIndex ? { ...message, error } : message);
    }

    const eventTime = input.confirmedAt ?? input.fallbackTimestamp;
    const synthetic: TranscriptMessage = {
        id: `synthetic_retry_notice_${input.sessionId}`,
        sessionId: input.sessionId,
        role: 'assistant',
        createdAt: eventTime,
        completedAt: eventTime,
        finish: 'stop',
        error,
        parts: [],
    };
    const next = messages.slice();
    next.splice(lastUserIndex + 1, 0, synthetic);
    return next;
};
