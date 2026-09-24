import { create } from 'zustand';
import {
  getSessionInboxKey,
  markSessionInboxRead,
  markSessionInboxUnread,
  useSessionInboxStore,
} from '@/stores/useSessionInboxStore';

export const useNotificationStore = useSessionInboxStore;

export const markSessionViewed = (directory: string, sessionId: string, expectedUnreadToken?: string) => {
  void markSessionInboxRead({ directory, sessionId }, expectedUnreadToken);
};

export const markSessionUnread = (directory: string, sessionId: string) => {
  void markSessionInboxUnread({ directory, sessionId });
};

export const useSessionUnseenCount = (
  directoryOrSessionId: string | null | undefined,
  scopedSessionId?: string,
) => {
  const key = scopedSessionId && directoryOrSessionId
    ? getSessionInboxKey(directoryOrSessionId, scopedSessionId)
    : null;
  const sessionId = scopedSessionId ?? directoryOrSessionId;
  return useSessionInboxStore((state) => (
    key
      ? (state.records[key]?.unreadToken ? 1 : 0)
      : (sessionId ? state.index.session.unseenCount[sessionId] ?? 0 : 0)
  ));
};

type NotificationBase = {
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  /** What OpenCode reported for the failed turn; both null when it gave no details. */
  error?: { name: string | null; message: string | null }
}

export type Notification = TurnCompleteNotification | ErrorNotification

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

interface LocalNotificationStore {
  list: Notification[]
  append: (notification: Notification) => void
}

const useLocalNotificationStore = create<LocalNotificationStore>((set, get) => ({
  list: [],
  append: (notification) => {
    set({ list: pruneNotifications([...get().list, notification]) })
  },
}))

export function appendNotification(notification: Notification) {
  useLocalNotificationStore.getState().append(notification)
}

/** The newest error OpenCode reported for this session, viewed or not. */
export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useLocalNotificationStore((s) => {
    if (!sessionId) return null
    for (let index = s.list.length - 1; index >= 0; index -= 1) {
      const notification = s.list[index]
      if (notification.session === sessionId && notification.type === "error") return notification
    }
    return null
  })
}
