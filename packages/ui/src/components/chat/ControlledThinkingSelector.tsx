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
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { cn } from '@/lib/utils';

interface ControlledThinkingSelectorProps {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  title: string;
  defaultLabel: string;
  formatLabel?: (value: string) => string;
  includeDefault?: boolean;
  disabled?: boolean;
  mobile?: boolean;
  size?: 'mobile' | 'vscode' | 'default';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestFocus?: () => void;
  renderMobileOverlay?: boolean;
  className?: string;
}

const defaultFormatter = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const ControlledThinkingSelector: React.FC<ControlledThinkingSelectorProps> = ({
  value,
  options,
  onChange,
  title,
  defaultLabel,
  formatLabel = defaultFormatter,
  includeDefault = true,
  disabled = false,
  mobile = false,
  size = mobile ? 'mobile' : 'default',
  open,
  onOpenChange,
  onRequestFocus,
  renderMobileOverlay = true,
  className,
}) => {
  const [localOpen, setLocalOpen] = React.useState(false);
  const controlled = open !== undefined;
  const selectorOpen = controlled ? open : localOpen;
  const uniqueOptions = React.useMemo(() => [...new Set(options.filter((option) => option.length > 0))], [options]);
  const hasChoices = uniqueOptions.length > 0;

  const setSelectorOpen = React.useCallback((nextOpen: boolean, restoreFocus = false) => {
    if (disabled && nextOpen) return;
    if (!controlled) setLocalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen && restoreFocus) requestAnimationFrame(() => onRequestFocus?.());
  }, [controlled, disabled, onOpenChange, onRequestFocus]);

  const handleChange = React.useCallback((nextValue: string) => {
    if (disabled) return;
    onChange(nextValue);
    setSelectorOpen(false, true);
  }, [disabled, onChange, setSelectorOpen]);

  if (!hasChoices) return null;

  const displayLabel = value ? formatLabel(value) : defaultLabel;
  const isDefault = includeDefault && !value;
  const colorClass = isDefault ? 'text-muted-foreground' : 'text-[color:var(--status-info)]';
  const buttonHeight = size === 'mobile' ? 'h-9' : size === 'vscode' ? 'h-6' : 'h-8';
  const iconSize = size === 'mobile' ? 'size-5' : 'size-4';
  const textSize = size === 'mobile' ? 'typography-micro' : 'typography-meta';

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onClick={mobile ? () => setSelectorOpen(true) : undefined}
      onMouseDown={mobile ? (event) => event.preventDefault() : undefined}
      onPointerDownCapture={mobile ? (event) => {
        if (event.pointerType === 'touch') event.preventDefault();
      } : undefined}
      aria-label={title}
      className={cn(
        'model-controls__variant-trigger flex min-w-0 items-center gap-1.5 focus:outline-none',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-transparent hover:opacity-70',
        buttonHeight,
        className,
      )}
    >
      <Icon name="brain-ai-3" className={cn(iconSize, 'shrink-0', colorClass)} />
      <span className={cn(
        'model-controls__variant-label min-w-0 truncate font-medium',
        textSize,
        mobile ? 'max-w-[60px]' : 'max-w-[180px]',
        colorClass,
      )}>
        {displayLabel}
      </span>
    </button>
  );

  const optionValues = includeDefault ? ['', ...uniqueOptions] : uniqueOptions;

  if (mobile) {
    return (
      <>
        {trigger}
        {renderMobileOverlay ? (
          <MobileOverlayPanel open={selectorOpen} onClose={() => setSelectorOpen(false, true)} title={title}>
            <div className="flex flex-col gap-1.5">
              {optionValues.map((option) => {
                const selected = option === value;
                const label = option ? formatLabel(option) : defaultLabel;
                return (
                  <button
                    key={option || '__default__'}
                    type="button"
                    disabled={disabled}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left',
                      'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                      selected ? 'border-primary/30 bg-primary/10' : 'border-border/40',
                    )}
                    onClick={() => handleChange(option)}
                  >
                    <span className="typography-meta font-medium text-foreground">{label}</span>
                    {selected && <Icon name="check" className="size-4 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </MobileOverlayPanel>
        ) : null}
      </>
    );
  }

  return (
    <DropdownMenu open={!disabled && selectorOpen} onOpenChange={(nextOpen) => setSelectorOpen(nextOpen, !nextOpen)}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(180px,calc(100vw-2rem))]">
        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">{title}</DropdownMenuLabel>
        {optionValues.map((option, index) => {
          const selected = option === value;
          const label = option ? formatLabel(option) : defaultLabel;
          return (
            <React.Fragment key={option || '__default__'}>
              {index === 1 && includeDefault ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem className="typography-meta" onSelect={() => handleChange(option)}>
                <div className="flex w-full min-w-0 items-center justify-between gap-2">
                  <span className="typography-meta min-w-0 truncate font-medium text-foreground">{label}</span>
                  {selected && <Icon name="check" className="size-4 shrink-0 text-primary" />}
                </div>
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
