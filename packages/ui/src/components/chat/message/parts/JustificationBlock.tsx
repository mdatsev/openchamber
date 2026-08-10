import React from 'react';
import type { TranscriptTextPart } from '../../transcript/types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { ReasoningTimelineBlock } from './ReasoningPart';

const cleanJustificationText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
        .join('\n')
        .trim();
};

interface JustificationBlockProps {
    part: TranscriptTextPart;
    messageId: string;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
    part,
    messageId,
    onContentChange,
    actions,
}) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const rawText = part.text;
    const textContent = React.useMemo(() => cleanJustificationText(rawText), [rawText]);
    const time = part.time;

    // Don't render if there's no text content
    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={textContent}
            variant="justification"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-justification`}
            time={time}
            showDuration={chatRenderMode !== 'sorted'}
            actions={actions}
        />
    );
};

export default React.memo(JustificationBlock);
