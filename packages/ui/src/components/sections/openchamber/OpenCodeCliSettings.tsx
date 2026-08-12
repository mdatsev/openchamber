import * as React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isWindowsArm64 } from '@/lib/platform';
import { toast } from '@/components/ui';

const openCodeUpgradeStatusSchema = z.object({
  available: z.boolean().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
  upgrade: z.object({
    supported: z.boolean().nullable().optional(),
    reason: z.string().nullable().optional(),
  }).nullable().optional(),
});

const openCodeUpgradeResultSchema = z.object({
  success: z.boolean().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

type OpenCodeUpgradePhase = 'checking' | 'ready' | 'updating' | 'updated' | 'check-error' | 'update-error';

export const OpenCodeCliSettings: React.FC = () => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [upgradePhase, setUpgradePhase] = React.useState<OpenCodeUpgradePhase>('checking');
  const [upgradeStatus, setUpgradeStatus] = React.useState<z.infer<typeof openCodeUpgradeStatusSchema> | null>(null);
  const [installedVersion, setInstalledVersion] = React.useState('');
  const upgradeRequestIdRef = React.useRef(0);
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const setShowOpenCodeUpdateNotifications = useUIStore((state) => state.setShowOpenCodeUpdateNotifications);
  const agentControlToolEnabled = useUIStore((state) => state.agentControlToolEnabled);
  const setAgentControlToolEnabled = useUIStore((state) => state.setAgentControlToolEnabled);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json().catch(() => null)) as null | { opencodeBinary?: unknown };
        if (cancelled || !data) {
          return;
        }
        const next = typeof data.opencodeBinary === 'string' ? data.opencodeBinary.trim() : '';
        setValue(next);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForOpenCodeUpdate = React.useCallback(async () => {
    const requestId = ++upgradeRequestIdRef.current;
    setUpgradePhase('checking');
    setInstalledVersion('');

    try {
      const response = await runtimeFetch('/api/opencode/upgrade-status', {
        headers: { Accept: 'application/json' },
      });
      const parsed = openCodeUpgradeStatusSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error('Invalid OpenCode upgrade status');
      if (upgradeRequestIdRef.current !== requestId) return;

      setUpgradeStatus(parsed.data);
      setUpgradePhase('ready');
    } catch {
      if (upgradeRequestIdRef.current !== requestId) return;
      setUpgradeStatus(null);
      setUpgradePhase('check-error');
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

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!isDesktopShell()) {
      return;
    }

    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setValue(selected.path.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSaveAndReload = React.useCallback(async () => {
    setIsSaving(true);
    try {
      // Strip a wrapping quote pair (Windows "Copy as path" pastes) — literal
      // quotes are never part of a real path.
      const trimmed = value.trim();
      const unquoted = trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
          || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
      await updateDesktopSettings({ opencodeBinary: unquoted });
      recordDeferredOpenCodeRestart('cli', { id: 'opencode-binary' });
      toast.success(t('settings.view.pendingRestart.saved'));
    } finally {
      setIsSaving(false);
    }
  }, [t, value]);

  const handleShowUpdateNotificationsChange = React.useCallback((enabled: boolean) => {
    setShowOpenCodeUpdateNotifications(enabled);
    void updateDesktopSettings({ showOpenCodeUpdateNotifications: enabled });
  }, [setShowOpenCodeUpdateNotifications]);

  const handleAgentControlToolChange = React.useCallback((enabled: boolean) => {
    setAgentControlToolEnabled(enabled);
    void updateDesktopSettings({ agentControlToolEnabled: enabled });
  }, [setAgentControlToolEnabled]);

  const latestVersion = upgradeStatus?.latestVersion?.trim() ?? '';
  const updateAvailable = upgradePhase !== 'updated'
    && upgradeStatus?.upgrade?.supported === true
    && upgradeStatus.available === true
    && latestVersion.length > 0;
  let updateDescription = t('settings.openchamber.opencodeCli.state.updateUnavailable');
  if (upgradePhase === 'checking') {
    updateDescription = t('settings.openchamber.about.state.checking');
  } else if (upgradePhase === 'updating') {
    updateDescription = t('opencodeUpdate.toast.upgrading.title');
  } else if (upgradePhase === 'updated') {
    updateDescription = t('opencodeUpdate.toast.updated.descriptionWithVersion', { version: installedVersion || latestVersion });
  } else if (upgradePhase === 'check-error') {
    updateDescription = t('settings.openchamber.opencodeCli.state.checkFailed');
  } else if (upgradePhase === 'update-error') {
    updateDescription = t('opencodeUpdate.toast.failed.title');
  } else if (updateAvailable) {
    updateDescription = t('opencodeUpdate.toast.available.description', { version: latestVersion });
  } else if (upgradeStatus?.upgrade?.supported === true) {
    updateDescription = t('settings.openchamber.about.toast.latestVersion');
  }

  let updateButtonLabel = t('settings.openchamber.about.actions.checkForUpdates');
  if (upgradePhase === 'checking') {
    updateButtonLabel = t('settings.openchamber.about.state.checking');
  } else if (upgradePhase === 'updating') {
    updateButtonLabel = t('opencodeUpdate.toast.upgrading.title');
  } else if (upgradePhase === 'updated') {
    updateButtonLabel = t('opencodeUpdate.toast.actions.reload');
  } else if (updateAvailable) {
    updateButtonLabel = t('opencodeUpdate.toast.actions.update');
  }

  const isUpgradePending = upgradePhase === 'checking' || upgradePhase === 'updating';
  let updateButtonIcon: 'loader' | 'download' | 'refresh' = 'refresh';
  if (isUpgradePending) {
    updateButtonIcon = 'loader';
  } else if (updateAvailable) {
    updateButtonIcon = 'download';
  }

  return (
    <SettingsSection title={t('settings.openchamber.opencodeCli.title')}>
      <div className="space-y-0.5">
        <SettingsFieldRow
          settingsItem="sessions.opencode-binary"
          label={t('settings.openchamber.opencodeCli.field.binaryPath')}
          info={(
            <>
              {t('settings.openchamber.opencodeCli.tipPrefix')}
              {' '}
              <span className="font-mono">OPENCODE_BINARY</span>
              {' '}
              {t('settings.openchamber.opencodeCli.tipMiddle')}
              {' '}
              <span className="font-mono">~/.config/openchamber/settings.json</span>
              {'.'}
            </>
          )}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('settings.openchamber.opencodeCli.field.binaryPathPlaceholder')}
            disabled={isLoading || isSaving}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleBrowse}
            disabled={isLoading || isSaving || !isDesktopShell()}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t('settings.openchamber.opencodeCli.actions.browseAria')}
            title={t('settings.openchamber.opencodeCli.actions.browse')}
          >
            <Icon name="folder" className="h-4 w-4" />
          </Button>
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.opencode-update"
          label={t('settings.openchamber.opencodeCli.field.update')}
          description={updateDescription}
          info={t('settings.openchamber.opencodeCli.field.updateInfo')}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Button
            type="button"
            variant={updateAvailable || upgradePhase === 'updated' ? 'default' : 'outline'}
            size="xs"
            disabled={isUpgradePending}
            className="shrink-0 !font-normal"
            onClick={async () => {
              if (upgradePhase === 'updated') {
                const { reloadOpenCodeConfiguration } = await import('@/stores/useAgentsStore');
                await reloadOpenCodeConfiguration({
                  message: t('opencodeUpdate.toast.reload.message'),
                  mode: 'projects',
                  scopes: ['all'],
                });
                return;
              }

              if (!updateAvailable) {
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
              className={isUpgradePending ? 'size-4 animate-spin' : 'size-4'}
            />
            {updateButtonLabel}
          </Button>
        </SettingsFieldRow>

        <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
          {!isWindowsArm64() && (
            <SettingsCheckboxRow
              settingsItem="sessions.opencode-update-notifications"
              checked={showOpenCodeUpdateNotifications}
              onChange={handleShowUpdateNotificationsChange}
              label={t('settings.openchamber.opencodeCli.field.showUpdateNotifications')}
              ariaLabel={t('settings.openchamber.opencodeCli.field.showUpdateNotificationsAria')}
            />
          )}

          <SettingsCheckboxRow
            settingsItem="sessions.agent-control-tool"
            checked={agentControlToolEnabled}
            onChange={handleAgentControlToolChange}
            label={t('settings.openchamber.opencodeCli.field.agentControlTool')}
            ariaLabel={t('settings.openchamber.opencodeCli.field.agentControlToolAria')}
            info={t('settings.openchamber.opencodeCli.field.agentControlToolInfo')}
          />

          <div className="flex justify-start py-1.5">
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndReload}
              disabled={isLoading || isSaving}
              className="shrink-0 !font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
