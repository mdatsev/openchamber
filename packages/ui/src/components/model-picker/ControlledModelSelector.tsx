import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';
import {
  ModelPickerList,
  type ModelPickerEntry,
  type ModelPickerProvider,
} from './ModelPickerList';

export interface ControlledModelSelectorLabels {
  title: string;
  searchPlaceholder: string;
  noResults: string;
  favorites: string;
  recent: string;
  keyboardHint: string;
  notSelected: string;
  loading?: string;
  unavailable?: string;
  favorite?: string;
  unfavorite?: string;
  capabilities?: string;
  capabilityToolCalling?: string;
  capabilityReasoning?: string;
  input?: string;
  output?: string;
  costPerMillion?: string;
}

type SelectorStatus = 'ready' | 'loading' | 'unavailable';
type SelectorAppearance = 'field' | 'composer';
type SelectorSize = 'mobile' | 'vscode' | 'default';

type HiddenModel = { providerID: string; modelID: string };

interface ControlledModelSelectorProps {
  providers: ModelPickerProvider[];
  modelsMetadata?: Map<string, ModelMetadata>;
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: ControlledModelSelectorLabels;
  placeholder?: string;
  status?: SelectorStatus;
  disabled?: boolean;
  mobile?: boolean;
  appearance?: SelectorAppearance;
  size?: SelectorSize;
  compact?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestFocus?: () => void;
  favoriteModels?: ModelPickerEntry[];
  recentModels?: ModelPickerEntry[];
  hiddenModels?: HiddenModel[];
  providerOrder?: string[];
  allowedProviderIds?: string[];
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  tooltipsEnabled?: boolean;
  dropdownPortalToBody?: boolean;
}

const EMPTY_METADATA = new Map<string, ModelMetadata>();
const EMPTY_ENTRIES: ModelPickerEntry[] = [];

const selectorSizeClasses = (size: SelectorSize) => ({
  height: size === 'mobile' ? 'h-9' : size === 'vscode' ? 'h-6' : 'h-8',
  icon: size === 'mobile' ? 'size-5' : 'size-4',
  text: size === 'mobile' ? 'typography-micro' : 'typography-meta',
  maxWidth: size === 'mobile' ? 'max-w-[120px]' : 'max-w-[260px]',
});

interface ModelSelectorTriggerProps {
  providerID: string | null;
  label: string;
  loadingLabel: string;
  ready: boolean;
  disabled?: boolean;
  mobile?: boolean;
  appearance?: SelectorAppearance;
  size?: SelectorSize;
  compact?: boolean;
  className?: string;
  labelRef?: React.Ref<HTMLSpanElement>;
  labelTruncated?: boolean;
  onClick?: () => void;
  onTouchStart?: React.TouchEventHandler<HTMLButtonElement>;
  onTouchEnd?: React.TouchEventHandler<HTMLButtonElement>;
  onTouchCancel?: React.TouchEventHandler<HTMLButtonElement>;
}

