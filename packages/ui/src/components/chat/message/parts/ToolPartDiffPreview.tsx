import React from 'react';
import type { FileDiffOptions } from '@pierre/diffs';
import { PatchDiff } from '@pierre/diffs/react';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { DiffViewMode } from '../DiffViewToggle';
import { PlainDiffFallback } from './PlainDiffFallback';
import {
    syncLineDiffWarningMarkers,
    TOOL_LINE_DIFF_MAX_LENGTH,
    type LineDiffWarning,
} from './toolDiffUtils';

// Loaded lazily from ToolPart: this is the only part of the tool card that
// needs @pierre/diffs' rendering stack (Shiki core + regex engines), so the
// eager chat graph stays free of it and the chunk downloads on the first
// rendered tool diff.

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }

  [data-line-diff-warning] {
    position: relative;
    padding-inline-end: 20px;
  }

  [data-line-diff-warning-marker] {
    position: absolute;
    inset-block-start: 4px;
    inset-inline-end: 3px;
    display: inline-flex;
    width: 14px;
    height: 14px;
    color: var(--status-warning);
    cursor: help;
  }

  [data-line-diff-warning-marker] svg {
    width: 100%;
    height: 100%;
  }

  [data-line-diff-warning-marker]:focus-visible {
    border-radius: 2px;
    outline: 1px solid var(--interactive-focus-ring);
    outline-offset: 1px;
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};

const usePierreThemeConfig = () => {
    const themeSystem = useOptionalThemeSystem();
    const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
    const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

    const availableThemes = React.useMemo(
        () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
        [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
    );
    const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
    const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

    const lightTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
        [availableThemes, fallbackLightTheme, lightThemeId],
    );
    const darkTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
        [availableThemes, darkThemeId, fallbackDarkTheme],
    );

    // Registration is synchronous module state inside @pierre/diffs; rendering
    // a PatchDiff with these theme ids requires it to have happened first, so
    // register during render rather than in an effect.
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        pierreTheme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
        pierreThemeType: currentVariant === 'dark' ? ('dark' as const) : ('light' as const),
    };
};

class DiffPreviewErrorBoundary extends React.Component<{
    resetKey: string;
    fallback: React.ReactNode;
    children: React.ReactNode;
}, { hasError: boolean }> {
    state = { hasError: false };

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    componentDidUpdate(prevProps: { resetKey: string }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool diff preview failed; rendering raw patch instead.', error);
        }
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

export interface ToolPartDiffPreviewProps {
    diff: string;
    diffViewMode: DiffViewMode;
    lineDiffWarnings: LineDiffWarning[];
}

const ToolPartDiffPreview: React.FC<ToolPartDiffPreviewProps> = React.memo(({
    diff,
    diffViewMode,
    lineDiffWarnings,
}) => {
    const { t } = useI18n();
    const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
    const lineDiffWarningLabel = t('chat.toolPart.lineDiffUnavailable', {
        limit: TOOL_LINE_DIFF_MAX_LENGTH,
    });
    const options = React.useMemo<FileDiffOptions<undefined>>(
        () => ({
            diffStyle: diffViewMode === 'side-by-side' ? 'split' : 'unified',
            diffIndicators: 'none',
            hunkSeparators: 'line-info-basic',
            lineDiffType: 'word-alt',
            disableFileHeader: true,
            maxLineDiffLength: TOOL_LINE_DIFF_MAX_LENGTH,
            expansionLineCount: 20,
            overflow: 'wrap',
            theme: pierreTheme,
            themeType: pierreThemeType,
            unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
            onPostRender: (container, _instance, phase) => {
                if (phase !== 'unmount') {
                    syncLineDiffWarningMarkers(container, lineDiffWarnings, lineDiffWarningLabel);
                }
            },
        }),
        [diffViewMode, lineDiffWarningLabel, lineDiffWarnings, pierreTheme, pierreThemeType]
    );

    const fallback = <PlainDiffFallback diff={diff} />;

    return (
        <div className="typography-code px-1 pb-1 pt-0">
            <DiffPreviewErrorBoundary resetKey={diff} fallback={fallback}>
                <PatchDiff
                    patch={diff}
                    metrics={TOOL_DIFF_METRICS}
                    options={options}
                    className="block w-full"
                />
            </DiffPreviewErrorBoundary>
        </div>
    );
});

ToolPartDiffPreview.displayName = 'ToolPartDiffPreview';

export default ToolPartDiffPreview;
