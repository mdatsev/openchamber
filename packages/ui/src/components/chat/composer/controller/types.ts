import type React from 'react';

import type { MobileControlsPanel } from '../../mobileControlsUtils';

export interface ComposerActionState {
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    canSubmit: boolean;
    canQueue: boolean;
}

export interface ComposerActionsController {
    primaryAction: () => void;
    queueMessage: () => void;
    abort: () => void;
}

export interface ComposerControllerSnapshot {
    actions: ComposerActionState;
}

export interface ComposerCommandMenuHandle {
    handleKeyDown: (key: string) => void;
}

interface ComposerCommandMenuRenderProps {
    handleRef: React.RefObject<ComposerCommandMenuHandle | null>;
    query: string;
    style?: React.CSSProperties;
    onSelect: (commandName: string) => void;
    onClose: () => void;
}

export type ComposerCommandMenuRenderer = (props: ComposerCommandMenuRenderProps) => React.ReactNode;

export interface ComposerModelControlsRenderProps {
    className?: string;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
}

export type ComposerModelControlsRenderer = (props: ComposerModelControlsRenderProps) => React.ReactNode;

/**
 * Harness-neutral dependencies used by the shared composer presentation.
 *
 * The controller deliberately contains no session identity, directory, SDK
 * records, editor handle, or persisted draft target. Harness adapters own
 * those details and expose only the actions and render dependencies the
 * existing presentation needs.
 */
export interface ComposerController {
    getSnapshot: () => ComposerControllerSnapshot;
    subscribe: (listener: () => void) => () => void;
    actions: ComposerActionsController;
    renderCommandMenu: ComposerCommandMenuRenderer;
    renderModelControls: ComposerModelControlsRenderer;
}