export const ModelSelectorTrigger = React.forwardRef<HTMLButtonElement, ModelSelectorTriggerProps>(({
  providerID,
  label,
  loadingLabel,
  ready,
  disabled = false,
  mobile = false,
  appearance = 'field',
  size = 'default',
  compact = false,
  className,
  labelRef,
  labelTruncated = false,
  onClick,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
}, ref) => {
  const sizeClasses = selectorSizeClasses(size);
  const isDisabled = disabled || !ready;

  if (appearance === 'composer') {
    return (
      <button
        ref={ref}
        type="button"
        disabled={isDisabled}
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onMouseDown={mobile ? (event) => event.preventDefault() : undefined}
        onPointerDownCapture={mobile ? (event) => {
          if (event.pointerType === 'touch') event.preventDefault();
        } : undefined}
        aria-label={ready ? label : loadingLabel}
        className={cn(
          'model-controls__model-trigger flex min-w-0 items-center gap-1.5 focus:outline-none',
          isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-transparent hover:opacity-70',
          sizeClasses.height,
          className,
        )}
      >
        {!ready ? (
          <>
            <Icon name="loader-4" className={cn(sizeClasses.icon, 'shrink-0 animate-spin text-muted-foreground')} />
            <span className={cn(sizeClasses.text, 'min-w-0 whitespace-nowrap font-medium text-muted-foreground')}>
              {loadingLabel}
            </span>
          </>
        ) : (
          <>
            {providerID ? (
              <ProviderLogo providerId={providerID} className={cn(sizeClasses.icon, 'shrink-0')} />
            ) : (
              <Icon name="pencil-ai" className={cn(sizeClasses.icon, 'shrink-0 text-muted-foreground')} />
            )}
            <span
              ref={labelRef}
              className={cn(
                'model-controls__model-label min-w-0 overflow-hidden whitespace-nowrap font-medium text-foreground',
                sizeClasses.text,
                sizeClasses.maxWidth,
              )}
            >
              <span className={cn('marquee-text', labelTruncated && 'marquee-text--active')}>{label}</span>
            </span>
          </>
        )}
      </button>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      disabled={isDisabled}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onMouseDown={mobile ? (event) => event.preventDefault() : undefined}
      onPointerDownCapture={mobile ? (event) => {
        if (event.pointerType === 'touch') event.preventDefault();
      } : undefined}
      title={compact && ready ? label : undefined}
      aria-label={compact ? (ready ? label : loadingLabel) : undefined}
      className={cn(
        dropdownTriggerVariants({ size: mobile ? 'default' : 'sm' }),
        mobile ? 'w-full' : 'w-fit min-w-0',
        isDisabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!ready ? (
          <>
            <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            {!compact && <span className="typography-meta text-muted-foreground">{loadingLabel}</span>}
          </>
        ) : providerID ? (
          <ProviderLogo providerId={providerID} className="size-3.5 shrink-0" />
        ) : (
          <Icon name="pencil-ai" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {ready && !compact ? (
          <span className="typography-ui-label min-w-0 flex-1 truncate text-left font-normal text-foreground">{label}</span>
        ) : null}
      </div>
      {!compact && <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground/50" />}
    </button>
  );
});
ModelSelectorTrigger.displayName = 'ModelSelectorTrigger';

export const ControlledModelSelector: React.FC<ControlledModelSelectorProps> = ({
  providers,
  modelsMetadata = EMPTY_METADATA,
  selectedModel,
  onSelect,
  labels,
  placeholder,
  status = 'ready',
  disabled = false,
  mobile = false,
  appearance = 'field',
  size = mobile ? 'mobile' : 'default',
  compact = false,
  className,
  open,
  onOpenChange,
  onRequestFocus,
  favoriteModels = EMPTY_ENTRIES,
  recentModels = EMPTY_ENTRIES,
  hiddenModels = [],
  providerOrder,
  allowedProviderIds,
  isModelAllowed,
  includeNotSelected = false,
  onSelectNone,
  isFavorite,
  onToggleFavorite,
  tooltipsEnabled = true,
  dropdownPortalToBody = false,
}) => {
  const [localOpen, setLocalOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const controlled = open !== undefined;
  const pickerOpen = controlled ? open : localOpen;
  const ready = status === 'ready';
  const interactive = ready && !disabled;

  const setPickerOpen = React.useCallback((nextOpen: boolean, restoreFocus = false) => {
    if (!interactive && nextOpen) return;
    if (!controlled) setLocalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
      if (restoreFocus) requestAnimationFrame(() => onRequestFocus?.());
    }
  }, [controlled, interactive, onOpenChange, onRequestFocus]);

  React.useEffect(() => {
    if (!pickerOpen) setSearchQuery('');
  }, [pickerOpen]);

  const closePicker = React.useCallback((restoreFocus = true) => {
    setPickerOpen(false, restoreFocus);
  }, [setPickerOpen]);

  const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
    if (!interactive) return;
    onSelect(entry);
    closePicker();
  }, [closePicker, interactive, onSelect]);

  const handleSelectNone = React.useCallback(() => {
    if (!interactive || !onSelectNone) return;
    onSelectNone();
    closePicker();
  }, [closePicker, interactive, onSelectNone]);

  const provider = selectedModel
    ? providers.find((entry) => entry.id === selectedModel.providerID)
    : undefined;
  const model = provider?.models?.find((entry) => entry.id === selectedModel?.modelID);
  const selectedLabel = (typeof model?.name === 'string' && model.name.trim())
    || selectedModel?.modelID
    || placeholder
    || labels.notSelected;
  const loadingLabel = status === 'unavailable'
    ? labels.unavailable ?? labels.notSelected
    : labels.loading ?? labels.title;

  const picker = (
    <ModelPickerList
      providers={providers}
      providerOrder={providerOrder}
      favoriteModels={favoriteModels}
      recentModels={recentModels}
      modelsMetadata={modelsMetadata}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      onSelect={handleSelect}
      labels={labels}
      selectedModel={selectedModel}
      hiddenModels={hiddenModels}
      allowedProviderIds={allowedProviderIds}
      isModelAllowed={isModelAllowed}
      includeNotSelected={includeNotSelected}
      onSelectNone={handleSelectNone}
      disabled={!interactive}
      autoFocus={!mobile}
      onEscape={() => closePicker()}
      tooltipsEnabled={tooltipsEnabled && pickerOpen}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
    />
  );

  const trigger = (
    <ModelSelectorTrigger
      providerID={selectedModel?.providerID ?? null}
      label={selectedLabel}
      loadingLabel={loadingLabel}
      ready={ready}
      disabled={disabled}
      mobile={mobile}
      appearance={appearance}
      size={size}
      compact={compact}
      className={className}
      onClick={mobile ? () => setPickerOpen(true) : undefined}
    />
  );

  if (mobile) {
    return (
      <>
        {trigger}
        <MobileOverlayPanel open={pickerOpen} onClose={() => closePicker()} title={labels.title}>
          {picker}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={interactive && pickerOpen} onOpenChange={(nextOpen) => setPickerOpen(nextOpen, !nextOpen)}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        className="flex w-[min(380px,calc(100vw-2rem))] flex-col p-0"
        align={appearance === 'composer' ? 'end' : 'start'}
        alignOffset={appearance === 'composer' ? -40 : 0}
        portalToBody={dropdownPortalToBody}
      >
        {picker}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
