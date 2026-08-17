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
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;
declare const __APP_DIRTY__: boolean | undefined;

const runtimeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const identitySchema = z.object({
  commit: z.string().nullable(),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  tags: z.array(z.string()),
  branch: z.string().nullable(),
  dirty: z.boolean().nullable(),
  startedAt: z.string().optional(),
  error: runtimeErrorSchema.nullable(),
});

const comparisonSchema = z.object({
  state: z.enum(['current', 'ahead', 'behind', 'diverged', 'unknown']),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  error: runtimeErrorSchema.nullable(),
});

const forkOperationSchema = z.object({
  phase: z.enum(['idle', 'checking', 'preparing', 'installing', 'building', 'applying', 'ready', 'failed']),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
  from: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  changed: z.boolean().optional(),
  prepared: z.boolean().optional(),
  alreadyCurrent: z.boolean().optional(),
  error: runtimeErrorSchema.optional(),
  logs: z.array(z.object({
    at: z.string(),
    phase: z.string(),
    message: z.string(),
  })).optional(),
});

const forkStatusSchema = z.object({
  running: identitySchema,
  checkout: identitySchema,
  custom: z.object({
    branch: z.string(),
    latestCommit: z.string().nullable(),
    latestVersion: z.string().nullable(),
    checkedAt: z.string(),
    lastSuccessfulAt: z.string().nullable(),
    stale: z.boolean(),
    error: runtimeErrorSchema.nullable(),
    runningComparison: comparisonSchema,
    checkoutComparison: comparisonSchema,
  }),
  official: z.object({
    latestVersion: z.string().nullable(),
    releaseUrl: z.string().nullable(),
    checkedAt: z.string(),
    lastSuccessfulAt: z.string().nullable(),
    stale: z.boolean(),
    error: runtimeErrorSchema.nullable(),
  }),
  checkedAt: z.string(),
  capabilities: z.object({
    restart: z.object({ supported: z.boolean() }),
    update: z.object({
      supported: z.boolean(),
      unsupportedReason: runtimeErrorSchema.nullable(),
      blocked: z.boolean(),
      blockReason: runtimeErrorSchema.nullable(),
      canUpdate: z.boolean(),
    }),
  }),
  operation: forkOperationSchema,
});

const updateResultSchema = z.object({
  accepted: z.boolean(),
  code: z.string().optional(),
  error: z.string().optional(),
  operation: forkOperationSchema.optional(),
});

const restartResultSchema = z.object({ ok: z.literal(true) });

type ForkStatus = z.infer<typeof forkStatusSchema>;
type Comparison = z.infer<typeof comparisonSchema>;
type ForkOperation = z.infer<typeof forkOperationSchema>;

const POLL_INTERVAL_MS = 2_000;
const RESTART_POLL_INTERVAL_MS = 1_000;
const RESTART_TIMEOUT_MS = 60_000;
const ACTIVE_UPDATE_PHASES = new Set<ForkOperation['phase']>([
  'checking',
  'preparing',
  'installing',
  'building',
  'applying',
]);
const OPERATION_MESSAGE_KEYS = {
  checking: 'settings.fork.runtime.openchamber.operation.checking',
  preparing: 'settings.fork.runtime.openchamber.operation.preparing',
  installing: 'settings.fork.runtime.openchamber.operation.installing',
  building: 'settings.fork.runtime.openchamber.operation.building',
  applying: 'settings.fork.runtime.openchamber.operation.applying',
  ready: 'settings.fork.runtime.openchamber.operation.ready',
  failed: 'settings.fork.runtime.openchamber.operation.failed',
} as const;

const shortCommit = (commit: string | null | undefined) => commit ? commit.slice(0, 12) : null;

