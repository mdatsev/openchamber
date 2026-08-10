import type { Message, Part } from '@opencode-ai/sdk/v2';

export interface OpenCodeMessageRecord {
  info: Message;
  parts: Part[];
}
