/**
 * The composer's send / queue / stop control.
 *
 * Which one is shown depends on whether a turn is running: idle sends, a busy
 * session with content offers both queue (above) and stop, a busy session
 * without content offers only stop.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
    useComposerController,
    useComposerControllerSnapshot,
} from '../controller/useComposerController';

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
};

export const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
    } = props;
    const { t } = useI18n();
    const { actions } = useComposerController();
    const { canSend, canAbort, hasContent, canSubmit, canQueue } = useComposerControllerSnapshot().actions;

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || !canSubmit}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                actions.primaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && canSubmit
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30'
            )}
            aria-label={t('chat.chatInput.actions.sendMessageAria')}
        >
            <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    return (
        <div className="relative">
            {hasContent && canQueue ? (
                <button
                    type="button"
                    disabled={!canQueue}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        actions.queueMessage();
                    }}
                    className={cn(
                        footerIconButtonClass,
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        canQueue ? 'text-primary hover:text-primary' : 'opacity-30'
                    )}
                    aria-label={t('chat.chatInput.actions.queueMessageAria')}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={actions.abort}
                className={cn(
                    footerIconButtonClass,
                    'text-[var(--status-error)] hover:text-[var(--status-error)]'
                )}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={cn(stopIconSizeClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
));
