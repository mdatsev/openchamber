import { create } from "zustand"
import { chatIdentitiesEqual, type ChatIdentity } from "@/lib/chat-identity"

type ChatSelectionState = {
  visibleChatIdentity: ChatIdentity | null
  setVisibleChatIdentity: (identity: ChatIdentity | null) => void
}

export const useChatSelectionStore = create<ChatSelectionState>()((set) => ({
  visibleChatIdentity: null,
  setVisibleChatIdentity: (identity) => set((state) =>
    chatIdentitiesEqual(state.visibleChatIdentity, identity)
      ? state
      : { visibleChatIdentity: identity },
  ),
}))
