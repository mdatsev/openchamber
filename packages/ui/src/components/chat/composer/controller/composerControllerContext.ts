import React from 'react';

import type { ComposerController } from './types';

export const ComposerControllerContext = React.createContext<ComposerController | null>(null);
