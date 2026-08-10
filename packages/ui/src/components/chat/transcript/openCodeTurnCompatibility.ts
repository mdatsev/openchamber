import type { OpenCodeMessageRecord } from './openCodeTypes';
import { adaptOpenCodeMessage, adaptOpenCodePart } from './openCodeTranscriptAdapter';
import type { TranscriptPart } from './types';
import type { TranscriptMessage } from './types';

const cache = new WeakMap<OpenCodeMessageRecord, Map<boolean, TranscriptMessage>>();

/** @deprecated Compatibility for callers that still provide genuine OpenCode records to turn helpers. */
export const adaptOpenCodeTurnMessage = (record: OpenCodeMessageRecord, planModeEnabled = false): TranscriptMessage => {
  let byMode = cache.get(record);
  if (!byMode) {
    byMode = new Map();
    cache.set(record, byMode);
  }
  const cached = byMode.get(planModeEnabled);
  if (cached) return cached;
  const adapted = adaptOpenCodeMessage(record, { planModeEnabled });
  byMode.set(planModeEnabled, adapted);
  return adapted;
};

/** @deprecated Adapt genuine OpenCode records immediately before invoking neutral turn logic. */
export const adaptOpenCodeTurnMessages = (records: OpenCodeMessageRecord[], planModeEnabled = false): TranscriptMessage[] => (
  records.map((record) => adaptOpenCodeTurnMessage(record, planModeEnabled))
);

export const adaptOpenCodeLiveParts = (parts: OpenCodeMessageRecord['parts'], messageId: string): TranscriptPart[] => (
  parts.flatMap((part, index) => {
    const adapted = adaptOpenCodePart(part, messageId, index);
    return adapted ? [adapted] : [];
  })
);
