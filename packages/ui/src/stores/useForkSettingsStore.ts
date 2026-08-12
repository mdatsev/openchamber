import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type ForkSettingsStore = {
  startNewChatInCurrentWorktree: boolean;
  setStartNewChatInCurrentWorktree: (enabled: boolean) => void;
};

export const useForkSettingsStore = create<ForkSettingsStore>()(
  persist(
    (set) => ({
      startNewChatInCurrentWorktree: true,
      setStartNewChatInCurrentWorktree: (enabled) => set({ startNewChatInCurrentWorktree: enabled }),
    }),
    {
      name: 'custom-fork-settings',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({
        startNewChatInCurrentWorktree: state.startNewChatInCurrentWorktree,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ForkSettingsStore> | undefined;
        return {
          ...currentState,
          startNewChatInCurrentWorktree: typeof persisted?.startNewChatInCurrentWorktree === 'boolean'
            ? persisted.startNewChatInCurrentWorktree
            : currentState.startNewChatInCurrentWorktree,
        };
      },
    },
  ),
);
