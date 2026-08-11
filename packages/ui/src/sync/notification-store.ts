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

export const useSessionUnseenCount = (directory: string | null | undefined, sessionId: string) => {
  const key = directory ? getSessionInboxKey(directory, sessionId) : null;
  return useSessionInboxStore((state) => key && state.records[key]?.unreadToken ? 1 : 0);
};
