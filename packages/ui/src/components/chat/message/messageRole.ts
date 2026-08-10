import type { TranscriptMessage } from '../transcript/types';

export interface MessageRoleInfo {
    role: string;
    isUser: boolean;
}

export const deriveMessageRole = (message: TranscriptMessage): MessageRoleInfo => ({
    role: message.role,
    isUser: message.role === 'user' || message.userMessageMarker === true,
});
