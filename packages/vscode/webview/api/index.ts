import type { RuntimeAPIs, TerminalAPI } from '@openchamber/ui/lib/api/types';
import { createVSCodeFilesAPI } from './files';
import { createVSCodeSettingsAPI } from './settings';
import { createVSCodePermissionsAPI } from './permissions';
import { createVSCodeToolsAPI } from './tools';
import { createVSCodeEditorAPI } from './editor';
import { createVSCodeGitAPI } from './git';
import { createVSCodeActionsAPI } from './vscode';
import { createVSCodeGitHubAPI } from './github';
import { createVSCodeNotificationsAPI } from './notifications';

const terminalUnsupported = async (): Promise<never> => {
  throw new Error('Terminal is not supported in the VS Code runtime');
};

const createStubTerminalAPI = (): TerminalAPI => ({
  listShells: terminalUnsupported,
  createSession: terminalUnsupported,
  connect: (_sessionId, handlers) => {
    handlers.onError?.(new Error('Terminal is not supported in the VS Code runtime'), true);
    return { close: () => {} };
  },
  sendInput: terminalUnsupported,
  resize: terminalUnsupported,
  close: terminalUnsupported,
});

const unsupportedPrimeStatus = async () => ({
  schemaVersion: 1,
  state: 'unsupported',
  interactive: false,
  authentication: 'unknown',
  binarySource: null,
  version: null,
  message: 'Prime Agent is not supported in the VS Code runtime',
} as const);

const primeUnsupported = async (): Promise<never> => {
  throw new Error('Prime Agent is not supported in the VS Code runtime');
};

const primeControlsUnsupported = async (): Promise<never> => {
  throw new Error('Prime Agent controls are not supported in the VS Code runtime');
};

export const createVSCodeAPIs = (): RuntimeAPIs => ({
  runtime: { platform: 'vscode', isDesktop: false, isVSCode: true, label: 'VS Code Extension' },
  terminal: createStubTerminalAPI(),
  git: createVSCodeGitAPI(),
  files: createVSCodeFilesAPI(),
  settings: createVSCodeSettingsAPI(),
  permissions: createVSCodePermissionsAPI(),
  notifications: createVSCodeNotificationsAPI(),
  github: createVSCodeGitHubAPI(),
  prime: {
    getStatus: unsupportedPrimeStatus,
    reconnect: unsupportedPrimeStatus,
    listSessions: async () => ({ status: 'unsupported', sessions: [], skippedFileCount: 0, failedSessionIDs: [] }),
    getTranscript: async () => {
      throw new Error('Prime Agent transcripts are not supported in the VS Code runtime');
    },
    attachSession: primeUnsupported,
    getDraftControls: primeControlsUnsupported,
    getSessionControls: primeControlsUnsupported,
    setSessionModel: primeControlsUnsupported,
    setSessionThinkingLevel: primeControlsUnsupported,
    createSession: primeUnsupported,
    sendPrompt: primeUnsupported,
    abortSession: primeUnsupported,
    subscribe: () => ({ close: () => {} }),
  },
  tools: createVSCodeToolsAPI(),
  editor: createVSCodeEditorAPI(),
  vscode: createVSCodeActionsAPI(),
});
