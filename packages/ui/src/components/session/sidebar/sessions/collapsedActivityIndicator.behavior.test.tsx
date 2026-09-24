import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import {
  applySessionInboxEventPayload,
  resetSessionInboxForRuntimeSwitch,
  useSessionInboxStore,
} from '@/stores/useSessionInboxStore';
import { useCollapsedSessionActivityState } from './collapsedActivityState';
import type { SessionNode } from '../types';
import { installHookTestDom } from '../test-utils/testDom';

// SAFETY: the fixture supplies the minimal SDK identity used by the selector.
const node = (id: string): SessionNode => ({ session: { id } as Session, children: [], worktree: null });

describe('collapsed activity scalar selector', () => {
  test('does not rerender for unrelated updates and rerenders for relevant scalar changes', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    replaceGlobalSessionStatusById(new Map());
    resetSessionInboxForRuntimeSwitch(useSessionInboxStore.getState().runtimeKey);
    type ActivityCapture = { renders: number; state: string | null };
    const capture: ActivityCapture = { renders: 0, state: null };
    const Harness = () => {
      capture.renders += 1;
      capture.state = useCollapsedSessionActivityState({ nodes: [node('relevant')], includeUnreadSubtasks: true });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const initialRenders = capture.renders;
      await act(async () => replaceGlobalSessionStatusById(new Map([['unrelated', { status: { type: 'busy' }, directory: '/other' }]])));
      await act(async () => applySessionInboxEventPayload({
        directory: '/other', sessionId: 'unrelated', unreadToken: 'unrelated-unread', pinned: false, revision: 1,
      }));
      expect(capture.renders).toBe(initialRenders);

      await act(async () => applySessionInboxEventPayload({
        directory: '/workspace', sessionId: 'relevant', unreadToken: 'relevant-unread', pinned: false, revision: 2,
      }));
      expect(capture.state).toBe('unread');
      const unreadRenders = capture.renders;
      await act(async () => replaceGlobalSessionStatusById(new Map([['relevant', { status: { type: 'busy' }, directory: '/workspace' }]])));
      expect(capture.state).toBe('active');
      expect(capture.renders).toBe(unreadRenders + 1);
    } finally {
      await act(async () => root.unmount());
      replaceGlobalSessionStatusById(new Map());
      resetSessionInboxForRuntimeSwitch(useSessionInboxStore.getState().runtimeKey);
      dom.restore();
    }
  });
});
