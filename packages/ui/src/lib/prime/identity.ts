import type { ChatIdentity } from '@/lib/chat-identity';

export const createPrimeChatIdentity = (runtimeKey: string, sessionId: string): ChatIdentity => ({
  runtimeKey,
  harness: 'prime',
  sessionId,
});
