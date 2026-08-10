export type ChatHarness = 'opencode' | 'prime'

export type ChatIdentity = Readonly<{
  runtimeKey: string
  harness: ChatHarness
  sessionId: string
}>

export const serializeChatIdentityParts = (
  runtimeKey: string,
  harness: ChatHarness,
  sessionId: string,
) => `${runtimeKey.length}:${runtimeKey}:${harness}:${sessionId}`

export const serializeChatIdentity = (identity: ChatIdentity) => serializeChatIdentityParts(
  identity.runtimeKey,
  identity.harness,
  identity.sessionId,
)

export const chatIdentitiesEqual = (left: ChatIdentity | null, right: ChatIdentity | null) =>
  left === right
  || (left !== null
    && right !== null
    && left.runtimeKey === right.runtimeKey
    && left.harness === right.harness
    && left.sessionId === right.sessionId)
