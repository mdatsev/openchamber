import React from 'react';

import { ComposerControllerContext } from './composerControllerContext';
import type { ComposerController, ComposerControllerSnapshot } from './types';

export function useComposerController(): ComposerController {
    const controller = React.useContext(ComposerControllerContext);
    if (!controller) {
        throw new Error('Composer presentation must be rendered inside ComposerControllerProvider');
    }
    return controller;
}

export function useComposerControllerSnapshot(): ComposerControllerSnapshot {
    const controller = useComposerController();
    return React.useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
    );
}
