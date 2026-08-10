import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PrimeModel, PrimeThinkingLevel } from '@/lib/api/types';
import type { ChatIdentity } from '@/lib/chat-identity';
import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  getPrimeLiveKey,
  usePrimeLiveStore,
} from '@/stores/usePrimeLiveStore';
import {
  loadPrimeDraftOptionsFromUserAction,
  usePrimeDraftSourceStore,
} from '@/stores/usePrimeDraftSourceStore';
import {
  getPrimeComposerKey,
  getPrimeDraftComposerKey,
  selectPrimeDraftComposerSnapshot,
  setPrimeDraftModel,
  setPrimeDraftThinkingLevel,
  setPrimeModel,
  setPrimeThinkingLevel,
  usePrimeComposerStore,
} from '@/stores/usePrimeComposerStore';
import type { ComposerModelControlsRenderProps } from './composer/controller/types';
import { formatEffortLabel } from './mobileControlsUtils';

const EMPTY_MODELS: PrimeModel[] = [];
const EMPTY_THINKING_LEVELS: PrimeThinkingLevel[] = [];

const modelLabel = (model: PrimeModel | undefined, fallback: string): string => (
  model?.name?.trim() || model?.id || fallback
);

const sameModel = (left: PrimeModel | null | undefined, right: PrimeModel): boolean => (
  left?.provider === right.provider && left.id === right.id
);

export const PrimeDraftMobileModelButton: React.FC<{
  identity: ChatDraftIdentity;
  onOpen: () => void;
}> = ({ identity, onOpen }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const composerKey = getPrimeDraftComposerKey(identity);
  const composer = usePrimeComposerStore((state) => (
    state.byKey.get(composerKey) ?? selectPrimeDraftComposerSnapshot(state, identity)
  ));
  const storedConfiguration = composer.draftConfiguration;
  const configurationIsFresh = usePrimeLiveStore((state) => {
    if (!storedConfiguration) return false;
    for (const live of state.byKey.values()) {
      const snapshot = live.snapshot;
      if (live.identity.runtimeKey === identity.runtimeKey
        && snapshot?.sessionId === storedConfiguration.sourceSessionId
        && snapshot.freshness.state === 'fresh'
        && snapshot.generation === storedConfiguration.sourceGeneration
        && snapshot.revision >= storedConfiguration.sourceRevision) return true;
    }
    return false;
  });
  const configuration = storedConfiguration?.selectedModel || configurationIsFresh
    ? storedConfiguration
    : null;
  const current = configuration?.selectedModel;
  const draftSourceKey = getChatDraftIdentityKey(identity);
  const loading = usePrimeDraftSourceStore((state) => state.loadingDraftKeys.has(draftSourceKey));
  const missingSource = usePrimeDraftSourceStore((state) => state.missingSourceDraftKeys.has(draftSourceKey));
  const enabled = composer.pendingAction === null;
  const handleClick = React.useCallback(() => {
    if (configuration) {
      onOpen();
      return;
    }
    if (!loading) {
      void loadPrimeDraftOptionsFromUserAction(identity, apis);
    }
  }, [apis, configuration, identity, loading, onOpen]);
  const label = current
    ? modelLabel(current, t('chat.modelControls.selectModel'))
    : configuration
      ? t('chat.primeDraft.modelControls.defaults')
      : loading
        ? t('chat.primeDraft.modelControls.loadingOptions')
        : t('chat.primeDraft.modelControls.loadOptions');
  return (
    <div className="flex min-w-0 flex-col items-end">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onPointerDownCapture={(event) => {
          if (event.pointerType === 'touch') event.preventDefault();
        }}
        onClick={handleClick}
        disabled={!enabled || loading}
        className="flex h-7 max-w-[70vw] items-center gap-1.5 rounded-lg px-2 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        aria-label={label}
      >
        {current ? <ProviderLogo providerId={current.provider} className="size-3.5" /> : null}
        <span className="truncate">{label}</span>
        {loading ? (
          <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
        ) : configuration ? (
          <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
        ) : (
          <Icon name="refresh" className="size-3.5 shrink-0" />
        )}
      </button>
      {missingSource && !configuration && !loading && (
        <span className="max-w-[70vw] px-2 text-right typography-meta leading-tight text-muted-foreground/70">
          {t('chat.primeDraft.modelControls.optionsRequireExistingSession')}
        </span>
      )}
    </div>
  );
};

