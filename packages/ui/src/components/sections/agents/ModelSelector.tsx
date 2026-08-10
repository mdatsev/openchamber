import React from 'react';

import {
    ControlledModelSelector,
    type ControlledModelSelectorLabels,
} from '@/components/model-picker/ControlledModelSelector';
import type { ModelPickerEntry, ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { useModelLists } from '@/hooks/useModelLists';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string) => void;
    className?: string;
    allowedProviderIds?: string[];
    isModelAllowed?: (providerId: string, modelId: string) => boolean;
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
    /**
     * Drop the model name and the chevron, leaving the provider logo. For
     * headers that run out of room before they run out of controls — the logo
     * still says which provider is answering, which is the part a glance is
     * usually after.
     */
    compact?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    onChange,
    className,
    allowedProviderIds,
    isModelAllowed,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
    compact = false,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const providers = useConfigStore((state) => state.providers) as ModelPickerProvider[];
    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isMobile = uiIsMobile || deviceIsMobile;

    const labels = React.useMemo<ControlledModelSelectorLabels>(() => ({
        title: t('settings.agents.modelSelector.title'),
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        loading: t('common.loading'),
        unavailable: t('common.unavailable'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [placeholder, t]);

    const selectedModel = providerId && modelId ? { providerID: providerId, modelID: modelId } : null;
    const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
        onChange(entry.providerID, entry.modelID);
        addRecentModel(entry.providerID, entry.modelID);
    }, [addRecentModel, onChange]);

    return (
        <ControlledModelSelector
            providers={providers}
            modelsMetadata={modelsMetadata}
            selectedModel={selectedModel}
            onSelect={handleSelect}
            labels={labels}
            placeholder={placeholder}
            status={isReady ? 'ready' : isUnavailable ? 'unavailable' : 'loading'}
            mobile={isMobile}
            compact={compact}
            className={className}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            hiddenModels={hiddenModels}
            providerOrder={providerOrder}
            allowedProviderIds={allowedProviderIds}
            isModelAllowed={isModelAllowed}
            includeNotSelected
            onSelectNone={() => onChange('', '')}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
            tooltipsEnabled={tooltipsEnabled}
            dropdownPortalToBody={dropdownPortalToBody}
        />
    );
};
