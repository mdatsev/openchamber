import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type ForkSettingsStore = {
  moveSessionChangesToWorktree: boolean;
  startNewChatInCurrentWorktree: boolean;
  setMoveSessionChangesToWorktree: (enabled: boolean) => void;
  setStartNewChatInCurrentWorktree: (enabled: boolean) => void;
};

export const useForkSettingsStore = create<ForkSettingsStore>()(
  persist(
    (set) => ({
      moveSessionChangesToWorktree: true,
      startNewChatInCurrentWorktree: true,
      setMoveSessionChangesToWorktree: (enabled) => set({ moveSessionChangesToWorktree: enabled }),
      setStartNewChatInCurrentWorktree: (enabled) => set({ startNewChatInCurrentWorktree: enabled }),
    }),
    {
      name: 'custom-fork-settings',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({
        moveSessionChangesToWorktree: state.moveSessionChangesToWorktree,
        startNewChatInCurrentWorktree: state.startNewChatInCurrentWorktree,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ForkSettingsStore> | undefined;
        return {
          ...currentState,
          moveSessionChangesToWorktree: typeof persisted?.moveSessionChangesToWorktree === 'boolean'
            ? persisted.moveSessionChangesToWorktree
            : currentState.moveSessionChangesToWorktree,
          startNewChatInCurrentWorktree: typeof persisted?.startNewChatInCurrentWorktree === 'boolean'
            ? persisted.startNewChatInCurrentWorktree
            : currentState.startNewChatInCurrentWorktree,
        };
      },
    },
  ),
);
