import React from 'react';

import type { TranscriptMessageActions } from './types';

const EMPTY_TRANSCRIPT_MESSAGE_ACTIONS: TranscriptMessageActions = {};
const TranscriptMessageActionsContext = React.createContext<TranscriptMessageActions>(
  EMPTY_TRANSCRIPT_MESSAGE_ACTIONS,
);

export const TranscriptMessageActionsProvider = TranscriptMessageActionsContext.Provider;

export const useTranscriptMessageActions = (): TranscriptMessageActions => (
  React.useContext(TranscriptMessageActionsContext)
);
