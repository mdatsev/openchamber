import type { TranscriptPart, TranscriptTextPart } from '../transcript/types';

export const normalizeParts = (parts: TranscriptPart[]): TranscriptPart[] => parts;

export const extractTextContent = (part: TranscriptPart): string => (
    part.kind === 'text' || part.kind === 'reasoning' ? part.text : ''
);

export const isEmptyTextPart = (part: TranscriptPart): boolean => (
    part.kind === 'text' && part.text.trim().length === 0
);

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: TranscriptPart[], options: VisibleFilterOptions = {}): TranscriptPart[] => {
    const { includeReasoning = true } = options;
    const hasNonSynthetic = parts.some((part) => !part.synthetic);
    return parts.filter((part) => {
        if (part.synthetic && part.kind === 'text' && part.text.includes('<system-reminder>')) return false;
        if (part.synthetic && hasNonSynthetic) return false;
        if (!includeReasoning && part.kind === 'reasoning') return false;
        return true;
    });
};

export const isTranscriptTextPart = (part: TranscriptPart): part is TranscriptTextPart => part.kind === 'text';
