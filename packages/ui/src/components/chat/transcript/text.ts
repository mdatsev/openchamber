import type { TranscriptPart } from './types';

export const flattenTranscriptTextParts = (parts: TranscriptPart[]): string => {
  const text = parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
  return text.replace(/\n\s*\n+/g, '\n');
};
