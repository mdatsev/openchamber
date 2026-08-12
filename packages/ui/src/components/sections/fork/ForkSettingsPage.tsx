import React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useForkSettingsStore } from '@/stores/useForkSettingsStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';

const systemInfoSchema = z.object({
  startedAt: z.string().min(1),
  restartSupported: z.boolean().optional().default(false),
});

const restartResultSchema = z.object({
  ok: z.literal(true),
});

type SystemInfo = z.infer<typeof systemInfoSchema>;
type RestartError = 'load' | 'request' | 'timeout';

const RESTART_ERROR_MESSAGE_KEYS = {
  load: 'settings.fork.restart.loadError',
  request: 'settings.fork.restart.failed',
  timeout: 'settings.fork.restart.timeout',
} as const;

const RESTART_POLL_INTERVAL_MS = 1_000;
const RESTART_TIMEOUT_MS = 60_000;

const fetchSystemInfo = async () => {
  const response = await runtimeFetch('/api/system/info', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const parsed = systemInfoSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    throw new Error('Invalid system information response');
  }
  return parsed.data;
};

export const ForkSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const [systemInfo, setSystemInfo] = React.useState<SystemInfo | null>(null);
  const [isCheckingRestart, setIsCheckingRestart] = React.useState(true);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [restartError, setRestartError] = React.useState<RestartError | null>(null);
  const capabilityRequestIdRef = React.useRef(0);
  const startNewChatInCurrentWorktree = useForkSettingsStore((state) => state.startNewChatInCurrentWorktree);
  const setStartNewChatInCurrentWorktree = useForkSettingsStore((state) => state.setStartNewChatInCurrentWorktree);

  const loadRestartCapability = React.useCallback(async () => {
    const requestId = ++capabilityRequestIdRef.current;
    setIsCheckingRestart(true);
    setSystemInfo(null);
    setRestartError(null);
    try {
      const nextSystemInfo = await fetchSystemInfo();
      if (capabilityRequestIdRef.current === requestId) {
        setSystemInfo(nextSystemInfo);
      }
    } catch {
      if (capabilityRequestIdRef.current === requestId) {
        setRestartError('load');
      }
    } finally {
      if (capabilityRequestIdRef.current === requestId) {
        setIsCheckingRestart(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void loadRestartCapability();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      void loadRestartCapability();
    });
    return () => {
      capabilityRequestIdRef.current += 1;
      unsubscribe();
    };
  }, [loadRestartCapability]);

  const handleRestart = async () => {
    if (!systemInfo) {
      void loadRestartCapability();
      return;
    }

    setIsRestarting(true);
    setRestartError(null);
    try {
      const response = await runtimeFetch('/api/system/restart', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const parsed = restartResultSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        throw new Error('Restart request was rejected');
      }

      const runtimeKey = getRuntimeKey();
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
        if (getRuntimeKey() !== runtimeKey) return;

        try {
          const nextSystemInfo = await fetchSystemInfo();
          if (nextSystemInfo.startedAt !== systemInfo.startedAt) {
            window.location.reload();
            return;
          }
        } catch {
          // The runtime is expected to be unavailable while systemd restarts it.
        }
      }
      setRestartError('timeout');
    } catch {
      setRestartError('request');
    } finally {
      setIsRestarting(false);
    }
  };

  const restartDescription = restartError ? t(RESTART_ERROR_MESSAGE_KEYS[restartError]) : undefined;

  let restartButtonLabel = t('settings.fork.restart.action');
  if (isCheckingRestart) {
    restartButtonLabel = t('settings.fork.restart.checking');
  } else if (isRestarting) {
    restartButtonLabel = t('settings.fork.restart.restarting');
  } else if (restartError === 'load') {
    restartButtonLabel = t('settings.fork.restart.checkAgain');
  } else if (systemInfo?.restartSupported === false) {
    restartButtonLabel = t('settings.fork.restart.unavailable');
  }

  const isRestartPending = isCheckingRestart || isRestarting;

  return (
    <SettingsPageLayout
      title={t('settings.page.fork.title')}
      description={t('settings.page.fork.description')}
    >
      <SettingsSection
        title={t('settings.fork.section.worktrees')}
        divider={false}
      >
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="fork.start-new-chat-in-worktree"
            checked={startNewChatInCurrentWorktree}
            onChange={setStartNewChatInCurrentWorktree}
            label={t('settings.fork.startNewChatInWorktree.label')}
            ariaLabel={t('settings.fork.startNewChatInWorktree.label')}
            info={t('settings.fork.startNewChatInWorktree.info')}
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.fork.section.runtime')}>
        <SettingsFieldRow
          settingsItem="fork.restart-openchamber"
          label={t('settings.fork.restart.label')}
          info={t('settings.fork.restart.info')}
          description={restartDescription}
          alignEnd={false}
        >
          <Button
            size="sm"
            disabled={isRestartPending || systemInfo?.restartSupported === false}
            onClick={() => void handleRestart()}
          >
            <Icon
              name={isRestartPending ? 'loader-4' : 'restart'}
              className={isRestartPending ? 'size-4 animate-spin' : 'size-4'}
            />
            {restartButtonLabel}
          </Button>
        </SettingsFieldRow>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
