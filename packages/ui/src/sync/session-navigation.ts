import { chatIdentitiesEqual, type ChatHarness, type ChatIdentity } from "@/lib/chat-identity"

export type SessionNavigationProjection<TSession> = Readonly<{
  identity: ChatIdentity
  session: TSession
}>

export const projectSessionNavigation = <TSession>(
  identity: ChatIdentity,
  session: TSession,
): SessionNavigationProjection<TSession> => ({ identity, session })

export const isSessionNavigationProjectionActive = <TSession>(
  projection: SessionNavigationProjection<TSession>,
  visibleChatIdentity: ChatIdentity | null,
) => chatIdentitiesEqual(projection.identity, visibleChatIdentity)

type ChatIdentitySelectionHandler = (identity: ChatIdentity) => void

const selectionHandlers = new Map<ChatHarness, ChatIdentitySelectionHandler>()

export const registerChatIdentitySelectionHandler = (
  harness: ChatHarness,
  handler: ChatIdentitySelectionHandler,
) => {
  selectionHandlers.set(harness, handler)
  return () => {
    if (selectionHandlers.get(harness) === handler) {
      selectionHandlers.delete(harness)
    }
  }
}

export const selectChatIdentity = (identity: ChatIdentity) => {
  const handler = selectionHandlers.get(identity.harness)
  if (!handler) {
    throw new Error(`No chat selection handler registered for ${identity.harness}`)
  }
  handler(identity)
}

type SessionOpener = (sessionID: string, directory: string) => void

let sessionOpener: SessionOpener | null = null

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener
}

export const openSessionFromToast = (sessionID: string, directory: string) => {
  sessionOpener?.(sessionID, directory)
}
