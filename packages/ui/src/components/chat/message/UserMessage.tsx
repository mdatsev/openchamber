import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from '../useChatSurfaceMode';
import { formatTimestampForDisplay } from './timeFormat';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };

interface UserMessageProps {
    children: React.ReactNode;
    footer?: React.ReactNode;
    messageCreatedAt?: number | null;
    isMobile: boolean;
    isTablet: boolean;
    hasTouchInput: boolean;
    hasCopyableText?: boolean;
    copiedMessage?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    onRevert?: () => void;
    onFork?: () => void;
    branchActionsDisabled?: boolean;
    contextPinned?: boolean;
    contextPinPending?: boolean;
    onToggleContextPin?: () => void;
    stickyUserHeaderEnabled?: boolean;
}

export const UserMessage = React.memo(({
    children,
    footer,
    messageCreatedAt,
    isMobile,
    isTablet,
    hasTouchInput,
    hasCopyableText = false,
    copiedMessage = false,
    onCopyMessage,
    onRevert,
    onFork,
    branchActionsDisabled = false,
    contextPinned = false,
    contextPinPending = false,
    onToggleContextPin,
    stickyUserHeaderEnabled = true,
}: UserMessageProps) => {
    const { locale, t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);

    const alwaysShowActions = isMobile || isTablet;
    const isTouchContext = hasTouchInput || isMobile;
    const canCopyMessage = Boolean(onCopyMessage && hasCopyableText);
    const effectiveOnFork = chatSurfaceMode === 'mini-chat' ? undefined : onFork;
    const useExternalActionsRow = isMobile || !stickyUserHeaderEnabled;
    const useStickyScrollableContent = stickyUserHeaderEnabled && !useExternalActionsRow;
    const timestamp = React.useMemo(() => {
        void locale;
        if (typeof messageCreatedAt !== 'number' || messageCreatedAt <= 0) return null;
        const formatted = formatTimestampForDisplay(messageCreatedAt, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [locale, messageCreatedAt, timeFormatPreference]);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current === null || typeof window === 'undefined') return;
        window.clearTimeout(copyHintTimeoutRef.current);
        copyHintTimeoutRef.current = null;
    }, []);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || typeof window === 'undefined') return;
        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, isTouchContext]);

    React.useEffect(() => {
        if (hasCopyableText) return;
        setCopyHintVisible(false);
        clearCopyHintTimeout();
    }, [clearCopyHintTimeout, hasCopyableText]);

    React.useEffect(() => clearCopyHintTimeout, [clearCopyHintTimeout]);

    const handleCopyButtonClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!onCopyMessage || !hasCopyableText) return;
        event.stopPropagation();
        event.preventDefault();
        void onCopyMessage();
        if (isTouchContext) revealCopyHint();
    }, [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]);

    const actions = (mode: 'inline' | 'external') => {
        if (!canCopyMessage && !onRevert && !effectiveOnFork && !onToggleContextPin) return null;
        return (
            <div className={cn(
                'group/user-actions',
                isMobile
                    ? mode === 'inline'
                        ? 'flex items-center justify-end pt-2 pb-3'
                        : stickyUserHeaderEnabled
                            ? 'flex h-9 items-start justify-end pt-0'
                            : 'flex h-11 items-start justify-end pt-0'
                    : mode === 'inline'
                        ? 'absolute top-full left-0 right-0 z-10 pt-5'
                        : 'flex h-8 items-start justify-end pt-2',
            )}>
                <div className={cn(
                    'flex items-center justify-end gap-1',
                    mode === 'inline' ? 'translate-x-5' : 'translate-x-0',
                    alwaysShowActions
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100',
                )}>
                    {timestamp ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="mr-1 flex items-center gap-1 text-sm tabular-nums text-muted-foreground/60" aria-label={timestamp}>
                                    <Icon name="time" className="h-3.5 w-3.5" />
                                    <span className="message-footer__label">{timestamp}</span>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>{timestamp}</TooltipContent>
                        </Tooltip>
                    ) : null}
                    {onRevert ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 bg-transparent text-muted-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    disabled={branchActionsDisabled}
                                    aria-label={t('chat.messageBody.actions.revertAria')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRevert();
                                    }}
                                >
                                    <Icon name="arrow-go-back" className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
                        </Tooltip>
                    ) : null}
                    {effectiveOnFork ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 bg-transparent text-muted-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    disabled={branchActionsDisabled}
                                    aria-label={t('chat.messageBody.actions.forkAria')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        effectiveOnFork();
                                    }}
                                >
                                    <Icon name="git-branch" className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
                        </Tooltip>
                    ) : null}
                    {onToggleContextPin && hasCopyableText ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                        'h-6 w-6 bg-transparent hover:!bg-transparent hover:text-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                        contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                                    )}
                                    disabled={contextPinPending}
                                    aria-pressed={contextPinned}
                                    aria-label={t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onToggleContextPin();
                                    }}
                                >
                                    <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}</TooltipContent>
                        </Tooltip>
                    ) : null}
                    {canCopyMessage ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    data-visible={copyHintVisible || copiedMessage ? 'true' : undefined}
                                    className="h-6 w-6 bg-transparent text-muted-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    aria-label={t('chat.messageBody.actions.copyMessageAria')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={handleCopyButtonClick}
                                    onFocus={() => setCopyHintVisible(true)}
                                    onBlur={() => {
                                        if (!copiedMessage) setCopyHintVisible(false);
                                    }}
                                >
                                    {copiedMessage ? (
                                        <Icon name="check" className="h-3 w-3 text-[color:var(--status-success)]" />
                                    ) : (
                                        <Icon name="file-copy" className="h-3 w-3" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                        </Tooltip>
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <div className={cn('relative flex justify-end', !isMobile ? 'group/user-shell' : undefined)}>
            <div className={cn('max-w-[85%]', useStickyScrollableContent ? 'pb-5' : undefined)}>
                <div
                    style={{
                        backgroundColor: 'var(--chat-user-message-bg)',
                        borderRadius: 'var(--radius-xl)',
                        borderBottomRightRadius: 'var(--radius-sm)',
                    }}
                    className="border border-primary/5 px-5 py-3 shadow-none"
                >
                    <div
                        className="relative w-full group/message"
                        style={CONTAIN_LAYOUT_STYLE}
                        onTouchStart={isTouchContext && canCopyMessage ? revealCopyHint : undefined}
                    >
                        <div
                            className={cn(
                                'overflow-x-hidden leading-relaxed text-base text-foreground/90',
                                useStickyScrollableContent
                                    ? 'overflow-y-auto overscroll-contain scrollbar-none'
                                    : 'overflow-y-hidden',
                            )}
                            style={useStickyScrollableContent ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' } : undefined}
                        >
                            {children}
                        </div>
                        {footer}
                        {useExternalActionsRow ? null : actions('inline')}
                    </div>
                </div>
                {useExternalActionsRow ? actions('external') : null}
            </div>
        </div>
    );
});

UserMessage.displayName = 'UserMessage';