export const PrimeDraftModelControls: React.FC<ComposerModelControlsRenderProps & {
  identity: ChatDraftIdentity;
}> = ({ identity, className, mobilePanel, onMobilePanelChange }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const composerKey = getPrimeDraftComposerKey(identity);
  const composer = usePrimeComposerStore((state) => (
    state.byKey.get(composerKey) ?? selectPrimeDraftComposerSnapshot(state, identity)
  ));
  const storedConfiguration = composer.draftConfiguration;
  const configurationIsFresh = usePrimeLiveStore((state) => {
    if (!storedConfiguration) return false;
    for (const live of state.byKey.values()) {
      const snapshot = live.snapshot;
      if (live.identity.runtimeKey === identity.runtimeKey
        && snapshot?.sessionId === storedConfiguration.sourceSessionId
        && snapshot.freshness.state === 'fresh'
        && snapshot.generation === storedConfiguration.sourceGeneration
        && snapshot.revision >= storedConfiguration.sourceRevision) return true;
    }
    return false;
  });
  const configuration = storedConfiguration?.selectedModel || configurationIsFresh
    ? storedConfiguration
    : null;
  const draftSourceKey = getChatDraftIdentityKey(identity);
  const loading = usePrimeDraftSourceStore((state) => state.loadingDraftKeys.has(draftSourceKey));
  const missingSource = usePrimeDraftSourceStore((state) => state.missingSourceDraftKeys.has(draftSourceKey));
  const models = configuration?.models ?? EMPTY_MODELS;
  const thinkingLevels = configuration?.thinkingLevels ?? EMPTY_THINKING_LEVELS;
  const currentModel = configuration?.selectedModel;
  const currentThinking = configuration?.selectedThinkingLevel ?? undefined;
  const enabled = Boolean(configuration && composer.pendingAction === null);
  const thinkingEnabled = Boolean(enabled
    && configuration?.selectedModel
    && sameModel(configuration.selectedModel, configuration.sourceCurrentModel));
  const [query, setQuery] = React.useState('');
  const filteredModels = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return models;
    return models.filter((model) => (
      `${model.provider} ${model.name ?? ''} ${model.id}`.toLocaleLowerCase().includes(normalized)
    ));
  }, [models, query]);

  const loadOptions = React.useCallback(() => {
    if (configuration || loading) return;
    void loadPrimeDraftOptionsFromUserAction(identity, apis);
  }, [apis, configuration, identity, loading]);

  const applyModel = React.useCallback((model: PrimeModel) => {
    if (!enabled || sameModel(currentModel, model)) return;
    setPrimeDraftModel(identity, model);
    onMobilePanelChange?.(null);
  }, [currentModel, enabled, identity, onMobilePanelChange]);

  const applyDefaults = React.useCallback(() => {
    if (!enabled || currentModel === null || currentModel === undefined) return;
    setPrimeDraftModel(identity, null);
    onMobilePanelChange?.(null);
  }, [currentModel, enabled, identity, onMobilePanelChange]);

  const applyThinking = React.useCallback((level: PrimeThinkingLevel) => {
    if (!thinkingEnabled || currentThinking === level) return;
    setPrimeDraftThinkingLevel(identity, level);
    onMobilePanelChange?.(null);
  }, [currentThinking, identity, onMobilePanelChange, thinkingEnabled]);

  const applyDefaultThinking = React.useCallback(() => {
    if (!thinkingEnabled || currentThinking === undefined) return;
    setPrimeDraftThinkingLevel(identity, null);
    onMobilePanelChange?.(null);
  }, [currentThinking, identity, onMobilePanelChange, thinkingEnabled]);

  const modelRows = (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={!enabled || currentModel === null || currentModel === undefined}
        onClick={applyDefaults}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-interactive-hover disabled:cursor-default',
          !currentModel && 'bg-interactive-hover/70',
        )}
        aria-pressed={!currentModel}
      >
        <Icon name="sparkling" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 typography-ui-label text-foreground">
          {t('chat.primeDraft.modelControls.defaults')}
        </span>
        {!currentModel ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
      </button>
      {filteredModels.map((model) => {
        const selected = sameModel(currentModel, model);
        return (
          <button
            key={`${model.provider}:${model.id}`}
            type="button"
            disabled={!enabled || selected}
            onClick={() => applyModel(model)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-interactive-hover disabled:cursor-default',
              selected && 'bg-interactive-hover/70',
            )}
            aria-pressed={selected}
          >
            <ProviderLogo providerId={model.provider} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate typography-ui-label text-foreground">
                {modelLabel(model, model.id)}
              </span>
              <span className="block truncate typography-meta text-muted-foreground">
                {model.provider} · {model.id}
              </span>
            </span>
            {selected ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );

  if (mobilePanel !== undefined) {
    return (
      <MobileOverlayPanel
        open={mobilePanel === 'model'}
        onClose={() => onMobilePanelChange?.(null)}
        title={t('chat.modelControls.selectModel')}
      >
        {configuration ? (
          <div className="flex flex-col gap-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('chat.modelControls.searchProvidersOrModels')}
              className="h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
            />
            <div className="max-h-[48vh] overflow-y-auto">{modelRows}</div>
            {thinkingLevels.length > 0 ? (
              <div className="border-t border-border/40 pt-3">
                <p className="mb-2 typography-meta font-medium text-muted-foreground">
                  {t('chat.modelControls.thinking')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!thinkingEnabled || currentThinking === undefined}
                    onClick={applyDefaultThinking}
                    className={cn(
                      'rounded-full border border-border/40 px-2.5 py-1 typography-meta text-muted-foreground',
                      currentThinking === undefined && 'border-primary/30 bg-primary/10 text-foreground',
                    )}
                    aria-pressed={currentThinking === undefined}
                  >
                    {t('chat.primeDraft.modelControls.primeDefaultThinking')}
                  </button>
                  {thinkingLevels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      disabled={!thinkingEnabled || currentThinking === level}
                      onClick={() => applyThinking(level)}
                      className={cn(
                        'rounded-full border border-border/40 px-2.5 py-1 typography-meta text-muted-foreground',
                        currentThinking === level && thinkingEnabled && 'border-primary/30 bg-primary/10 text-foreground',
                      )}
                      aria-pressed={thinkingEnabled && currentThinking === level}
                    >
                      {formatEffortLabel(level)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="typography-ui-label text-muted-foreground">
            {t('chat.primeDraft.modelControls.defaults')}
          </p>
        )}
      </MobileOverlayPanel>
    );
  }

  if (!configuration) {
    return (
      <div className={cn('flex min-w-0 flex-col items-end justify-end', className)}>
        <button
          type="button"
          disabled={loading || composer.pendingAction !== null}
          onClick={loadOptions}
          className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon
            name={loading ? 'loader-4' : 'refresh'}
            className={cn('size-3.5 shrink-0', loading && 'animate-spin')}
          />
          <span className="truncate">
            {t(loading
              ? 'chat.primeDraft.modelControls.loadingOptions'
              : 'chat.primeDraft.modelControls.loadOptions')}
          </span>
        </button>
        {missingSource && !loading && (
          <span className="max-w-80 px-1.5 text-right typography-meta leading-tight text-muted-foreground/70">
            {t('chat.primeDraft.modelControls.optionsRequireExistingSession')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!enabled || models.length === 0}
            className="flex h-6 min-w-0 max-w-52 items-center gap-1.5 rounded-md px-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
            aria-label={t('chat.modelControls.selectModel')}
          >
            {currentModel ? <ProviderLogo providerId={currentModel.provider} className="size-3.5 shrink-0" /> : null}
            <span className="truncate">
              {currentModel
                ? modelLabel(currentModel, t('chat.modelControls.selectModel'))
                : t('chat.primeDraft.modelControls.defaults')}
            </span>
            <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-1.5">
          <DropdownMenuLabel className="px-1 pb-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={t('chat.modelControls.searchProvidersOrModels')}
              className="h-8 typography-meta"
            />
          </DropdownMenuLabel>
          <div className="max-h-72 overflow-y-auto">
            <DropdownMenuItem
              disabled={!enabled || !currentModel}
              onSelect={applyDefaults}
              className="gap-2"
            >
              <Icon name="sparkling" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 typography-meta font-medium text-foreground">
                {t('chat.primeDraft.modelControls.defaults')}
              </span>
              {!currentModel ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {filteredModels.map((model) => {
              const selected = sameModel(currentModel, model);
              return (
                <DropdownMenuItem
                  key={`${model.provider}:${model.id}`}
                  disabled={!enabled || selected}
                  onSelect={() => applyModel(model)}
                  className="gap-2"
                >
                  <ProviderLogo providerId={model.provider} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate typography-meta font-medium text-foreground">
                      {modelLabel(model, model.id)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{model.provider}</span>
                  </span>
                  {selected ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
                </DropdownMenuItem>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {thinkingLevels.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={!thinkingEnabled}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              aria-label={t('chat.modelControls.thinking')}
            >
              <span>
                {thinkingEnabled && currentThinking
                  ? formatEffortLabel(currentThinking)
                  : t('chat.primeDraft.modelControls.primeDefaultThinking')}
              </span>
              <Icon name="arrow-down-s" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('chat.modelControls.thinking')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!thinkingEnabled || currentThinking === undefined}
              onSelect={applyDefaultThinking}
            >
              <span className="flex-1">{t('chat.primeDraft.modelControls.primeDefaultThinking')}</span>
              {currentThinking === undefined ? <Icon name="check" className="size-4 text-primary" /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {thinkingLevels.map((level) => (
              <DropdownMenuItem
                key={level}
                disabled={!thinkingEnabled || currentThinking === level}
                onSelect={() => applyThinking(level)}
              >
                <span className="flex-1">{formatEffortLabel(level)}</span>
                {thinkingEnabled && currentThinking === level
                  ? <Icon name="check" className="size-4 text-primary" />
                  : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
};

export const PrimeMobileModelButton: React.FC<{
  identity: ChatIdentity;
  onOpen: () => void;
}> = ({ identity, onOpen }) => {
  const { t } = useI18n();
  const liveKey = getPrimeLiveKey(identity);
  const composerKey = getPrimeComposerKey(identity);
  const live = usePrimeLiveStore((state) => state.byKey.get(liveKey));
  const pending = usePrimeComposerStore((state) => state.byKey.get(composerKey)?.pendingAction ?? null);
  const current = live?.snapshot?.configuration.currentModel;
  const enabled = live?.desiredActive === true
    && live.availability === 'live'
    && live.snapshot?.freshness.state === 'fresh'
    && live.snapshot.capabilities.mutations
    && live.snapshot.status.activity === 'idle'
    && live.snapshot.capabilities.actions.canChangeModel
    && pending === null;
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onPointerDownCapture={(event) => {
        if (event.pointerType === 'touch') event.preventDefault();
      }}
      onClick={onOpen}
      disabled={!enabled}
      className="flex h-7 max-w-[70vw] items-center gap-1.5 rounded-lg px-2 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
      aria-label={t('chat.modelControls.selectModel')}
    >
      {current ? <ProviderLogo providerId={current.provider} className="size-3.5" /> : null}
      <span className="truncate">{modelLabel(current, t('chat.modelControls.selectModel'))}</span>
      <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
    </button>
  );
};

export const PrimeModelControls: React.FC<ComposerModelControlsRenderProps & {
  identity: ChatIdentity;
}> = ({ identity, className, mobilePanel, onMobilePanelChange }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const liveKey = getPrimeLiveKey(identity);
  const composerKey = getPrimeComposerKey(identity);
  const live = usePrimeLiveStore((state) => state.byKey.get(liveKey));
  const pending = usePrimeComposerStore((state) => state.byKey.get(composerKey)?.pendingAction ?? null);
  const snapshot = live?.snapshot ?? null;
  const currentModel = snapshot?.configuration.currentModel;
  const currentThinking = snapshot?.configuration.thinking.current;
  const models = snapshot?.configuration.models ?? EMPTY_MODELS;
  const thinkingLevels = snapshot?.configuration.thinking.available ?? EMPTY_THINKING_LEVELS;
  const [query, setQuery] = React.useState('');
  const enabled = live?.desiredActive === true
    && live.availability === 'live'
    && snapshot?.freshness.state === 'fresh'
    && snapshot.capabilities.mutations
    && snapshot.status.activity === 'idle'
    && snapshot.capabilities.actions.canChangeModel
    && pending === null;
  const filteredModels = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return models;
    return models.filter((model) => (
      `${model.provider} ${model.name ?? ''} ${model.id}`.toLocaleLowerCase().includes(normalized)
    ));
  }, [models, query]);

  const applyModel = React.useCallback((model: PrimeModel) => {
    if (!enabled || sameModel(currentModel, model)) return;
    void setPrimeModel(identity, apis, model);
    onMobilePanelChange?.(null);
  }, [apis, currentModel, enabled, identity, onMobilePanelChange]);

  const applyThinking = React.useCallback((level: PrimeThinkingLevel) => {
    if (!enabled || currentThinking === level) return;
    void setPrimeThinkingLevel(identity, apis, level);
    onMobilePanelChange?.(null);
  }, [apis, currentThinking, enabled, identity, onMobilePanelChange]);

  const modelRows = (
    <div className="flex flex-col gap-1">
      {filteredModels.map((model) => {
        const selected = sameModel(currentModel, model);
        return (
          <button
            key={`${model.provider}:${model.id}`}
            type="button"
            disabled={!enabled || selected}
            onClick={() => applyModel(model)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-interactive-hover disabled:cursor-default',
              selected && 'bg-interactive-hover/70',
            )}
            aria-pressed={selected}
          >
            <ProviderLogo providerId={model.provider} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate typography-ui-label text-foreground">
                {modelLabel(model, model.id)}
              </span>
              <span className="block truncate typography-meta text-muted-foreground">
                {model.provider} · {model.id}
              </span>
            </span>
            {selected ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );

  if (mobilePanel !== undefined) {
    return (
      <MobileOverlayPanel
        open={mobilePanel === 'model'}
        onClose={() => onMobilePanelChange?.(null)}
        title={t('chat.modelControls.selectModel')}
      >
        <div className="flex flex-col gap-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('chat.modelControls.searchProvidersOrModels')}
            className="h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
          />
          <div className="max-h-[48vh] overflow-y-auto">{modelRows}</div>
          {thinkingLevels.length > 0 ? (
            <div className="border-t border-border/40 pt-3">
              <p className="mb-2 typography-meta font-medium text-muted-foreground">
                {t('chat.modelControls.thinking')}
              </p>
              <div className="flex flex-wrap gap-2">
                {thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    disabled={!enabled || currentThinking === level}
                    onClick={() => applyThinking(level)}
                    className={cn(
                      'rounded-full border border-border/40 px-2.5 py-1 typography-meta text-muted-foreground',
                      currentThinking === level && 'border-primary/30 bg-primary/10 text-foreground',
                    )}
                    aria-pressed={currentThinking === level}
                  >
                    {formatEffortLabel(level)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!enabled || models.length === 0}
            className="flex h-6 min-w-0 max-w-52 items-center gap-1.5 rounded-md px-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
            aria-label={t('chat.modelControls.selectModel')}
          >
            {currentModel ? <ProviderLogo providerId={currentModel.provider} className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{modelLabel(currentModel, t('chat.modelControls.selectModel'))}</span>
            <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-1.5">
          <DropdownMenuLabel className="px-1 pb-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={t('chat.modelControls.searchProvidersOrModels')}
              className="h-8 typography-meta"
            />
          </DropdownMenuLabel>
          <div className="max-h-72 overflow-y-auto">
            {filteredModels.map((model) => {
              const selected = sameModel(currentModel, model);
              return (
                <DropdownMenuItem
                  key={`${model.provider}:${model.id}`}
                  disabled={!enabled || selected}
                  onSelect={() => applyModel(model)}
                  className="gap-2"
                >
                  <ProviderLogo providerId={model.provider} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate typography-meta font-medium text-foreground">
                      {modelLabel(model, model.id)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{model.provider}</span>
                  </span>
                  {selected ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
                </DropdownMenuItem>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {thinkingLevels.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={!enabled}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              aria-label={t('chat.modelControls.thinking')}
            >
              <span>{currentThinking ? formatEffortLabel(currentThinking) : t('chat.modelControls.thinking')}</span>
              <Icon name="arrow-down-s" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('chat.modelControls.thinking')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {thinkingLevels.map((level) => (
              <DropdownMenuItem
                key={level}
                disabled={!enabled || currentThinking === level}
                onSelect={() => applyThinking(level)}
              >
                <span className="flex-1">{formatEffortLabel(level)}</span>
                {currentThinking === level ? <Icon name="check" className="size-4 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
};
