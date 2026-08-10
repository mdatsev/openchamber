import React from 'react';

import type { TranscriptMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: TranscriptMessageEntry[];
    renderMessage: (message: TranscriptMessageEntry) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage }) => {
    return (
        <div className="relative z-0">
            {assistantMessages.map((message) => renderMessage(message))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
