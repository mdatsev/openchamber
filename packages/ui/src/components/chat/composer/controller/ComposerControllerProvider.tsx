import React from 'react';

import { ComposerControllerContext } from './composerControllerContext';
import type {
    ComposerController,
    ComposerModelControlsRenderProps,
} from './types';
import { useComposerController } from './useComposerController';

export function ComposerControllerProvider(props: {
    controller: ComposerController;
    children: React.ReactNode;
}) {
    return (
        <ComposerControllerContext.Provider value={props.controller}>
            {props.children}
        </ComposerControllerContext.Provider>
    );
}

export function ComposerModelControls(props: ComposerModelControlsRenderProps) {
    const { renderModelControls } = useComposerController();
    return <>{renderModelControls(props)}</>;
}
