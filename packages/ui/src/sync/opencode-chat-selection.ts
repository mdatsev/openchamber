import type { ChatIdentity } from "@/lib/chat-identity"
import { useChatSelectionStore } from "@/stores/useChatSelectionStore"
import {
  isSessionNavigationProjectionActive,
  projectSessionNavigation,
} from "./session-navigation"

const OPENCODE_CHAT_HARNESS = "opencode"

export const createOpenCodeChatIdentity = (runtimeKey: string, sessionId: string): ChatIdentity => ({
  runtimeKey,
  harness: OPENCODE_CHAT_HARNESS,
  sessionId,
})

export const projectOpenCodeSessionNavigation = <TSession extends { id: string }>(
  runtimeKey: string,
  session: TSession,
) => projectSessionNavigation(createOpenCodeChatIdentity(runtimeKey, session.id), session)

export const isOpenCodeSessionNavigationActive = <TSession extends { id: string }>(
  visibleChatIdentity: ChatIdentity | null,
  runtimeKey: string,
  session: TSession,
) => isSessionNavigationProjectionActive(
  projectOpenCodeSessionNavigation(runtimeKey, session),
  visibleChatIdentity,
)

export const getVisibleOpenCodeSessionId = (
  visibleChatIdentity: ChatIdentity | null,
  runtimeKey: string,
) => visibleChatIdentity?.runtimeKey === runtimeKey
  && visibleChatIdentity.harness === OPENCODE_CHAT_HARNESS
    ? visibleChatIdentity.sessionId
    : null

export const setVisibleOpenCodeSession = (runtimeKey: string, sessionId: string | null) => {
  const selectionStore = useChatSelectionStore.getState()
  if (!sessionId) {
    const visibleIdentity = selectionStore.visibleChatIdentity
    if (visibleIdentity?.runtimeKey !== runtimeKey || visibleIdentity.harness !== OPENCODE_CHAT_HARNESS) {
      return
    }
  }
  selectionStore.setVisibleChatIdentity(
    sessionId ? createOpenCodeChatIdentity(runtimeKey, sessionId) : null,
  )
}

export const restoreVisibleOpenCodeSession = (runtimeKey: string, sessionId: string | null) => {
  const selectionStore = useChatSelectionStore.getState()
  const visibleIdentity = selectionStore.visibleChatIdentity
  if (visibleIdentity?.runtimeKey === runtimeKey && visibleIdentity.harness !== OPENCODE_CHAT_HARNESS) {
    return
  }
  selectionStore.setVisibleChatIdentity(
    sessionId ? createOpenCodeChatIdentity(runtimeKey, sessionId) : null,
  )
}
