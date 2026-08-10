import React from 'react';

import {
  ControlledModelSelector,
  type ControlledModelSelectorLabels,
} from '@/components/model-picker/ControlledModelSelector';
import type { ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import type { PrimeModel, PrimeSessionControls, PrimeThinkingLevel } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { ControlledThinkingSelector } from './ControlledThinkingSelector';
import { formatEffortLabel, type MobileControlsPanel } from './mobileControlsUtils';
import {
  buildPrimeModelPickerCatalog,
  getNextPrimeThinkingLevel,
  getPrimeThinkingOptions,
  PRIME_CYCLE_THINKING_EVENT,
  PRIME_OPEN_MODEL_SELECTOR_EVENT,
  primeModelKey,
  type PrimeControlShortcutScope,
} from './primeControlModel';

interface PrimeControlSelectorsProps {
  controls: PrimeSessionControls;
  model: PrimeModel | null;
  thinkingLevel: PrimeThinkingLevel;
  disabled: boolean;
  shortcutScope: PrimeControlShortcutScope;
  className?: string;
  mobilePanel?: MobileControlsPanel;
  onMobilePanelChange?: (panel: MobileControlsPanel) => void;
  onRequestFocus?: () => void;
  onModelChange: (model: PrimeModel) => void;
  onThinkingLevelChange: (level: PrimeThinkingLevel) => void;
}

export function PrimeControlSelectors({
  controls,
  model,
  thinkingLevel,
  disabled,
  shortcutScope,
  className,
  mobilePanel,
  onMobilePanelChange,
  onRequestFocus,
  onModelChange,
  onThinkingLevelChange,
}: PrimeControlSelectorsProps) {
  const { t } = useI18n();
  const { isMobile: deviceIsMobile } = useDeviceInfo();
  const uiIsMobile = useUIStore((state) => state.isMobile);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const isMobile = deviceIsMobile || uiIsMobile;
  const catalog = React.useMemo(() => buildPrimeModelPickerCatalog(controls.models), [controls.models]);
  const thinkingOptions = React.useMemo(
    () => getPrimeThinkingOptions(model, controls.availableThinkingLevels),
    [controls.availableThinkingLevels, model],
  );
  const selectedModel = model ? { providerID: model.provider, modelID: model.id } : null;
  const usesExternalMobilePanel = isMobile && onMobilePanelChange !== undefined;

  React.useEffect(() => {
    const cycleThinking = (event: Event) => {
      if ((event as CustomEvent<{ scope?: PrimeControlShortcutScope }>).detail?.scope !== shortcutScope || disabled) return;
      const nextLevel = getNextPrimeThinkingLevel(thinkingOptions, thinkingLevel);
      if (nextLevel) onThinkingLevelChange(nextLevel);
    };
    window.addEventListener(PRIME_CYCLE_THINKING_EVENT, cycleThinking);
    return () => window.removeEventListener(PRIME_CYCLE_THINKING_EVENT, cycleThinking);
  }, [disabled, onThinkingLevelChange, shortcutScope, thinkingLevel, thinkingOptions]);

  const labels = React.useMemo<ControlledModelSelectorLabels>(() => ({
    title: t('chat.modelControls.selectModel'),
    searchPlaceholder: t('chat.modelControls.searchModels'),
    noResults: t('chat.modelControls.noModelsFound'),
    favorites: t('chat.modelControls.favorites'),
    recent: t('chat.modelControls.recent'),
    keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
    notSelected: t('chat.modelControls.selectModel'),
    loading: t('common.loading'),
    unavailable: t('common.unavailable'),
    capabilities: t('chat.modelControls.capabilities'),
    capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
    capabilityReasoning: t('chat.modelControls.capability.reasoning'),
    input: t('chat.modelControls.input'),
    output: t('chat.modelControls.output'),
    costPerMillion: t('chat.modelControls.costPerMillion'),
  }), [t]);

  const handleModelSelect = React.useCallback((entry: ModelPickerEntry) => {
    const selected = catalog.modelsByKey.get(primeModelKey(entry.providerID, entry.modelID));
    if (selected) onModelChange(selected);
  }, [catalog.modelsByKey, onModelChange]);

  const handleModelPickerOpenChange = React.useCallback((open: boolean) => {
    if (usesExternalMobilePanel) {
      onMobilePanelChange?.(open ? 'model' : null);
    } else {
      setModelSelectorOpen(open);
    }
  }, [onMobilePanelChange, usesExternalMobilePanel]);

  const handleThinkingPickerOpenChange = React.useCallback((open: boolean) => {
    if (usesExternalMobilePanel) onMobilePanelChange?.(open ? 'variant' : null);
  }, [onMobilePanelChange, usesExternalMobilePanel]);

  React.useEffect(() => {
    const toggleModelSelector = (event: Event) => {
      if ((event as CustomEvent<{ scope?: PrimeControlShortcutScope }>).detail?.scope !== shortcutScope || disabled) return;
      if (usesExternalMobilePanel) {
        onMobilePanelChange?.(mobilePanel === 'model' ? null : 'model');
      } else {
        setModelSelectorOpen((open) => !open);
      }
    };
    window.addEventListener(PRIME_OPEN_MODEL_SELECTOR_EVENT, toggleModelSelector);
    return () => window.removeEventListener(PRIME_OPEN_MODEL_SELECTOR_EVENT, toggleModelSelector);
  }, [disabled, mobilePanel, onMobilePanelChange, shortcutScope, usesExternalMobilePanel]);

  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <ControlledThinkingSelector
        value={thinkingLevel}
        options={thinkingOptions}
        onChange={(value) => onThinkingLevelChange(value as PrimeThinkingLevel)}
        title={t('chat.modelControls.thinking')}
        defaultLabel={t('chat.modelControls.default')}
        formatLabel={formatEffortLabel}
        includeDefault={false}
        disabled={disabled}
        mobile={isMobile}
        open={usesExternalMobilePanel ? mobilePanel === 'variant' : undefined}
        onOpenChange={handleThinkingPickerOpenChange}
        onRequestFocus={onRequestFocus}
      />
      {catalog.providers.length > 0 ? (
        <ControlledModelSelector
          providers={catalog.providers}
          modelsMetadata={catalog.metadata}
          selectedModel={selectedModel}
          onSelect={handleModelSelect}
          labels={labels}
          status="ready"
          disabled={disabled}
          mobile={isMobile}
          appearance="composer"
          open={usesExternalMobilePanel ? mobilePanel === 'model' : modelSelectorOpen}
          onOpenChange={handleModelPickerOpenChange}
          onRequestFocus={onRequestFocus}
          tooltipsEnabled
        />
      ) : null}
    </div>
  );
}
