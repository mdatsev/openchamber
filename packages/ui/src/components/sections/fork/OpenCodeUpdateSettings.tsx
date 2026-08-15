import * as React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsReadOnlyRow,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { usePendingOpenCodeRestartStore } from '@/stores/usePendingOpenCodeRestartStore';
import { refreshAfterOpenCodeUpgrade } from '@/stores/useAgentsStore';

const openCodeOperationSchema = z.object({
  kind: z.enum(['upgrade', 'restart']).optional(),
  phase: z.enum(['idle', 'queued', 'upgrading', 'restarting', 'updated', 'failed']),
  activeSessionCount: z.number().optional(),
  version: z.string().nullable().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
});

const openCodeStatusSchema = z.object({
  available: z.boolean().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  installedVersion: z.string().nullable().optional(),
  installedVersionError: z.string().optional(),
  latestVersion: z.string().nullable().optional(),
  error: z.string().optional(),
  upgrade: z.object({
    supported: z.boolean().nullable().optional(),
    manager: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }).nullable().optional(),
  operation: openCodeOperationSchema.optional(),
});

const operationResultSchema = z.object({
  success: z.boolean().optional(),
  queued: z.boolean().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

type OpenCodeStatus = z.infer<typeof openCodeStatusSchema>;
type OpenCodeOperation = z.infer<typeof openCodeOperationSchema>;

const POLL_INTERVAL_MS = 2_000;
const ACTIVE_PHASES = new Set<OpenCodeOperation['phase']>(['queued', 'upgrading', 'restarting']);

export const OpenCodeUpdateSettings: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<OpenCodeStatus | null>(null);
  const [isChecking, setIsChecking] = React.useState(true);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);
  const refreshTokenRef = React.useRef<string | null>(null);

  const loadStatus = React.useCallback(async (showChecking = false) => {
    const requestId = ++requestIdRef.current;
    if (showChecking) setIsChecking(true);
    try {
      const response = await runtimeFetch('/api/opencode/upgrade-status', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const parsed = openCodeStatusSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error('Invalid OpenCode status response');
      if (requestIdRef.current !== requestId) return;
      setStatus((previous) => ({
        ...parsed.data,
        latestVersion: parsed.data.latestVersion ?? previous?.latestVersion,
        installedVersion: Object.hasOwn(parsed.data, 'installedVersion')
          ? parsed.data.installedVersion
          : previous?.installedVersion,
      }));
      setActionError(null);
    } catch {
      if (requestIdRef.current === requestId) {
        setActionError(t('settings.fork.runtime.loadFailed'));
      }
    } finally {
      if (requestIdRef.current === requestId) setIsChecking(false);
    }
  }, [t]);

  React.useEffect(() => {
    void loadStatus(true);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      setStatus(null);
      void loadStatus(true);
    });
    return () => {
      requestIdRef.current += 1;
      unsubscribe();
    };
  }, [loadStatus]);

  const operation = status?.operation;
  const operationActive = operation ? ACTIVE_PHASES.has(operation.phase) : false;

  React.useEffect(() => {
    if (!operationActive) return;
    let cancelled = false;
    let timeout = 0;
    const poll = async () => {
      await loadStatus();
      if (!cancelled) timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [loadStatus, operationActive, operation?.phase]);

  React.useEffect(() => {
    if (!operation?.kind || operation.phase !== 'updated') return;
    const refreshToken = `${operation.kind}-${operation.completedAt?.toString() || operation.version || 'updated'}`;
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    usePendingOpenCodeRestartStore.getState().clear();
    void refreshAfterOpenCodeUpgrade(refreshToken).catch((error) => {
      console.error('[OpenCodeUpdateSettings] Failed to refresh configuration after upgrade:', error);
    });
  }, [operation]);

  const startOperation = async (kind: 'upgrade' | 'restart') => {
    setActionError(null);
    try {
      const response = await runtimeFetch(kind === 'upgrade' ? '/api/opencode/upgrade' : '/api/opencode/restart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(kind === 'upgrade' ? { body: JSON.stringify({}) } : {}),
      });
      const parsed = operationResultSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success || parsed.data.success === false) {
        throw new Error(parsed.success ? parsed.data.error : undefined);
      }
      if (kind === 'upgrade' && response.status !== 202) {
        usePendingOpenCodeRestartStore.getState().clear();
        const version = parsed.data.version?.trim() || status?.latestVersion?.trim() || 'updated';
        void refreshAfterOpenCodeUpgrade(version).catch((error) => {
          console.error('[OpenCodeUpdateSettings] Failed to refresh configuration after upgrade:', error);
        });
      }
      await loadStatus();
    } catch (error) {
      setActionError(error instanceof Error && error.message
        ? error.message
        : t('settings.fork.runtime.actionFailed'));
    }
  };

  const cancelOperation = async () => {
    setActionError(null);
    try {
      const response = await runtimeFetch('/api/opencode/upgrade/cancel', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error();
      await loadStatus();
    } catch {
      setActionError(t('settings.fork.runtime.cancelFailed'));
    }
  };

  const currentVersion = status?.currentVersion?.trim();
  const installedVersion = status?.installedVersion?.trim();
  const latestVersion = status?.latestVersion?.trim();
  const updateSupported = status?.upgrade?.supported === true;
  const restartSupported = updateSupported && status?.upgrade?.manager === 'systemd';
  const updateAvailable = updateSupported && status?.available === true && Boolean(latestVersion);
  const upgradeOperationActive = operationActive && operation?.kind === 'upgrade';
  const restartOperationActive = operationActive && operation?.kind === 'restart';

  let operationLabel = t('settings.fork.runtime.operation.idle');
  let operationTone: 'default' | 'success' | 'warning' | 'error' = 'default';
  if (operation?.phase === 'queued') {
    operationLabel = operation.kind === 'restart'
      ? t('settings.fork.runtime.opencode.operation.restartQueued')
      : t('settings.fork.runtime.opencode.operation.updateQueued');
    operationTone = 'warning';
  } else if (operation?.phase === 'upgrading') {
    operationLabel = t('settings.fork.runtime.opencode.operation.updating');
    operationTone = 'warning';
  } else if (operation?.phase === 'restarting') {
    operationLabel = t('settings.fork.runtime.opencode.operation.restarting');
    operationTone = 'warning';
  } else if (operation?.phase === 'updated') {
    operationLabel = operation.kind === 'restart'
      ? t('settings.fork.runtime.opencode.operation.restarted')
      : t('settings.fork.runtime.opencode.operation.updated');
    operationTone = 'success';
  } else if (operation?.phase === 'failed') {
    operationLabel = operation.error || t('settings.fork.runtime.operation.failed');
    operationTone = 'error';
  }

  let activeAgentDetail = null;
  if (operation?.activeSessionCount != null) {
    activeAgentDetail = operation.activeSessionCount === 1
      ? t('settings.fork.runtime.opencode.activeAgentSingle', { count: operation.activeSessionCount })
      : t('settings.fork.runtime.opencode.activeAgentPlural', { count: operation.activeSessionCount });
  }

  let updateDescription = t('settings.fork.runtime.opencode.updateUnsupported');
  if (updateAvailable) {
    updateDescription = t('settings.fork.runtime.opencode.updateAvailable', { version: latestVersion || '' });
  } else if (updateSupported) {
    updateDescription = t('settings.fork.runtime.opencode.noUpdate');
  }

  return (
    <SettingsControlGroup
      title={t('settings.fork.runtime.opencode.title')}
      description={t('settings.fork.runtime.opencode.description')}
      settingsItem="fork.runtime-opencode"
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      <SettingsReadOnlyRow
        settingsItem="fork.opencode-running"
        label={t('settings.fork.runtime.opencode.runningVersion')}
        value={currentVersion || (isChecking ? t('settings.fork.runtime.checking') : t('settings.fork.runtime.unknown'))}
        details={t('settings.fork.runtime.opencode.runningVersionDescription')}
        tone={currentVersion ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.opencode-installed"
        label={t('settings.fork.runtime.opencode.installedVersion')}
        value={installedVersion || t('settings.fork.runtime.unavailable')}
        details={status?.installedVersionError || t('settings.fork.runtime.opencode.installedVersionDescription')}
        tone={status?.installedVersionError ? 'error' : installedVersion ? 'default' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.opencode-latest"
        label={t('settings.fork.runtime.opencode.latestVersion')}
        value={latestVersion || (isChecking ? t('settings.fork.runtime.checking') : t('settings.fork.runtime.unavailable'))}
        details={status?.error || (status?.available === false && latestVersion
          ? t('settings.fork.runtime.opencode.latestInstalled')
          : t('settings.fork.runtime.opencode.latestVersionDescription'))}
        tone={status?.error ? 'error' : updateAvailable ? 'warning' : latestVersion ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.opencode-manager"
        label={t('settings.fork.runtime.opencode.manager')}
        value={status?.upgrade?.manager || t('settings.fork.runtime.unknown')}
        details={updateSupported
          ? t('settings.fork.runtime.opencode.managerSupported')
          : t('settings.fork.runtime.opencode.managerUnsupported')}
        tone={updateSupported ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.opencode-operation"
        label={t('settings.fork.runtime.operation.label')}
        value={operationLabel}
        details={activeAgentDetail}
        mono={false}
        tone={operationTone}
        live
      />
      <SettingsFieldRow
        settingsItem="sessions.opencode-update"
        label={t('settings.fork.runtime.opencode.updateAction')}
        description={updateDescription}
        alignEnd={false}
      >
        {operation?.phase === 'queued' && operation.kind === 'upgrade' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void cancelOperation()}>
            <Icon name="close" className="size-4" />
            {t('settings.common.actions.cancel')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={isChecking || operationActive || !updateAvailable}
            onClick={() => void startOperation('upgrade')}
          >
            <Icon name={upgradeOperationActive ? 'loader-4' : 'download'} className={upgradeOperationActive ? 'size-4 animate-spin' : 'size-4'} />
            {t('settings.fork.runtime.opencode.updateAction')}
          </Button>
        )}
      </SettingsFieldRow>
      <SettingsFieldRow
        settingsItem="fork.restart-opencode"
        label={t('settings.fork.runtime.opencode.restartAction')}
        description={restartSupported
          ? t('settings.fork.runtime.opencode.restartDescription')
          : t('settings.fork.runtime.opencode.restartUnsupported')}
        alignEnd={false}
      >
        {operation?.phase === 'queued' && operation.kind === 'restart' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void cancelOperation()}>
            <Icon name="close" className="size-4" />
            {t('settings.common.actions.cancel')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isChecking || operationActive || !restartSupported}
            onClick={() => void startOperation('restart')}
          >
            <Icon name={restartOperationActive ? 'loader-4' : 'restart'} className={restartOperationActive ? 'size-4 animate-spin' : 'size-4'} />
            {t('settings.fork.runtime.opencode.restartAction')}
          </Button>
        )}
      </SettingsFieldRow>
      {(actionError || operation?.error) && (
        <p className="typography-meta text-[var(--status-error)]" role="alert">
          {actionError || operation?.error}
        </p>
      )}
    </SettingsControlGroup>
  );
};
