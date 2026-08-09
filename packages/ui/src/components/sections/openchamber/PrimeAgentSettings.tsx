import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsFieldRow,
  SettingsInset,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const PrimeAgentSettings: React.FC = () => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const controlsDisabled = isLoading || isSaving;

  React.useEffect(() => {
    const abortController = new AbortController();
    void runtimeFetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: abortController.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const settings = (await response.json().catch(() => null)) as null | { primeAgentBinary?: unknown };
      if (typeof settings?.primeAgentBinary === 'string') {
        setValue(settings.primeAgentBinary.trim());
      }
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
    }).finally(() => {
      if (!abortController.signal.aborted) setIsLoading(false);
    });
    return () => abortController.abort();
  }, []);

  return (
    <SettingsSection title="Prime Agent">
      <div className="space-y-0.5">
        <SettingsFieldRow
          settingsItem="sessions.prime-agent-binary"
          label={t('settings.openchamber.primeAgent.field.binaryPath')}
          info={t('settings.openchamber.primeAgent.field.binaryPathInfo')}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="/path/to/prime-agent"
            disabled={controlsDisabled}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={controlsDisabled || !isDesktopShell()}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t('settings.openchamber.primeAgent.actions.browseAria')}
            title={t('settings.openchamber.opencodeCli.actions.browse')}
            onClick={async () => {
              const selected = await requestFileAccess().catch(() => null);
              if (selected?.success && selected.path?.trim()) setValue(selected.path.trim());
            }}
          >
            <Icon name="folder" className="h-4 w-4" />
          </Button>
        </SettingsFieldRow>

        <SettingsInset>
          <div className="flex justify-start py-1.5">
            <Button
              type="button"
              size="xs"
              disabled={controlsDisabled}
              className="shrink-0 !font-normal"
              onClick={async () => {
                setIsSaving(true);
                try {
                  const trimmed = value.trim();
                  const unquoted = trimmed.length >= 2
                    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
                      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
                    ? trimmed.slice(1, -1).trim()
                    : trimmed;
                  await updateDesktopSettings({ primeAgentBinary: unquoted });
                } finally {
                  setIsSaving(false);
                }
              }}
            >
              {isSaving
                ? t('settings.common.actions.saving')
                : t('settings.openchamber.primeAgent.actions.save')}
            </Button>
          </div>
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
