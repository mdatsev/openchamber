import * as React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { usePendingOpenCodeRestartStore } from '@/stores/usePendingOpenCodeRestartStore';
import { refreshAfterOpenCodeUpgrade } from '@/stores/useAgentsStore';

const openCodeUpgradeOperationSchema = z.object({
  phase: z.enum(['idle', 'queued', 'upgrading', 'restarting', 'updated', 'failed']),
  activeSessionCount: z.number().optional(),
  version: z.string().nullable().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
});

const openCodeUpgradeStatusSchema = z.object({
  available: z.boolean().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
  upgrade: z.object({
    supported: z.boolean().nullable().optional(),
    manager: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }).nullable().optional(),
  operation: openCodeUpgradeOperationSchema.optional(),
});

const openCodeUpgradeResultSchema = z.object({
  success: z.boolean().optional(),
  queued: z.boolean().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

type OpenCodeUpgradeStatus = z.infer<typeof openCodeUpgradeStatusSchema>;
type OpenCodeUpgradePhase = 'checking' | 'ready' | 'queued' | 'updating' | 'restarting' | 'updated' | 'check-error' | 'update-error';

const POLL_INTERVAL_MS = 2_000;

export const OpenCodeUpdateSettings: React.FC = () => {
  const { t } = useI18n();
  const [upgradePhase, setUpgradePhase] = React.useState<OpenCodeUpgradePhase>('checking');
  const [upgradeStatus, setUpgradeStatus] = React.useState<OpenCodeUpgradeStatus | null>(null);
  const [installedVersion, setInstalledVersion] = React.useState('');
  const upgradeRequestIdRef = React.useRef(0);
  const pollAbortControllerRef = React.useRef<AbortController | null>(null);
  const refreshedVersionRef = React.useRef<string | null>(null);

  const checkForOpenCodeUpdate = React.useCallback(async (showChecking = true, signal?: AbortSignal) => {
    const requestId = ++upgradeRequestIdRef.current;
    if (showChecking) {
      setUpgradePhase('checking');
      setInstalledVersion('');
    }

    try {
      const response = await runtimeFetch('/api/opencode/upgrade-status', {
        headers: { Accept: 'application/json' },
        signal,
      });
      const parsed = openCodeUpgradeStatusSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error('Invalid OpenCode upgrade status');
      if (upgradeRequestIdRef.current !== requestId) return;

      const operation = parsed.data.operation;
      setUpgradeStatus(parsed.data);
      if (operation?.phase === 'queued') {
        setUpgradePhase('queued');
      } else if (operation?.phase === 'upgrading') {
        setUpgradePhase('updating');
      } else if (operation?.phase === 'restarting') {
        setUpgradePhase('restarting');
      } else if (operation?.phase === 'updated') {
        usePendingOpenCodeRestartStore.getState().clear();
        const nextVersion = operation.version?.trim() || parsed.data.currentVersion?.trim() || '';
        setInstalledVersion(nextVersion);
        if (refreshedVersionRef.current !== nextVersion) {
          refreshedVersionRef.current = nextVersion;
          void refreshAfterOpenCodeUpgrade(operation.completedAt?.toString() || nextVersion).catch((error) => {
            console.error('[OpenCodeUpdateSettings] Failed to refresh configuration after upgrade:', error);
          });
        }
        setUpgradePhase('updated');
      } else if (operation?.phase === 'failed') {
        setUpgradePhase('update-error');
      } else {
        setUpgradePhase('ready');
      }
    } catch {
      if (upgradeRequestIdRef.current !== requestId) return;
      setUpgradeStatus(null);
      setUpgradePhase(showChecking ? 'check-error' : 'update-error');
    }
  }, []);

  React.useEffect(() => {
    void checkForOpenCodeUpdate();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      void checkForOpenCodeUpdate();
    });

    return () => {
      upgradeRequestIdRef.current += 1;
      unsubscribe();
    };
  }, [checkForOpenCodeUpdate]);

  React.useEffect(() => {
    if (!['queued', 'updating', 'restarting'].includes(upgradePhase)) return;
    const timeout = window.setTimeout(() => {
      pollAbortControllerRef.current?.abort();
      const controller = new AbortController();
      pollAbortControllerRef.current = controller;
      void checkForOpenCodeUpdate(false, controller.signal);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(timeout);
      pollAbortControllerRef.current?.abort();
      pollAbortControllerRef.current = null;
    };
  }, [checkForOpenCodeUpdate, upgradePhase]);

  const latestVersion = upgradeStatus?.latestVersion?.trim() ?? '';
  const canRetryUpgrade = upgradePhase === 'update-error' && upgradeStatus?.upgrade?.supported === true;
  const updateAvailable = upgradePhase !== 'updated'
    && upgradeStatus?.upgrade?.supported === true
    && upgradeStatus.available === true
    && latestVersion.length > 0;
  let updateDescription = t('settings.fork.opencodeUpdate.state.updateUnavailable');
  if (upgradePhase === 'checking') {
    updateDescription = t('settings.openchamber.about.state.checking');
  } else if (upgradePhase === 'queued') {
    updateDescription = t('settings.fork.opencodeUpdate.state.queued');
  } else if (upgradePhase === 'updating') {
    updateDescription = t('opencodeUpdate.toast.upgrading.title');
  } else if (upgradePhase === 'restarting') {
    updateDescription = t('settings.fork.opencodeUpdate.state.restarting');
  } else if (upgradePhase === 'updated') {
    updateDescription = installedVersion
      ? t('opencodeUpdate.toast.updated.descriptionWithVersion', { version: installedVersion })
      : t('opencodeUpdate.toast.updated.description');
  } else if (upgradePhase === 'check-error') {
    updateDescription = t('settings.fork.opencodeUpdate.state.checkFailed');
  } else if (upgradePhase === 'update-error') {
    updateDescription = upgradeStatus?.operation?.error || t('opencodeUpdate.toast.failed.title');
  } else if (updateAvailable) {
    updateDescription = t('opencodeUpdate.toast.available.description', { version: latestVersion });
  } else if (upgradeStatus?.upgrade?.supported === true) {
    updateDescription = t('settings.openchamber.about.toast.latestVersion');
  }

  let updateButtonLabel = t('settings.openchamber.about.actions.checkForUpdates');
  if (upgradePhase === 'checking') {
    updateButtonLabel = t('settings.openchamber.about.state.checking');
  } else if (upgradePhase === 'queued') {
    updateButtonLabel = t('settings.common.actions.cancel');
  } else if (upgradePhase === 'updating') {
    updateButtonLabel = t('opencodeUpdate.toast.upgrading.title');
  } else if (upgradePhase === 'restarting') {
    updateButtonLabel = t('settings.fork.opencodeUpdate.state.restarting');
  } else if (upgradePhase === 'updated') {
    updateButtonLabel = t('opencodeUpdate.toast.updated.title');
  } else if (updateAvailable || canRetryUpgrade) {
    updateButtonLabel = t('opencodeUpdate.toast.actions.update');
  }

  const isUpgradePending = ['checking', 'queued', 'updating', 'restarting'].includes(upgradePhase);
  const updateButtonIcon = isUpgradePending
    ? upgradePhase === 'queued' ? 'close' : 'loader'
    : updateAvailable
      ? 'download'
      : upgradePhase === 'updated'
        ? 'check'
        : 'refresh';

  return (
    <SettingsFieldRow
      settingsItem="sessions.opencode-update"
      label={t('settings.fork.opencodeUpdate.label')}
      description={updateDescription}
      info={t('settings.fork.opencodeUpdate.info')}
      alignEnd={false}
      controlClassName="@xl:w-[20rem]"
    >
      <Button
        type="button"
        variant={updateAvailable || canRetryUpgrade || upgradePhase === 'updated' ? 'default' : 'outline'}
        size="xs"
        disabled={(isUpgradePending && upgradePhase !== 'queued') || upgradePhase === 'updated'}
        className="shrink-0 !font-normal"
        onClick={async () => {
          if (upgradePhase === 'queued') {
            try {
              const response = await runtimeFetch('/api/opencode/upgrade/cancel', {
                method: 'POST',
                headers: { Accept: 'application/json' },
              });
              if (!response.ok) {
                setUpgradePhase('update-error');
                return;
              }
              await checkForOpenCodeUpdate(false);
            } catch {
              setUpgradePhase('update-error');
            }
            return;
          }
          if (!updateAvailable && !canRetryUpgrade) {
            await checkForOpenCodeUpdate();
            return;
          }

          const requestId = ++upgradeRequestIdRef.current;
          setUpgradePhase('updating');
          try {
            const response = await runtimeFetch('/api/opencode/upgrade', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({}),
            });
            const parsed = openCodeUpgradeResultSchema.safeParse(await response.json().catch(() => null));
            if (!response.ok || !parsed.success || parsed.data.success === false) {
              throw new Error(parsed.success ? parsed.data.error : 'Invalid OpenCode upgrade response');
            }
            if (upgradeRequestIdRef.current !== requestId) return;

            if (response.status === 202) {
              setUpgradePhase(parsed.data.queued ? 'queued' : 'updating');
              return;
            }
            usePendingOpenCodeRestartStore.getState().clear();
            refreshedVersionRef.current = parsed.data.version?.trim() || latestVersion;
            void refreshAfterOpenCodeUpgrade(refreshedVersionRef.current).catch((error) => {
              console.error('[OpenCodeUpdateSettings] Failed to refresh configuration after upgrade:', error);
            });
            setInstalledVersion(parsed.data.version?.trim() || latestVersion);
            setUpgradePhase('updated');
          } catch {
            if (upgradeRequestIdRef.current === requestId) {
              setUpgradePhase('update-error');
            }
          }
        }}
      >
        <Icon
          name={updateButtonIcon}
          className={isUpgradePending && upgradePhase !== 'queued' ? 'size-4 animate-spin' : 'size-4'}
        />
        {updateButtonLabel}
      </Button>
    </SettingsFieldRow>
  );
};