export const OpenChamberRuntimeSettings: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<ForkStatus | null>(null);
  const [isChecking, setIsChecking] = React.useState(true);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);

  const fetchStatus = React.useCallback(async (force = false) => {
    const response = await runtimeFetch(`/api/openchamber/fork/status${force ? '?refresh=true' : ''}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const parsed = forkStatusSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) throw new Error('Invalid fork runtime status response');
    return parsed.data;
  }, []);

  const loadStatus = React.useCallback(async (force = false, showChecking = false) => {
    const requestId = ++requestIdRef.current;
    if (showChecking) setIsChecking(true);
    try {
      const nextStatus = await fetchStatus(force);
      if (requestIdRef.current !== requestId) return;
      setStatus(nextStatus);
      setActionError(null);
    } catch {
      if (requestIdRef.current === requestId) {
        setActionError(t('settings.fork.runtime.loadFailed'));
      }
    } finally {
      if (requestIdRef.current === requestId) setIsChecking(false);
    }
  }, [fetchStatus, t]);

  React.useEffect(() => {
    void loadStatus(false, true);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      setStatus(null);
      void loadStatus(false, true);
    });
    return () => {
      requestIdRef.current += 1;
      unsubscribe();
    };
  }, [loadStatus]);

  const operation = status?.operation;
  const updateActive = operation ? ACTIVE_UPDATE_PHASES.has(operation.phase) : false;

  React.useEffect(() => {
    if (!updateActive) return;
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
  }, [loadStatus, operation?.phase, updateActive]);

  const startUpdate = async (rebuildCurrent: boolean) => {
    setActionError(null);
    try {
      const response = await runtimeFetch('/api/openchamber/fork/update', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: rebuildCurrent ? 'rebuild-current' : 'update' }),
      });
      const parsed = updateResultSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success || !parsed.data.accepted) {
        throw new Error(parsed.success ? parsed.data.error : undefined);
      }
      await loadStatus();
    } catch (error) {
      setActionError(error instanceof Error && error.message
        ? error.message
        : t('settings.fork.runtime.actionFailed'));
    }
  };

  const restartOpenChamber = async () => {
    if (!status) return;
    setIsRestarting(true);
    setActionError(null);
    try {
      const response = await runtimeFetch('/api/system/restart', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const parsed = restartResultSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error();

      const runtimeKey = getRuntimeKey();
      const previousStartedAt = status.running.startedAt;
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
        if (getRuntimeKey() !== runtimeKey) return;
        try {
          const nextStatus = await fetchStatus();
          if (nextStatus.running.startedAt !== previousStartedAt) {
            window.location.reload();
            return;
          }
        } catch {
          // The managed service is expected to be unavailable during restart.
        }
      }
      setActionError(t('settings.fork.restart.timeout'));
    } catch {
      setActionError(t('settings.fork.restart.failed'));
    } finally {
      setIsRestarting(false);
    }
  };

  const formatTime = (value: string | undefined | null) => {
    if (!value) return t('settings.fork.runtime.unknown');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  const renderComparison = (comparison: Comparison | undefined) => {
    if (!comparison || comparison.state === 'unknown') {
      return <div>{t('settings.fork.runtime.comparisonUnknown')}</div>;
    }
    if (comparison.state === 'current') {
      return <div>{t('settings.fork.runtime.current')}</div>;
    }
    return (
      <>
        <div>{t('settings.fork.runtime.ahead', { count: comparison.ahead ?? 0 })}</div>
        <div>{t('settings.fork.runtime.behind', { count: comparison.behind ?? 0 })}</div>
        {comparison.state === 'diverged' && <div>{t('settings.fork.runtime.diverged')}</div>}
      </>
    );
  };

  const loadedUiVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  const rawLoadedUiCommit = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : null;
  const loadedUiCommit = rawLoadedUiCommit && rawLoadedUiCommit !== 'unknown' ? rawLoadedUiCommit : null;
  const loadedUiDirty = typeof __APP_DIRTY__ !== 'undefined' ? __APP_DIRTY__ : null;
  const runningCommit = status?.running.commit;
  const checkoutCommit = status?.checkout.commit;
  const loadedUiMismatch = Boolean(loadedUiCommit && runningCommit && loadedUiCommit !== runningCommit);
  const checkoutNeedsRestart = Boolean(checkoutCommit && runningCommit && checkoutCommit !== runningCommit);
  const preparedUpdate = operation?.phase === 'ready' && operation.prepared === true;
  const restartAppliesChanges = checkoutNeedsRestart || preparedUpdate;
  const hasCustomUpdate = status?.custom.checkoutComparison.state === 'behind'
    && status.custom.checkoutComparison.ahead === 0
    && (status.custom.checkoutComparison.behind ?? 0) > 0;
  const checkoutIsCanonicalCurrent = status?.custom.checkoutComparison.state === 'current';
  const canRebuildCurrent = checkoutIsCanonicalCurrent
    && loadedUiMismatch
    && !restartAppliesChanges;
  const canUpdate = status?.capabilities.update.canUpdate === true
    && (hasCustomUpdate || canRebuildCurrent)
    && !updateActive
    && !preparedUpdate;
  const updateBlock = status?.capabilities.update.unsupportedReason
    || status?.capabilities.update.blockReason;
  let updateActionLabel: string;
  if (canRebuildCurrent) {
    updateActionLabel = t('settings.fork.runtime.openchamber.rebuildAction');
  } else if (checkoutIsCanonicalCurrent) {
    updateActionLabel = t('settings.openchamber.about.state.upToDate');
  } else {
    updateActionLabel = t('settings.fork.runtime.openchamber.updateAction');
  }

  let updateDescription: string;
  if (updateBlock) {
    updateDescription = `${updateBlock.code}: ${updateBlock.message}`;
  } else if (canRebuildCurrent) {
    updateDescription = t('settings.fork.runtime.openchamber.rebuildDescription');
  } else if (hasCustomUpdate) {
    updateDescription = t('settings.fork.runtime.openchamber.updateDescription');
  } else if (checkoutIsCanonicalCurrent) {
    updateDescription = t('settings.fork.runtime.openchamber.sourceCurrent');
  } else {
    updateDescription = t('settings.fork.runtime.openchamber.noUpdate');
  }

  let operationLabel = t('settings.fork.runtime.operation.idle');
  let operationTone: 'default' | 'success' | 'warning' | 'error' = 'default';
  if (operation && operation.phase !== 'idle') {
    operationLabel = t(OPERATION_MESSAGE_KEYS[operation.phase]);
    if (operation.phase === 'failed') {
      operationTone = 'error';
    } else if (operation.phase === 'ready') {
      operationTone = 'success';
    } else {
      operationTone = 'warning';
    }
  }

  const operationDetails = operation && operation.phase !== 'idle' ? (
    <>
      {operation.from && <div>{t('settings.fork.runtime.operation.from', { commit: operation.from.slice(0, 12) })}</div>}
      {operation.target && <div>{t('settings.fork.runtime.operation.target', { commit: operation.target.slice(0, 12) })}</div>}
      {operation.updatedAt && <div>{t('settings.fork.runtime.operation.updatedAt', { time: formatTime(operation.updatedAt) })}</div>}
      {operation.error && <div className="text-[var(--status-error)]">{operation.error.code}: {operation.error.message}</div>}
      {operation.logs?.map((entry, index) => (
        <div key={`${entry.at}-${entry.phase}-${index}`} className="font-mono typography-micro">
          {formatTime(entry.at)} [{entry.phase}] {entry.message}
        </div>
      ))}
    </>
  ) : null;

  return (
    <SettingsControlGroup
      title={t('settings.fork.runtime.openchamber.title')}
      description={t('settings.fork.runtime.openchamber.description')}
      settingsItem="fork.runtime-openchamber"
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      <SettingsFieldRow
        settingsItem="fork.openchamber-refresh"
        label={t('settings.fork.runtime.status.label')}
        description={status
          ? t('settings.fork.runtime.status.checkedAt', { time: formatTime(status.checkedAt) })
          : t('settings.fork.runtime.status.notChecked')}
        alignEnd={false}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isChecking || updateActive || isRestarting}
          onClick={() => void loadStatus(true, true)}
        >
          <Icon name={isChecking ? 'loader-4' : 'refresh'} className={isChecking ? 'size-4 animate-spin' : 'size-4'} />
          {isChecking ? t('settings.fork.runtime.checking') : t('settings.fork.runtime.refresh')}
        </Button>
      </SettingsFieldRow>
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-running"
        label={t('settings.fork.runtime.openchamber.running')}
        value={shortCommit(runningCommit) || (isChecking ? t('settings.fork.runtime.checking') : t('settings.fork.runtime.unknown'))}
        details={status && (
          <>
            <div>{t('settings.fork.runtime.release', { version: status.running.version || t('settings.fork.runtime.unknown') })}</div>
            <div>{t('settings.fork.runtime.tag', { tag: status.running.tag || t('settings.fork.runtime.none') })}</div>
            <div>{t('settings.fork.runtime.branch', { branch: status.running.branch || t('settings.fork.runtime.unknown') })}</div>
            <div>{status.running.dirty == null
              ? t('settings.fork.runtime.unknown')
              : status.running.dirty
                ? t('settings.fork.runtime.dirty')
                : t('settings.fork.runtime.clean')}</div>
            <div>{t('settings.fork.runtime.startedAt', { time: formatTime(status.running.startedAt) })}</div>
            {renderComparison(status.custom.runningComparison)}
            {status.running.error && <div className="text-[var(--status-error)]">{status.running.error.code}: {status.running.error.message}</div>}
          </>
        )}
        tone={status?.running.error ? 'error' : restartAppliesChanges ? 'warning' : 'success'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-loaded-ui"
        label={t('settings.fork.runtime.openchamber.loadedUi')}
        value={shortCommit(loadedUiCommit) || t('settings.fork.runtime.unknown')}
        details={
          <>
            <div>{t('settings.fork.runtime.release', { version: loadedUiVersion || t('settings.fork.runtime.unknown') })}</div>
            <div>{loadedUiMismatch
              ? t('settings.fork.runtime.openchamber.loadedUiMismatch')
              : t('settings.fork.runtime.openchamber.loadedUiMatches')}</div>
            <div>{loadedUiDirty == null
              ? t('settings.fork.runtime.unknown')
              : loadedUiDirty
                ? t('settings.fork.runtime.openchamber.loadedUiDirty')
                : t('settings.fork.runtime.openchamber.loadedUiClean')}</div>
          </>
        }
        tone={loadedUiMismatch || loadedUiDirty ? 'warning' : loadedUiCommit ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-checkout"
        label={t('settings.fork.runtime.openchamber.checkout')}
        value={shortCommit(checkoutCommit) || t('settings.fork.runtime.unknown')}
        details={status && (
          <>
            <div>{t('settings.fork.runtime.release', { version: status.checkout.version || t('settings.fork.runtime.unknown') })}</div>
            <div>{t('settings.fork.runtime.tag', { tag: status.checkout.tag || t('settings.fork.runtime.none') })}</div>
            <div>{t('settings.fork.runtime.branch', { branch: status.checkout.branch || t('settings.fork.runtime.unknown') })}</div>
            <div>{status.checkout.dirty == null
              ? t('settings.fork.runtime.unknown')
              : status.checkout.dirty
                ? t('settings.fork.runtime.dirty')
                : t('settings.fork.runtime.clean')}</div>
            {renderComparison(status.custom.checkoutComparison)}
            {checkoutNeedsRestart && <div>{t('settings.fork.runtime.openchamber.restartRequired')}</div>}
            {status.checkout.error && <div className="text-[var(--status-error)]">{status.checkout.error.code}: {status.checkout.error.message}</div>}
          </>
        )}
        tone={status?.checkout.error ? 'error' : checkoutNeedsRestart ? 'warning' : 'success'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-custom-upstream"
        label={t('settings.fork.runtime.openchamber.customUpstream')}
        value={shortCommit(status?.custom.latestCommit) || t('settings.fork.runtime.unavailable')}
        details={status && (
          <>
            <div>{t('settings.fork.runtime.release', { version: status.custom.latestVersion || t('settings.fork.runtime.unknown') })}</div>
            <div>{t('settings.fork.runtime.branch', { branch: status.custom.branch })}</div>
            <div>{t('settings.fork.runtime.status.checkedAt', { time: formatTime(status.custom.checkedAt) })}</div>
            {status.custom.stale && <div>{t('settings.fork.runtime.stale')}</div>}
            {status.custom.error && <div className="text-[var(--status-error)]">{status.custom.error.code}: {status.custom.error.message}</div>}
          </>
        )}
        tone={status?.custom.error ? 'error' : status?.custom.stale ? 'warning' : status?.custom.latestCommit ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-official-release"
        label={t('settings.fork.runtime.openchamber.officialRelease')}
        value={status?.official.latestVersion || t('settings.fork.runtime.unavailable')}
        details={status && (
          <>
            <div>{t('settings.fork.runtime.status.checkedAt', { time: formatTime(status.official.checkedAt) })}</div>
            {status.official.releaseUrl && (
              <a className="break-all text-foreground underline" href={status.official.releaseUrl} target="_blank" rel="noreferrer">
                {status.official.releaseUrl}
              </a>
            )}
            {status.official.stale && <div>{t('settings.fork.runtime.stale')}</div>}
            {status.official.error && <div className="text-[var(--status-error)]">{status.official.error.code}: {status.official.error.message}</div>}
          </>
        )}
        tone={status?.official.error ? 'error' : status?.official.latestVersion ? 'success' : 'warning'}
      />
      <SettingsReadOnlyRow
        settingsItem="fork.openchamber-operation"
        label={t('settings.fork.runtime.operation.label')}
        value={operationLabel}
        details={operationDetails}
        mono={false}
        tone={operationTone}
        live
      />
      <SettingsFieldRow
        settingsItem="fork.update-openchamber"
        label={t('settings.fork.runtime.openchamber.deployment')}
        description={updateDescription}
        alignEnd={false}
      >
        <Button
          type="button"
          size="sm"
          disabled={!canUpdate || isChecking || isRestarting}
          onClick={() => void startUpdate(canRebuildCurrent)}
        >
          <Icon
            name={updateActive ? 'loader-4' : canRebuildCurrent ? 'tools' : checkoutIsCanonicalCurrent ? 'check' : 'download'}
            className={updateActive ? 'size-4 animate-spin' : 'size-4'}
          />
          {updateActive ? operationLabel : updateActionLabel}
        </Button>
      </SettingsFieldRow>
      <SettingsFieldRow
        settingsItem="fork.restart-openchamber"
        label={t('settings.fork.restart.label')}
        description={restartAppliesChanges
          ? t('settings.fork.runtime.openchamber.restartApplyDescription')
          : t('settings.fork.restart.info')}
        alignEnd={false}
      >
        <Button
          type="button"
          variant={restartAppliesChanges ? 'default' : 'outline'}
          size="sm"
          disabled={isChecking || isRestarting || updateActive || status?.capabilities.restart.supported !== true}
          onClick={() => void restartOpenChamber()}
        >
          <Icon name={isRestarting ? 'loader-4' : 'restart'} className={isRestarting ? 'size-4 animate-spin' : 'size-4'} />
          {isRestarting ? t('settings.fork.restart.restarting') : t('settings.fork.restart.action')}
        </Button>
      </SettingsFieldRow>
      {actionError && (
        <p className="typography-meta text-[var(--status-error)]" role="alert">{actionError}</p>
      )}
    </SettingsControlGroup>
  );
};
