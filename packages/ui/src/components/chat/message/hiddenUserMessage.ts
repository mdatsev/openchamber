import type { TranscriptMessage, TranscriptPart } from '../transcript/types';
import { filterVisibleParts } from './partUtils';

const hiddenByParts = new WeakMap<TranscriptPart[], boolean>();

export const isHiddenUserMessage = (
    entry: TranscriptMessage | null | undefined,
    options: { planModeEnabled: boolean },
): boolean => {
    void options.planModeEnabled;
    if (!entry || entry.role !== 'user') return false;
    const cached = hiddenByParts.get(entry.parts);
    if (cached !== undefined) return cached;
    const hidden = filterVisibleParts(entry.parts, { includeReasoning: true }).length === 0;
    hiddenByParts.set(entry.parts, hidden);
    return hidden;
};
