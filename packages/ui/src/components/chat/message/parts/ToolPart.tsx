
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { MessageFilesDisplay } from '../../FileAttachment';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { TranscriptFilePart, TranscriptToolPart, TranscriptToolState } from '../../transcript/types';
import { toolDisplayStyles } from '@/lib/typography';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useVisibleChatDirectory } from '@/hooks/useVisibleChatDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords, useEnsureSessionMessages } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';

import {
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
    renderTodoOutput,
    tryParseJsonOutput,
    coerceToText,
} from '../toolRenderers';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { JsonSummaryView } from './JsonSummaryView';
import { Icon } from "@/components/icon/Icon";
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { getToolIcon } from './toolPresentation';
import { useDurationTickerNow } from './useDurationTicker';
import {
    buildTaskSummaryEntriesFromSession,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
    stripTaskMetadataFromOutput,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { useI18n } from '@/lib/i18n';
import {
    extractFirstChangedLineFromDiff,
    getDiffPatchEntries,
    getFirstChangedLineFromMetadata,
    getMutatedToolPaths,
    getPatchText,
    getPrimaryDiffFromMetadata,
    getPrimaryToolPath,
    type DiffPatchEntry,
} from './toolDiffUtils';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { getStreamingOutputAppend, getToolOutput } from './toolOutput';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { getToolDescriptionFallback } from './toolRenderUtils';
import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type ToolStateWithMetadata = TranscriptToolState & { metadata?: Record<string, unknown>; input?: Record<string, unknown>; output?: string; error?: string; time?: { start: number; end?: number }; attachments?: Array<TranscriptFilePart> };

interface ToolPartProps {
    part: TranscriptToolPart;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

const normalizeToolName = (toolName: string | undefined | null): string => {
    if (typeof toolName !== 'string') {
        return '';
    }

    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) {
        return '';
    }

    if (trimmed.includes('.')) {
        const dotParts = trimmed.split('.').filter(Boolean);
        const last = dotParts[dotParts.length - 1];
        if (last) return last;
    }

    return trimmed;
};

const IPYTHON_INPUT_SCAN_LENGTH = 4096;
const IPYTHON_DESCRIPTOR_MAX_LENGTH = 64;
const TOOL_DESCRIPTION_MAX_LENGTH = 100;
const IPYTHON_IMPORT_PATTERN = /^\s*(?:import\s+\S|from\s+\S+\s+import\s+)/;
const IPYTHON_CONTROL_PATTERN = /^\s*(?:if|elif|else|for|while|with|try|except|finally)\b.*:\s*$/;
const IPYTHON_DEFINITION_PATTERN = /^\s*(?:async\s+def|def|class)\s+/;
const IPYTHON_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const IPYTHON_LOW_SIGNAL_CALL_PATTERN = /^\s*(?:await\s+)?(?:print|len|str|repr|int|float|list|dict|set|tuple)\s*\(/;
const IPYTHON_ASSIGNMENT_CALL_PATTERN = /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const IPYTHON_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN = /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?(?:Path|pathlib\.Path|json\.loads|json\.dumps|str|int|float|list|dict|set|tuple)\s*\(/;
const IPYTHON_EFFECT_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch|append|extend|update|add|remove|discard|close|commit|execute|run)\s*\(/;

const collapseIPythonPreview = (value: string) => {
    const redacted = value
        .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '<blob>')
        .replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(["'])[^"']*\2/gi, '$1=<redacted>')
        .replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(?!<redacted>)(?!["'])\S+/gi, '$1=<redacted>')
        .replace(/(["'])sk-[^"']+\1/g, '$1<redacted>$1')
        .replace(/(["']).{160,}\1/g, '$1…$1')
        .replace(/\s+/g, ' ')
        .trim();
    return redacted.length <= IPYTHON_DESCRIPTOR_MAX_LENGTH
        ? redacted
        : `${redacted.slice(0, IPYTHON_DESCRIPTOR_MAX_LENGTH - 1).trimEnd()}…`;
};

const IPYTHON_BASH_SET_PATTERN = /^\s*set\s+[-+][A-Za-z]*(?:\s+[-+]?\w+)*(?:\s+pipefail)?\s*$/;
const IPYTHON_BASH_SETUP_PATTERN = /^\s*(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/;
const IPYTHON_BASH_MUTATION_PATTERN = /\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/;

const shellPreviewWords = (line: string): string[] => {
    const words: string[] = [];
    for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        words.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return words;
};

const simplifyIPythonBashCommand = (line: string) => {
    const words = shellPreviewWords(line);
    const joined = words.join(' ');
    if (words[0] === 'cd') return 'cd';
    if (words[0] === 'npm') {
        const runIndex = words.indexOf('run');
        if (runIndex >= 0 && words[runIndex + 1]) return `npm ${words.slice(runIndex + 1).join(' ')}`;
    }
    const pytestIndex = words.indexOf('pytest');
    if (words[0] === 'uv' && words[1] === 'run' && pytestIndex >= 0) {
        return `pytest ${words.slice(pytestIndex + 1).join(' ')}`.trim();
    }
    if ((words[0] === 'python' || words[0] === 'python3') && words[1] === '-m' && words[2] === 'pytest') {
        return `pytest ${words.slice(3).join(' ')}`.trim();
    }
    if (joined.includes('node_modules/.bin/')) return joined.replace(/\S*node_modules\/\.bin\//g, '');
    if (words[0] === 'apply_patch') return 'apply patch';
    return line;
};

const getIPythonBashPreview = (lines: readonly string[]) => {
    let best: { text: string; score: number } | undefined;
    let directoryFallback: string | undefined;
    let index = 0;
    for (const rawLine of lines) {
        for (const rawPart of rawLine.split(/\s*(?:&&|;)\s*/)) {
            const command = rawPart.replace(/^\s*!/, '').trim();
            if (!command
                || command.startsWith('#')
                || IPYTHON_BASH_SET_PATTERN.test(command)
                || IPYTHON_BASH_SETUP_PATTERN.test(command)) continue;
            const firstWord = shellPreviewWords(command)[0] ?? '';
            if (firstWord === 'cd') {
                directoryFallback ??= 'cd';
                continue;
            }
            const simplified = simplifyIPythonBashCommand(command);
            let score = 30 + index;
            if (simplified !== command) score += 40;
            if (['rm', 'mv', 'cp', 'git', 'npm', 'pnpm', 'pytest', 'vitest'].includes(firstWord)) score += 20;
            if (IPYTHON_BASH_MUTATION_PATTERN.test(command)) score += 40;
            if (!best || score > best.score) best = { text: simplified, score };
            index += 1;
        }
    }
    return collapseIPythonPreview(best?.text ?? directoryFallback ?? '');
};

const ipythonIndent = (line: string) => line.match(/^\s*/)?.[0].length ?? 0;
const isSkippableIPythonLine = (line: string) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith('#') || IPYTHON_IMPORT_PATTERN.test(line) || trimmed.startsWith('@');
};
const firstIPythonChildLine = (lines: readonly string[], parentIndex: number): number | undefined => {
    const parentIndent = ipythonIndent(lines[parentIndex] ?? '');
    for (let index = parentIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (isSkippableIPythonLine(line)) continue;
        if (ipythonIndent(line) <= parentIndent) return undefined;
        return index;
    }
    return undefined;
};
const ipythonLineScore = (lines: readonly string[], index: number): number => {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (isSkippableIPythonLine(line)) return -1;
    if (/\bawait\s+edit\s*\(/.test(line)) return 100;
    if (/\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch)\s*\(/.test(line)) return 95;
    if (/subprocess\.(?:run|check_call|check_output|Popen)\s*\(/.test(line)) return 90;
    if (IPYTHON_EFFECT_CALL_PATTERN.test(line)) return 80;
    if (/^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/.test(line)) return 70;
    if (IPYTHON_CONTROL_PATTERN.test(line)) {
        const childIndex = firstIPythonChildLine(lines, index);
        return childIndex === undefined ? 20 : Math.max(20, ipythonLineScore(lines, childIndex) - 5);
    }
    if (IPYTHON_DEFINITION_PATTERN.test(line)) return 50;
    if (IPYTHON_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN.test(line)) return 25;
    if (IPYTHON_ASSIGNMENT_CALL_PATTERN.test(line)) return 60;
    if (IPYTHON_CALL_PATTERN.test(line) && !IPYTHON_LOW_SIGNAL_CALL_PATTERN.test(line)) return 65;
    if (IPYTHON_CALL_PATTERN.test(line)) return 15;
    return trimmed ? 30 : -1;
};
const ipythonPreviewIndex = (lines: readonly string[], index: number): number => {
    if (!IPYTHON_CONTROL_PATTERN.test(lines[index] ?? '')) return index;
    const childIndex = firstIPythonChildLine(lines, index);
    return childIndex === undefined ? index : ipythonPreviewIndex(lines, childIndex);
};

const getIPythonInputPresentation = (code: string) => {
    const lines = code.slice(0, IPYTHON_INPUT_SCAN_LENGTH).split(/\r?\n/);
    const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstContentLineIndex < 0) return { language: 'python', preview: '' };
    const firstContentLine = lines[firstContentLineIndex]?.trim() ?? '';
    if (/^%%bash(?:\s|$)/.test(firstContentLine)) {
        return {
            language: 'bash',
            preview: getIPythonBashPreview(lines.slice(firstContentLineIndex + 1)),
        };
    }
    let bestIndex = firstContentLineIndex;
    let bestScore = -1;
    for (let index = firstContentLineIndex; index < lines.length; index += 1) {
        const score = ipythonLineScore(lines, index);
        if (score > bestScore) {
            bestIndex = index;
            bestScore = score;
        }
    }
    return {
        language: 'python',
        preview: collapseIPythonPreview((lines[ipythonPreviewIndex(lines, bestIndex)] ?? '').trim()),
    };
};

type IPythonDiffSummary = { path: string; additions: number; deletions: number };

const getIPythonDiffSummaries = (metadata: Record<string, unknown> | undefined): IPythonDiffSummary[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files.slice(0, 64) : [];
    const byPath = new Map<string, IPythonDiffSummary>();
    for (const file of files) {
        if (!isRecord(file) || typeof file.relativePath !== 'string' || file.relativePath.length > 512) continue;
        const additions = Number.isSafeInteger(file.additions) && Number(file.additions) >= 0 ? Number(file.additions) : 0;
        const deletions = Number.isSafeInteger(file.deletions) && Number(file.deletions) >= 0 ? Number(file.deletions) : 0;
        const existing = byPath.get(file.relativePath);
        if (existing) {
            existing.additions += additions;
            existing.deletions += deletions;
        } else {
            byPath.set(file.relativePath, { path: file.relativePath, additions, deletions });
        }
    }
    return [...byPath.values()];
};

type IPythonDiffGroup = {
    id: string;
    title: string;
    entries: DiffPatchEntry[];
};

const groupIPythonDiffEntries = (entries: readonly DiffPatchEntry[]): IPythonDiffGroup[] => {
    const byPath = new Map<string, IPythonDiffGroup>();
    for (const entry of entries) {
        const key = entry.filePath ?? entry.title ?? entry.id;
        const existing = byPath.get(key);
        if (existing) {
            existing.entries.push(entry);
        } else {
            byPath.set(key, { id: `ipython-${key}`, title: entry.title, entries: [entry] });
        }
    }
    return [...byPath.values()];
};

const getIPythonLineCounts = (code: string, output: string | undefined, hasDiffs: boolean) => {
    const lines = code.split(/\r?\n/);
    const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
    const body = firstContentLineIndex >= 0 && /^%%bash(?:\s|$)/.test(lines[firstContentLineIndex]?.trim() ?? '')
        ? lines.slice(firstContentLineIndex + 1)
        : lines;
    const inputLines = body.filter((line) => line.trim().length > 0).length;
    const trimmedOutput = hasDiffs ? '' : (output ?? '').trim();
    return {
        input: inputLines,
        output: trimmedOutput ? trimmedOutput.split(/\r?\n/).length : 0,
    };
};

const formatIPythonDuration = (durationMs: unknown): string | null => {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
    return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
};

const GIT_REFRESH_MUTATING_TOOLS = new Set([
    'bash',
    'edit',
    'write',
    'apply_patch',
    'patch',
]);

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.max(0, (end ?? now) - start);
    const seconds = duration / 1000;

    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active, 250);

    return <>{formatDuration(start, end, now)}</>;
};

const deferredToolBodyMounts: Array<{ active: boolean; fn: () => void }> = [];
let deferredToolBodyFrame: number | undefined;

const flushDeferredToolBodyMounts = () => {
    while (deferredToolBodyMounts.length > 0) {
        const item = deferredToolBodyMounts.pop();
        if (!item) {
            break;
        }
        if (item.active) {
            item.fn();
            deferredToolBodyFrame = deferredToolBodyMounts.length > 0
                ? window.requestAnimationFrame(flushDeferredToolBodyMounts)
                : undefined;
            return;
        }
    }

    deferredToolBodyFrame = undefined;
};

const scheduleDeferredToolBodyMount = (fn: () => void) => {
    if (typeof window === 'undefined') {
        fn();
        return () => undefined;
    }

    const item = { active: true, fn };
    deferredToolBodyMounts.push(item);

    if (deferredToolBodyFrame === undefined) {
        deferredToolBodyFrame = window.requestAnimationFrame(() => {
            deferredToolBodyFrame = window.requestAnimationFrame(flushDeferredToolBodyMounts);
        });
    }

    return () => {
        item.active = false;
    };
};

const useDeferredExpandedContent = (isExpanded: boolean) => {
    // If the tool is expanded when the row first mounts (e.g. "show tools open
    // by default", or scrolling a default-open tool back into a virtualized
    // view), render the body SYNCHRONOUSLY so the virtualizer measures the real
    // height immediately. Deferring it would let the row mount short and grow a
    // frame later, which makes the virtualizer compensate scroll and lurch the
    // viewport past several messages on slow scroll. Only defer LATER
    // user-initiated expansions, where instant single-item feedback isn't worth
    // blocking the click on a heavy body render.
    const [shouldRender, setShouldRender] = React.useState(isExpanded);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        if (!isExpanded) {
            mountedRef.current = true;
            setShouldRender(false);
            return;
        }

        if (!mountedRef.current) {
            mountedRef.current = true;
            setShouldRender(true);
            return;
        }

        return scheduleDeferredToolBodyMount(() => {
            setShouldRender(true);
        });
    }, [isExpanded]);

    return shouldRender;
};

const parsePatchStats = (diffText: string | undefined): { added: number; removed: number } | null => {
    if (!diffText) return null;
    let added = 0;
    let removed = 0;
    let lineStart = 0;

    for (let index = 0; index <= diffText.length; index += 1) {
        if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
            continue;
        }

        const line = diffText.slice(lineStart, index);
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
        lineStart = index + 1;
    }

    if (added === 0 && removed === 0) return null;
    return { added, removed };
};

const parseDiffStats = (metadata?: Record<string, unknown>): { added: number; removed: number } | null => (
    parsePatchStats(
        getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff),
    )
);

const parseWriteLineCount = (input?: Record<string, unknown>): number | null => {
    if (!input?.content || typeof input.content !== 'string') return null;
    let lines = 1;
    for (let index = 0; index < input.content.length; index += 1) {
        if (input.content.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

const buildWritePreviewPatch = (filePath: string | undefined, content: string): string | undefined => {
    const normalizedContent = content.replace(/\r\n/g, '\n');
    if (!normalizedContent.trim()) {
        return undefined;
    }

    const normalizedPath = (() => {
        const candidate = (filePath ?? '').trim();
        if (!candidate) {
            return 'new-file';
        }
        return candidate.startsWith('/') ? candidate.slice(1) : candidate;
    })();

    const lines = normalizedContent.split('\n');
    const hunkSize = lines.length;
    const body = lines.map((line) => `+${line}`).join('\n');

    return [
        '--- /dev/null',
        `+++ b/${normalizedPath}`,
        `@@ -0,0 +1,${hunkSize} @@`,
        body,
    ].join('\n');
};

const normalizeDisplayPath = (value: string): string => {
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!trimmed || trimmed === '/') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '');
};

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
    const normalizedAbsolutePath = normalizeDisplayPath(absolutePath);
    const normalizedCurrentDirectory = normalizeDisplayPath(currentDirectory);

    if (!normalizedAbsolutePath) {
        return '';
    }

    if (!normalizedCurrentDirectory) {
        return normalizedAbsolutePath;
    }

    if (normalizedAbsolutePath === normalizedCurrentDirectory) {
        return '.';
    }

    const prefix = `${normalizedCurrentDirectory}/`;
    if (normalizedAbsolutePath.startsWith(prefix)) {
        return normalizedAbsolutePath.slice(prefix.length);
    }

    return normalizedAbsolutePath;
};

type ToolDiagnostic = {
    message: string;
    line: number;
    character: number;
};

type ToolDiagnosticSection = {
    displayPath: string;
    diagnostics: ToolDiagnostic[];
    remaining: number;
};

const TOOL_DIAGNOSTICS_MAX_PER_FILE = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const normalizeToolDiagnostic = (value: unknown): ToolDiagnostic | null => {
    if (!isRecord(value)) {
        return null;
    }

    const message = typeof value.message === 'string' ? value.message.trim() : '';
    if (!message) {
        return null;
    }

    const severity = typeof value.severity === 'number' && Number.isFinite(value.severity) ? Math.trunc(value.severity) : undefined;
    if (severity !== undefined && severity !== 1) {
        return null;
    }

    const range = isRecord(value.range) ? value.range : undefined;
    const start = range && isRecord(range.start) ? range.start : undefined;
    const rawLine = typeof start?.line === 'number' && Number.isFinite(start.line) ? Math.max(0, Math.trunc(start.line)) : 0;
    const rawCharacter = typeof start?.character === 'number' && Number.isFinite(start.character)
        ? Math.max(0, Math.trunc(start.character))
        : 0;

    return {
        message,
        line: rawLine + 1,
        character: rawCharacter + 1,
    };
};

const getToolDiagnosticSection = (
    toolName: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined,
    currentDirectory: string,
): ToolDiagnosticSection | null => {
    if (!['edit', 'multiedit', 'write', 'apply_patch'].includes(toolName)) {
        return null;
    }

    const primaryPath = getPrimaryToolPath(toolName, input, metadata);
    if (!primaryPath || !metadata || !isRecord(metadata.diagnostics)) {
        return null;
    }

    const normalizedPath = normalizeDisplayPath(primaryPath);
    const absolutePath = normalizedPath.startsWith('/')
        ? normalizedPath
        : `${normalizeDisplayPath(currentDirectory)}/${normalizedPath}`.replace(/\/+/g, '/');

    const rawDiagnostics = (metadata.diagnostics as Record<string, unknown>)[normalizedPath]
        ?? (metadata.diagnostics as Record<string, unknown>)[absolutePath];
    if (!Array.isArray(rawDiagnostics)) {
        return null;
    }

    const diagnostics = rawDiagnostics
        .map((entry) => normalizeToolDiagnostic(entry))
        .filter((entry): entry is ToolDiagnostic => !!entry);
    if (diagnostics.length === 0) {
        return null;
    }

    const visible = diagnostics.slice(0, TOOL_DIAGNOSTICS_MAX_PER_FILE);
    return {
        displayPath: normalizedPath.startsWith('/') ? getRelativePath(normalizedPath, currentDirectory) : normalizedPath,
        diagnostics: visible,
        remaining: Math.max(0, diagnostics.length - visible.length),
    };
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

    React.useEffect(() => {
        ensurePierreThemeRegistered(lightTheme);
        ensurePierreThemeRegistered(darkTheme);
    }, [darkTheme, lightTheme]);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        pierreTheme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
        pierreThemeType: currentVariant === 'dark' ? ('dark' as const) : ('light' as const),
    };
};

// Parse question tool output: "User has answered your questions: "Q1"="A1", "Q2"="A2". You can now..."
const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: Array<{ question: string; answer: string }> = [];
    const content = match[1];

    // Match "question"="answer" pairs, handling multiline answers
    const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
    let pairMatch;
    while ((pairMatch = pairRegex.exec(content)) !== null) {
        pairs.push({
            question: pairMatch[1],
            answer: pairMatch[2],
        });
    }

    return pairs.length > 0 ? pairs : null;
};

const getToolDescriptionPath = (part: TranscriptToolPart, state: TranscriptToolState, currentDirectory: string): string | null => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
        const filePath = firstFile?.relativePath || firstFile?.filePath;
        if (files.length > 1) return null;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
        return null;
    }

    if ((part.tool === 'edit' || part.tool === 'multiedit') && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (part.tool === 'read' && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (['write', 'create', 'file_write'].includes(part.tool) && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (part.tool === 'lsp' && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    return null;
};

const getLspToolDescription = (input: Record<string, unknown> | undefined, currentDirectory: string): string => {
    if (!input) {
        return '';
    }

    const operation = typeof input.operation === 'string' ? input.operation : 'lsp';
    if (operation === 'workspaceSymbol') {
        const query = typeof input.query === 'string' && input.query.trim().length > 0
            ? ` "${input.query.trim()}"`
            : '';
        return `${operation}${query}`;
    }

    const filePath = typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string'
                ? input.path
                : '';
    const displayPath = filePath ? getRelativePath(filePath, currentDirectory) : '';

    if (operation === 'documentSymbol') {
        return displayPath ? `${operation} ${displayPath}` : operation;
    }

    const line = typeof input.line === 'number' && Number.isFinite(input.line) ? Math.trunc(input.line) : undefined;
    const character = typeof input.character === 'number' && Number.isFinite(input.character) ? Math.trunc(input.character) : undefined;
    const position = line !== undefined && character !== undefined ? `:${line}:${character}` : '';

    return displayPath ? `${operation} ${displayPath}${position}` : operation;
};

const getToolDescription = (part: TranscriptToolPart, state: TranscriptToolState, currentDirectory: string): string => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    const filePathLabel = getToolDescriptionPath(part, state, currentDirectory);
    if (filePathLabel) {
        return filePathLabel;
    }

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        if (files.length > 1) {
            return `${files.length} files`;
        }
        return '';
    }

    // Question tool: show "Asked N question(s)"
    if (part.tool === 'question' && input?.questions && Array.isArray(input.questions)) {
        const count = input.questions.length;
        return `Asked ${count} question${count !== 1 ? 's' : ''}`;
    }

    if (part.tool === 'bash' && input?.command && typeof input.command === 'string') {
        const firstLine = input.command.split('\n')[0];
        return firstLine.substring(0, TOOL_DESCRIPTION_MAX_LENGTH);
    }

    if (part.tool === 'ipython' && typeof input?.code === 'string') {
        return getIPythonInputPresentation(input.code).preview;
    }

    if (part.tool === 'task' && input?.description && typeof input.description === 'string') {
        return input.description.substring(0, 80);
    }

    if (part.tool === 'lsp') {
        return getLspToolDescription(input, currentDirectory);
    }

    const desc = input?.description || metadata?.description || ('title' in state && state.title) || '';
    return getToolDescriptionFallback(part.tool, desc, input);
};

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
    followKey?: string;
}

const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
    followKey,
}) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const isFollowingRef = React.useRef(true);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (followKey === undefined) {
            isFollowingRef.current = true;
            return;
        }
        if (!element || !isFollowingRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
    }, [followKey]);

    return (
        <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
            <ScrollShadow
                ref={scrollRef}
                data-scrollable="true"
                onWheelCapture={(event) => {
                    if (followKey !== undefined && event.deltaY < 0) {
                        isFollowingRef.current = false;
                    }
                }}
                onScroll={(event) => {
                    if (followKey === undefined) {
                        return;
                    }
                    const element = event.currentTarget;
                    isFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
                }}
                className={cn(
                    'tool-output-surface p-2 rounded-xl w-full min-w-0',
                    maxHeightClass,
                    disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
                    className,
                )}
            >
                <div className="w-full min-w-0">
                    {children}
                </div>
            </ScrollShadow>
        </div>
    );
};

const getToolOutputLanguage = (
    output: string,
    part: TranscriptToolPart,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return 'bash';
    }

    return detectLanguageFromOutput(formatEditOutput(output, part.tool, metadata), part.tool, input);
};

const getToolOutputText = (
    output: string,
    part: TranscriptToolPart,
    metadata: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return output;
    }

    return formatEditOutput(output, part.tool, metadata);
};

const StreamingPlainTextOutput: React.FC<{ output: string }> = ({ output }) => {
    const preRef = React.useRef<HTMLPreElement>(null);
    const previousOutputRef = React.useRef('');

    React.useLayoutEffect(() => {
        const element = preRef.current;
        if (!element) {
            return;
        }

        const firstChild = element.firstChild;
        const textNode = firstChild instanceof globalThis.Text
            ? firstChild
            : document.createTextNode('');
        if (textNode !== firstChild) {
            element.replaceChildren(textNode);
        }

        const append = getStreamingOutputAppend(previousOutputRef.current, output);
        if (append === undefined) {
            textNode.data = output;
        } else if (append.length > 0) {
            textNode.appendData(append);
        }
        previousOutputRef.current = output;
    }, [output]);

    return (
        <pre
            ref={preRef}
            className="m-0 whitespace-pre-wrap break-words"
            style={{
                ...TOOL_COLLAPSED_CUSTOM_STYLE,
                lineHeight: 'round(var(--code-block-line-height), 1px)',
                overflowWrap: 'break-word',
            }}
        />
    );
};

const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: TranscriptToolPart;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isStreaming?: boolean;
}> = ({ output, part, metadata, input, isStreaming = false }) => {
    const { t } = useI18n();
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const [jsonViewMode, setJsonViewMode] = React.useState<'summary' | 'formatted' | 'raw'>('summary');
    const [copiedJson, setCopiedJson] = React.useState(false);

    React.useEffect(() => {
        setJsonViewMode('summary');
        setCopiedJson(false);
    }, [renderedOutput]);

    const handleJsonViewChange = React.useCallback((view: 'summary' | 'formatted' | 'raw', event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setJsonViewMode(view);
    }, []);

    const handleCopyOutput = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(renderedOutput);
        if (!result.ok) {
            toast.error(t('chat.toolPart.copyOutputFailed'));
            return;
        }
        setCopiedJson(true);
        if (typeof window !== 'undefined') {
            window.setTimeout(() => setCopiedJson(false), 1200);
        }
    }, [renderedOutput, t]);

    if (part.tool === 'bash' && isStreaming) {
        return (
            <div className="typography-code text-muted-foreground/90">
                <StreamingPlainTextOutput output={renderedOutput} />
            </div>
        );
    }

    if (jsonResult.isJson) {
        return (
            <div className="tool-output-surface relative p-2 rounded-xl w-full min-w-0">
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('summary', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showNavigableJson')}
                        title={t('chat.toolPart.showNavigableJson')}
                    >
                        <Icon name="list-unordered" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('formatted', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showFormattedJson')}
                        title={t('chat.toolPart.showFormattedJson')}
                    >
                        <Icon name="node-tree" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('raw', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showRawJson')}
                        title={t('chat.toolPart.showRawJson')}
                    >
                        <Icon name="code-box" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
                        onClick={handleCopyOutput}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                        title={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                    >
                        <Icon name={copiedJson ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
                    </Button>
                </div>
                {jsonViewMode === 'summary' ? (
                    <JsonSummaryView data={jsonResult.data} />
                ) : jsonViewMode === 'formatted' ? (
                    <JsonTreeViewer
                        data={jsonResult.data}
                        initiallyExpandedDepth={1}
                        maxHeight="400px"
                    />
                ) : (
                    <div className="typography-code pr-12 text-muted-foreground/90">
                        <WorkerHighlightedCode
                            language="json"
                            code={renderedOutput}
                            style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            codeStyle={CODE_TAG_PROPS.style}
                            wrap
                        />
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={part.tool === 'bash' ? 'typography-code text-muted-foreground/90' : undefined}>
            <WorkerHighlightedCode
                language={outputLanguage}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';

const getTaskSummaryLabel = (entry: TaskToolSummaryEntry): string => {
    const title = entry.state?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
        return title;
    }

    const input = entry.state?.input;
    if (input && typeof input === 'object') {
        const pathCandidate = input.filePath ?? input.file_path ?? input.path;
        if (typeof pathCandidate === 'string' && pathCandidate.trim().length > 0) {
            return pathCandidate.trim();
        }

        const urlCandidate = input.url;
        if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) {
            return urlCandidate.trim();
        }
    }

    return '';
};

const FILE_PATH_LABEL_TOOLS = new Set([
    'read',
    'view',
    'file_read',
    'cat',
    'write',
    'create',
    'file_write',
    'edit',
    'multiedit',
    'apply_patch',
]);

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!FILE_PATH_LABEL_TOOLS.has(toolName.toLowerCase())) {
        return false;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === 'Patch' || /^\d+\s+files$/.test(trimmed)) {
        return false;
    }

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return true;
    }

    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    if (baseName.startsWith('.') || baseName.includes('.')) {
        return true;
    }

    return /^[A-Za-z0-9_-]+$/.test(baseName);
};

const getTaskSummaryEntryRenderSignature = (entry: TaskToolSummaryEntry): string => {
    const toolName = normalizeToolName(entry.tool);
    const status = entry.state?.status ?? '';
    const label = getTaskSummaryLabel(entry);
    return `${entry.id ?? ''}\u0001${toolName}\u0001${status}\u0001${label}`;
};

const areTaskSummaryEntriesRenderEqual = (
    prevEntries: TaskToolSummaryEntry[],
    nextEntries: TaskToolSummaryEntry[],
): boolean => {
    if (prevEntries === nextEntries) return true;
    if (prevEntries.length !== nextEntries.length) return false;
    for (let index = 0; index < prevEntries.length; index += 1) {
        if (getTaskSummaryEntryRenderSignature(prevEntries[index]) !== getTaskSummaryEntryRenderSignature(nextEntries[index])) {
            return false;
        }
    }
    return true;
};

const TaskSummaryEntryRow = React.memo(({
    entry,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolRevealOnMount animate={animateTailText} wipe>
            {/* Single-line rows everywhere: the old mobile break-words mode
                wrapped long shell commands into a hanging column and floated
                the icon to the top of the block. Errors still wrap — they must
                stay readable. */}
            <div className={cn('flex gap-2 min-w-0 w-full', status === 'error' && isMobile ? 'items-start' : 'items-center')}>
                <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                <span
                    className="typography-meta text-foreground/80 flex-shrink-0"
                    style={{ color: 'var(--tools-title)' }}
                    title={displayName}
                >
                    {displayName}
                </span>
                {hasLabel ? (
                    status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                        renderAnimatedPathWithIcon(label, animateTailText, true, showToolFileIcons)
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                'typography-meta flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate',
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className="typography-meta flex-1 min-w-0 truncate text-muted-foreground/70"
                                style={{ color: 'var(--tools-description)' }}
                                title={label}
                            >
                                {label}
                            </Text>
                        )
                    )
                ) : null}
            </div>
        </ToolRevealOnMount>
    );
}, (prev, next) => {
    return prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && getTaskSummaryEntryRenderSignature(prev.entry) === getTaskSummaryEntryRenderSignature(next.entry);
});

TaskSummaryEntryRow.displayName = 'TaskSummaryEntryRow';

const TaskSummaryEntriesList = React.memo(({
    entries,
    isExpanded,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const visibleEntries = isExpanded ? entries : entries.slice(-6);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
    const visibleStartIndex = entries.length - visibleEntries.length;

    return (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
            <div className="w-full min-w-0 space-y-1">
                {hiddenCount > 0 ? (
                    <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                ) : null}

                {visibleEntries.map((entry, idx) => {
                    const absoluteIndex = isExpanded ? idx : visibleStartIndex + idx;
                    const rowKey = entry.id ?? `${getTaskSummaryEntryRenderSignature(entry)}:${absoluteIndex}`;
                    return (
                        <TaskSummaryEntryRow
                            key={rowKey}
                            entry={entry}
                            isMobile={isMobile}
                            animateTailText={animateTailText}
                            showToolFileIcons={showToolFileIcons}
                        />
                    );
                })}
            </div>
        </ToolScrollableSection>
    );
}, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && areTaskSummaryEntriesRenderEqual(prev.entries, next.entries);
});

TaskSummaryEntriesList.displayName = 'TaskSummaryEntriesList';

type TaskToolSummaryProps = {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
};

const TaskToolSummary: React.FC<TaskToolSummaryProps> = ({ entries, isExpanded, isMobile, output, sessionId, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const { t } = useI18n();
    const currentDirectory = useVisibleChatDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const runtime = React.useContext(RuntimeAPIContext);

    const trimmedOutput = typeof output === 'string'
        ? stripTaskMetadataFromOutput(output)
        : '';
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId && currentDirectory) {
            // In contexts with no ContextPanel (embedded session-chat iframe)
            // or single-surface layouts (mobile, VS Code), navigate in place.
            // Otherwise open a new side-panel tab.
            if (isEmbeddedSessionChat() || isMobile || runtime?.runtime.isVSCode) {
                setCurrentSession(sessionId, currentDirectory);
                return;
            }

            openContextPanelTab(currentDirectory, {
                mode: 'chat',
                dedupeKey: `session:${sessionId}`,
                label: agentType.charAt(0).toUpperCase() + agentType.slice(1),
                readOnly: true,
            });
        }
    };

    const agentType = typeof input?.subagent_type === 'string'
        ? input.subagent_type
        : 'subagent';

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]">
                <div className="typography-meta text-muted-foreground/70">
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                'before:top-[-0.25rem] before:bottom-0'
            )}
        >
            {entries.length > 0 ? (
                <TaskSummaryEntriesList
                    entries={entries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    animateTailText={animateTailText}
                    showToolFileIcons={showToolFileIcons}
                />
            ) : null}

            {sessionId && (
                <button
                    type="button"
                    className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="typography-meta text-primary font-medium">{t('chat.toolPart.openSubtask', { type: agentType.charAt(0).toUpperCase() + agentType.slice(1) })}</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('space-y-1', (entries.length > 0 || sessionId) && 'pt-1')}
                >
                    <button
                        type="button"
                        className="flex items-center gap-2 typography-meta text-foreground/80 hover:text-foreground w-full"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                    >
                        {isOutputExpanded ? (
                            <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        <span className="typography-meta text-foreground/80 font-medium">{t('chat.toolPart.output')}</span>
                    </button>
                    {isOutputExpanded ? (
                        <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                            <div className="w-full min-w-0">
                                <SimpleMarkdownRenderer content={trimmedOutput} variant="tool" onShowPopup={onShowPopup} />
                            </div>
                        </ToolScrollableSection>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

type ObservedTaskToolSummaryProps = TaskToolSummaryProps & {
    onEntriesChange?: () => void;
};

const ObservedTaskToolSummary: React.FC<ObservedTaskToolSummaryProps> = ({
    entries,
    onEntriesChange,
    ...props
}) => {
    const renderSignature = React.useMemo(
        () => entries.map(getTaskSummaryEntryRenderSignature).join('\u0000'),
        [entries],
    );
    const previousRenderSignatureRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const previous = previousRenderSignatureRef.current;
        previousRenderSignatureRef.current = renderSignature;
        if (previous === null || previous === renderSignature || entries.length === 0) return;
        onEntriesChange?.();
    }, [entries.length, onEntriesChange, renderSignature]);

    return <TaskToolSummary {...props} entries={entries} />;
};

type ConnectedTaskToolSummaryProps = Omit<TaskToolSummaryProps, 'entries' | 'sessionId'> & {
    currentDirectory: string;
    metadataEntries: TaskToolSummaryEntry[];
    onEntriesChange?: () => void;
    sessionId: string;
};

const ConnectedTaskToolSummary: React.FC<ConnectedTaskToolSummaryProps> = ({
    currentDirectory,
    metadataEntries,
    onEntriesChange,
    sessionId,
    ...props
}) => {
    const childSessionMessages = useSessionMessageRecords(sessionId, currentDirectory);
    useEnsureSessionMessages(sessionId, currentDirectory);
    const childEntries = React.useMemo(
        () => Array.isArray(childSessionMessages) && childSessionMessages.length > 0
            ? buildTaskSummaryEntriesFromSession(childSessionMessages)
            : [],
        [childSessionMessages],
    );
    const entries = childEntries.length > 0 ? childEntries : metadataEntries;

    return (
        <ObservedTaskToolSummary
            {...props}
            entries={entries}
            sessionId={sessionId}
            onEntriesChange={onEntriesChange}
        />
    );
};

interface DiffPreviewProps {
    diff: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
    diffViewMode: DiffViewMode;
}

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};

const TOOL_COLLAPSED_CUSTOM_STYLE: React.CSSProperties = {
    ...toolDisplayStyles.getCollapsedStyles(),
    padding: 0,
    overflow: 'visible',
};

const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

const TOOL_ERROR_ICON_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_ICON_STYLE: React.CSSProperties = { color: 'var(--tools-icon)' };
const TOOL_ERROR_TITLE_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_TITLE_STYLE: React.CSSProperties = { color: 'var(--tools-title)' };

const renderPathLikeGitChanges = (path: string, grow = true) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={path}
            >
                {path}
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0 text-muted-foreground">/</span> : null}
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>
                {displayDir}
            </span>
            <span className="flex-shrink-0">
                <span className="text-muted-foreground">/</span>
                <span className="text-foreground">{name}</span>
            </span>
        </span>
    );
};

const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true, showFileIcons = true) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}
                    style={{ color: 'var(--tools-title)' }}
                >
                    {path}
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}>
                {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
                <span
                    className="min-w-0 shrink truncate whitespace-nowrap"
                    style={{
                        color: 'var(--tools-description)',
                        direction: 'rtl',
                        textAlign: 'left',
                        unicodeBidi: 'plaintext',
                    }}
                >
                    {displayDir}
                </span>
                <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className="flex-shrink-0"
                    style={{ color: 'var(--tools-title)' }}
                >
                    {name}
                </Text>
            </span>
        </span>
    );
};

const PlainDiffFallback: React.FC<{ diff: string }> = ({ diff }) => (
    <pre
        className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 typography-code"
        style={{
            backgroundColor: 'var(--syntax-base-background)',
            color: 'var(--syntax-base-foreground)',
        }}
    >
        {diff}
    </pre>
);

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

const DiffPreview: React.FC<DiffPreviewProps> = React.memo(({ diff, pierreTheme, pierreThemeType, diffViewMode }) => {
    const options = React.useMemo(
        () => ({
            diffStyle: diffViewMode === 'side-by-side' ? 'split' as const : 'unified' as const,
            diffIndicators: 'none' as const,
            hunkSeparators: 'line-info-basic' as const,
            lineDiffType: 'none' as const,
            disableFileHeader: true,
            maxLineDiffLength: 1000,
            expansionLineCount: 20,
            overflow: 'wrap' as const,
            theme: pierreTheme,
            themeType: pierreThemeType,
            unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
        }),
        [diffViewMode, pierreTheme, pierreThemeType]
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

DiffPreview.displayName = 'DiffPreview';

interface ToolExpandedContentProps {
    part: TranscriptToolPart;
    state: TranscriptToolState;
    currentDirectory: string;
    isExpanded: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    onShowPopup,
}) => {
    const { t } = useI18n();
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const rawOutput = getToolOutput(part.tool, stateWithData.output, metadata?.output, state.status);
    const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
    const rawOutputString = typeof rawOutput === 'string' ? rawOutput : '';
    const isStreamingBash = part.tool === 'bash' && state.status === 'running';
    const throttledOutputString = useStreamingTextThrottle({
        text: rawOutputString,
        isStreaming: isStreamingBash,
        identityKey: part.id,
        allowTextReplacement: isStreamingBash,
    });
    const outputString = isStreamingBash ? throttledOutputString : rawOutputString;
    const attachments = stateWithData.attachments;
    const fileDiff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const diffContent = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff)
        ?? getPatchText(fileDiff?.patch)
        ?? getPatchText(fileDiff?.diff)
        ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const hasVisualDiffEntry = diffEntries.some((entry) => entry.renderMode === 'diff');
    const hideToolInputPreview = part.tool === 'openchamber'
        || part.tool === 'apply_patch'
        || part.tool === 'edit'
        || part.tool === 'multiedit';
    const diagnosticSection = React.useMemo(
        () => getToolDiagnosticSection(part.tool, input, metadata, currentDirectory),
        [currentDirectory, input, metadata, part.tool],
    );

    const inputTextContent = React.useMemo(() => {
        if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
            return '';
        }

        if ('command' in input && typeof input.command === 'string' && part.tool === 'bash') {
            return formatInputForDisplay(input, part.tool);
        }

        if (typeof (input as { content?: unknown }).content === 'string') {
            return (input as { content?: string }).content ?? '';
        }

        return formatInputForDisplay(input, part.tool);
    }, [input, part.tool]);
    const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
    const isIPythonTool = normalizeToolName(part.tool) === 'ipython';
    const ipythonInputPresentation = React.useMemo(() => (
        isIPythonTool && typeof input?.code === 'string'
            ? getIPythonInputPresentation(input.code)
            : null
    ), [input?.code, isIPythonTool]);
    const isIPythonInput = ipythonInputPresentation !== null;
    const ipythonDiffsOmitted = isIPythonTool
        && Number.isSafeInteger(metadata?.ipythonDiffsOmitted)
        && Number(metadata?.ipythonDiffsOmitted) > 0
        ? Number(metadata?.ipythonDiffsOmitted)
        : 0;
    const diffGroups = React.useMemo(
        () => isIPythonTool
            ? groupIPythonDiffEntries(diffEntries)
            : diffEntries.map((entry) => ({ id: entry.id, title: entry.title, entries: [entry] })),
        [diffEntries, isIPythonTool],
    );
    const isWriteLikeTool = part.tool === 'write' || part.tool === 'create' || part.tool === 'file_write';
    const isTodoTool = part.tool === 'todowrite' || part.tool === 'todoread';
    const todoContent = React.useMemo(() => {
        if (Array.isArray(input?.todos)) {
            return JSON.stringify(input.todos);
        }
        return outputString;
    }, [input?.todos, outputString]);
    const writeLikeInputPatch = React.useMemo(() => {
        if (!isWriteLikeTool || !hasInputText) {
            return undefined;
        }
        const filePath = typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : undefined;
        return buildWritePreviewPatch(filePath, inputTextContent);
    }, [hasInputText, input?.filePath, input?.file_path, input?.path, inputTextContent, isWriteLikeTool]);

    React.useEffect(() => {
        setDiffViewMode('unified');
    }, [part.id]);

    const renderScrollableBlock = (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string; followKey?: string }
    ) => (
        <ToolScrollableSection
            maxHeightClass={options?.maxHeightClass}
            className={options?.className}
            disableHorizontal={options?.disableHorizontal}
            outerClassName={options?.outerClassName}
            followKey={options?.followKey}
        >
            {content}
        </ToolScrollableSection>
    );

    const renderResultContent = () => {
        const getEntryAbsolutePath = (entry: DiffPatchEntry) => toAbsoluteFilePath(currentDirectory, entry.filePath ?? entry.title);
        const openEntryFile = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const line = extractFirstChangedLineFromDiff(entry.patch);
            const absolutePath = getEntryAbsolutePath(entry);
            if (runtime?.editor && runtime.runtime.isVSCode) {
                void runtime.editor.openFile(absolutePath, line);
                return;
            }
            useUIStore.getState().openContextFileAtLine(currentDirectory, absolutePath, line ?? 1, 1);
            // Dedicated mobile app: the pending file navigation is consumed by
            // the FilesView pane — surface it (workspace drawer Files tab).
            mobileActions?.openFiles();
        };
        const openEntryDiff = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const line = extractFirstChangedLineFromDiff(entry.patch);
            const absolutePath = getEntryAbsolutePath(entry);
            if (runtime?.editor && runtime.runtime.isVSCode) {
                void runtime.editor.openDiff('', absolutePath, `${getRelativePath(absolutePath, currentDirectory)} (changes)`, { line, patch: entry.patch });
                return;
            }
            const store = useUIStore.getState();
            const relativePath = getRelativePath(absolutePath, currentDirectory);
            if (store.isMobile) {
                store.navigateToDiff(relativePath);
                return;
            }
            store.openContextDiff(currentDirectory, relativePath);
        };
        const renderDiagnosticsSection = () => {
            if (!diagnosticSection) {
                return null;
            }

            return (
                <div
                    className="tool-output-surface rounded-xl border p-2 space-y-2"
                    style={{
                        borderColor: 'var(--status-error-border)',
                        backgroundColor: 'var(--status-error-background)',
                    }}
                >
                    <div className="typography-meta font-medium" style={{ color: 'var(--status-error)' }}>
                        {t('chat.toolPart.lspErrors')}
                    </div>
                    <div className="space-y-1">
                        <div className="flex items-center gap-1 min-w-0">
                            {renderPathLikeGitChanges(diagnosticSection.displayPath, false)}
                        </div>
                        <div className="space-y-1">
                            {diagnosticSection.diagnostics.map((diagnostic, index) => (
                                <div key={`${diagnosticSection.displayPath}:${diagnostic.line}:${diagnostic.character}:${index}`} className="rounded-md border px-2 py-1" style={{ borderColor: 'var(--status-error-border)', backgroundColor: 'var(--surface-elevated)' }}>
                                    <div className="flex items-start gap-2 min-w-0">
                                        <span className="typography-micro shrink-0" style={{ color: 'var(--status-error)' }}>
                                            [{diagnostic.line}:{diagnostic.character}]
                                        </span>
                                        <span className="typography-meta text-foreground whitespace-pre-wrap break-words">
                                            {diagnostic.message}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {diagnosticSection.remaining > 0 ? (
                            <div className="typography-micro text-muted-foreground">
                                {t('chat.toolPart.moreErrors', { count: diagnosticSection.remaining })}
                            </div>
                        ) : null}
                    </div>
                </div>
            );
        };

        // Question tool: show parsed Q&A summary or question content from input
        if (part.tool === 'question') {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <div className="typography-micro text-muted-foreground">{qa.question}</div>
                                    <div className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
                                </div>
                            ))}
                        </div>,
                        { maxHeightClass: 'max-h-[40vh]' }
                    );
                }
            }

            if (state.status === 'error' && 'error' in state) {
                return (
                    <div>
                        <div className="typography-meta font-medium text-muted-foreground mb-1">{t('chat.toolPart.error')}</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {coerceToText(state.error)}
                        </div>
                    </div>
                );
            }

            // Show question content from input whenever available, whether the tool is
            // pending/running or completed without parseable output. This ensures question
            // text persists across refreshes even if the QuestionCard store data is lost.
            const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
            if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
                return renderScrollableBlock(
                    <div className="space-y-2">
                        {questionInput.questions.map((q, index) => (
                            <div key={index} className="space-y-0.5">
                                {q.header ? (
                                    <div className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                                ) : null}
                                <div className="typography-meta text-foreground">{coerceToText(q.question)}</div>
                                {Array.isArray(q.options) && q.options.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {q.options.map((opt) => (
                                            <span key={coerceToText(opt.label)} className="typography-micro px-1.5 py-0.5 rounded bg-muted/30 border border-border/30 text-muted-foreground">
                                                {coerceToText(opt.label)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>,
                    { maxHeightClass: 'max-h-[40vh]' }
                );
            }

            return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.awaitingResponse')}</div>;
        }

        if (part.tool === 'task' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        const supportsRichDiff = part.tool === 'edit'
            || part.tool === 'multiedit'
            || part.tool === 'apply_patch'
            || part.tool === 'write'
            || isIPythonTool;
        if (supportsRichDiff && (diffEntries.length > 0 || !!diagnosticSection)) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {diffGroups.map((group) => {
                        let added = 0;
                        let removed = 0;
                        let hasStats = false;
                        for (const entry of group.entries) {
                            const stats = parsePatchStats(entry.patch);
                            if (!stats) continue;
                            hasStats = true;
                            added += stats.added;
                            removed += stats.removed;
                        }
                        const firstEntry = group.entries[0];
                        if (!firstEntry) return null;
                        const openable = group.entries.every((entry) => entry.openable !== false);
                        return (
                            <div key={group.id} className="w-full min-w-0">
                                <div className="mb-1 flex min-w-0 items-center gap-1 px-2 py-1">
                                    <div className="min-w-0 flex-1 typography-meta font-medium text-muted-foreground">
                                        {renderPathLikeGitChanges(group.title)}
                                    </div>
                                    {hasStats ? (
                                        <span className="flex shrink-0 items-center gap-1 typography-meta">
                                            <span style={{ color: 'var(--status-success)' }}>+{added}</span>
                                            <span style={{ color: 'var(--status-error)' }}>-{removed}</span>
                                        </span>
                                    ) : null}
                                    {openable ? (
                                        <>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                                onClick={(event) => openEntryFile(firstEntry, event)}
                                                aria-label={t('chat.toolPart.openFileAtFirstChange')}
                                                title={t('chat.toolPart.openFileAtFirstChange')}
                                            >
                                                <Icon name="file-edit" className="h-3.5 w-3.5" />
                                            </Button>
                                            {!isIPythonTool && group.entries.length === 1 ? (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                                    onClick={(event) => openEntryDiff(firstEntry, event)}
                                                    aria-label={t('chat.toolPart.openFileDiff')}
                                                    title={t('chat.toolPart.openFileDiff')}
                                                >
                                                    <Icon name="git-pull-request" className="h-3.5 w-3.5" />
                                                </Button>
                                            ) : null}
                                        </>
                                    ) : null}
                                </div>
                                <div className="space-y-2">
                                    {group.entries.map((entry) => entry.renderMode === 'diff' ? (
                                        <DiffPreview
                                            key={entry.id}
                                            diff={entry.patch}
                                            pierreTheme={pierreTheme}
                                            pierreThemeType={pierreThemeType}
                                            diffViewMode={diffViewMode}
                                        />
                                    ) : (
                                        <PlainDiffFallback key={entry.id} diff={entry.patch} />
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' }
            );
        }

        if (part.tool === 'write' && diagnosticSection) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' },
            );
        }

        if (isWriteLikeTool) {
            return null;
        }

        if (hasStringOutput && outputString.trim()) {
            const output = (
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    isStreaming={isStreamingBash}
                />
            );

            return renderScrollableBlock(
                output,
                {
                    className: part.tool === 'bash' ? 'p-1 rounded-none' : 'p-1',
                    maxHeightClass: isStreamingBash ? 'h-[46vh]' : part.tool === 'bash' ? 'max-h-[46vh]' : undefined,
                    followKey: isStreamingBash ? outputString : undefined,
                }
            );
        }

        if (isIPythonTool && ipythonDiffsOmitted > 0) return null;

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground/70">{t('chat.toolPart.noOutputProduced')}</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    const hasVisibleOutput = outputString.trim().length > 0;
    const shouldRenderResult = (state.status === 'completed' && 'output' in state)
        || (part.tool === 'bash' && hasVisibleOutput)
        || (isIPythonTool && (diffEntries.length > 0 || ipythonDiffsOmitted > 0));

    if (isTodoTool) {
        if (state.status === 'error' && 'error' in state) {
            return (
                <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                    <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{t('chat.toolPart.error')}</div>
                    <div className="typography-meta p-2 rounded-xl border" style={{
                        backgroundColor: 'var(--status-error-background)',
                        color: 'var(--status-error)',
                        borderColor: 'var(--status-error-border)',
                    }}>
                        {state.error}
                    </div>
                </div>
            );
        }

        const todoOutput = renderTodoOutput(todoContent, {
            total: t('chat.todo.total'),
            inProgress: t('chat.todo.inProgress'),
            pending: t('chat.todo.pending'),
            completed: t('chat.todo.completed'),
            cancelled: t('chat.todo.cancelled'),
        }, { unstyled: true });

        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                {renderScrollableBlock(
                    todoOutput ?? (
                        <ToolScrollableTextOutput
                            output={todoContent}
                            part={part}
                            metadata={metadata}
                            input={input}
                        />
                    ),
                    { className: 'p-2', maxHeightClass: 'max-h-[46vh]' },
                )}
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-4'
            )}
        >
            {part.tool === 'question' ? (
                renderResultContent()
            ) : (
                <>
                    {hasInputText ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                part.tool === 'bash' ? (
                                    <pre className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0">
                                        {inputTextContent}
                                    </pre>
                                ) : isIPythonInput ? (
                                    <WorkerHighlightedCode
                                        language={ipythonInputPresentation.language}
                                        code={inputTextContent}
                                        style={TOOL_COLLAPSED_CUSTOM_STYLE}
                                        codeStyle={CODE_TAG_PROPS.style}
                                        wrap
                                    />
                                ) : isWriteLikeTool && writeLikeInputPatch ? (
                                    <DiffPreview
                                        diff={writeLikeInputPatch}
                                        pierreTheme={pierreTheme}
                                        pierreThemeType={pierreThemeType}
                                        diffViewMode={diffViewMode}
                                    />
                                ) : (
                                    <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                                        {inputTextContent}
                                    </blockquote>
                                ),
                                {
                                    maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                                    className: part.tool === 'bash'
                                        ? 'tool-input-surface p-0 rounded-none'
                                        : isIPythonInput
                                            ? 'tool-input-surface p-2'
                                            : 'tool-input-surface',
                                }
                            )}
                        </div>
                    ) : null}

                    {shouldRenderResult && (
                        <div>
                            {(part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write' || isIPythonTool) && hasVisualDiffEntry ? (
                                <div className="mb-1 flex items-center justify-end gap-2">
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        className="h-5 w-5 p-0"
                                    />
                                </div>
                            ) : null}
                            {renderResultContent()}
                            {ipythonDiffsOmitted > 0 ? (
                                <div className="mt-1 px-2 typography-meta text-muted-foreground">
                                    {t('chat.toolPart.ipythonDiffsOmitted', { count: ipythonDiffsOmitted })}
                                </div>
                            ) : null}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div>
                            <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{t('chat.toolPart.error')}</div>
                            <div className="typography-meta p-2 rounded-xl border" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
                                borderColor: 'var(--status-error-border)',
                            }}>
                                {coerceToText(state.error)}
                            </div>
                        </div>
                    )}
                </>
            )}

            {Array.isArray(attachments) && attachments.length > 0 && state.status === 'completed' ? (
                <MessageFilesDisplay files={attachments} onShowPopup={onShowPopup} compact />
            ) : null}
        </div>
    );
});

ToolExpandedContent.displayName = 'ToolExpandedContent';

const ToolPartContent: React.FC<ToolPartProps> = ({
    part,
    isExpanded,
    onToggle,
    isMobile,
    onContentChange,
    onShowPopup,
    animateTailText = true,
}) => {
    const { t } = useI18n();
    const state = part.state;
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const showToolFileIcons = useUIStore((s) => s.showToolFileIcons);
    const currentDirectory = useVisibleChatDirectory() ?? '';

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = normalizedPartTool === 'task';

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isSuccessfullyFinalized = status === 'completed';
    const isError = status === 'error' || status === 'failed';

    const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
    const previousPartIdRef = React.useRef<string | undefined>(part.id);
    const observedActiveGitToolRef = React.useRef(!isFinalized);

    React.useEffect(() => {
        if (previousPartIdRef.current === part.id) {
            return;
        }
        previousPartIdRef.current = part.id;
        observedActiveGitToolRef.current = !isFinalized;
        // Reset latch only when tool identity changes.
        setActiveLatched(!isFinalized);
    }, [isFinalized, part.id]);

    React.useEffect(() => {
        if (!isFinalized) {
            setActiveLatched(true);
        }
    }, [isFinalized]);

    React.useEffect(() => {
        if (!isFinalized) {
            observedActiveGitToolRef.current = true;
            return;
        }

        // Historical completed tools can remount when the timeline changes.
        // Refresh only for a tool whose active state this instance observed.
        const finalizedAfterObservedActive = observedActiveGitToolRef.current;
        if (!finalizedAfterObservedActive) {
            return;
        }

        if (!isSuccessfullyFinalized || !GIT_REFRESH_MUTATING_TOOLS.has(normalizedPartTool)) {
            observedActiveGitToolRef.current = false;
            return;
        }
        if (!currentDirectory) {
            return;
        }

        observedActiveGitToolRef.current = false;
        const paths = getMutatedToolPaths(normalizedPartTool, input, metadata)
            .map((path) => getRelativePath(path, currentDirectory));
        sessionEvents.requestGitRefresh({
            directory: currentDirectory,
            ...(paths.length > 0 ? { paths } : {}),
        });
    }, [currentDirectory, input, isFinalized, isSuccessfullyFinalized, metadata, normalizedPartTool]);

    const shouldNotifyStructuralChange = isFinalized || isTaskTool;

    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const notifyTaskSummaryChange = React.useCallback(() => {
        onContentChangeRef.current?.('structural');
    }, []);
    const expandedContentRef = React.useRef<HTMLDivElement>(null);

    React.useLayoutEffect(() => {
        if (isTaskTool) {
            return;
        }

        const element = expandedContentRef.current;
        if (!element) {
            return;
        }

        element.style.height = isExpanded ? 'auto' : '0px';
        element.style.overflow = isExpanded ? 'visible' : 'hidden';

        if (shouldNotifyStructuralChange) {
            onContentChangeRef.current?.('structural');
        }
    }, [isExpanded, isTaskTool, shouldNotifyStructuralChange]);

    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;
    const time = stateWithData.time;

    const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>(() => ({
        start: typeof time?.start === 'number' ? time.start : undefined,
        end: typeof time?.end === 'number' ? time.end : undefined,
    }));
    const [localStartAt, setLocalStartAt] = React.useState<number | undefined>(undefined);
    const [localFinalizedAt, setLocalFinalizedAt] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        setPinnedTime({});
        setLocalStartAt(undefined);
        setLocalFinalizedAt(undefined);
    }, [part.id]);

    React.useEffect(() => {
        if (isFinalized) {
            return;
        }
        if (typeof time?.start === 'number') {
            return;
        }
        setLocalStartAt((prev) => prev ?? Date.now());
    }, [isFinalized, time?.start]);

    React.useEffect(() => {
        setPinnedTime((prev) => {
            const next = { ...prev };
            let changed = false;

            if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
                next.start = time.start;
                changed = true;
            }

            if (typeof time?.end === 'number' && (typeof prev.end !== 'number' || time.end > prev.end)) {
                next.end = time.end;
                changed = true;
            }

            return changed ? next : prev;
        });
    }, [time?.end, time?.start]);

    const effectiveTimeStart = React.useMemo(() => {
        // Once we captured a local start (during pending, before server sends time.start),
        // always prefer it so the timer never jumps when server start arrives later.
        if (typeof localStartAt === 'number') {
            return localStartAt;
        }
        const candidates = [pinnedTime.start, time?.start].filter(
            (value): value is number => typeof value === 'number'
        );
        if (candidates.length === 0) {
            return undefined;
        }
        return Math.min(...candidates);
    }, [localStartAt, pinnedTime.start, time?.start]);

    const taskOutputString = React.useMemo(() => {
        return typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    }, [stateWithData.output]);

    const parsedTaskMetadata = React.useMemo(() => {
        return parseTaskMetadataBlock(taskOutputString);
    }, [taskOutputString]);

    const metadataTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool) {
            return [];
        }
        const candidateSummary = (metadata as { summary?: unknown; entries?: unknown; tools?: unknown; calls?: unknown } | undefined);
        const normalized = normalizeTaskSummaryEntries(
            candidateSummary?.summary ?? candidateSummary?.entries ?? candidateSummary?.tools ?? candidateSummary?.calls
        );

        if (normalized.length > 0) {
            return normalized;
        }

        return parsedTaskMetadata.summaryEntries;
    }, [isTaskTool, metadata, parsedTaskMetadata.summaryEntries]);

    const hasFinalMetadataTaskSummary = isFinalized && metadataTaskSummaryEntries.length > 0;

    const taskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }

        // Current OpenCode publishes this authoritative join while the Task is
        // running. The remaining sources only support older persisted parts.
        const metadataSessionId = readTaskSessionIdFromRecord(metadata);
        if (metadataSessionId) {
            return metadataSessionId;
        }

        const partLevelSessionId = readTaskSessionIdFromRecord(partMetadata);
        if (partLevelSessionId) {
            return partLevelSessionId;
        }

        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, partMetadata, taskOutputString]);

    React.useEffect(() => {
        if (typeof time?.end === 'number' || typeof pinnedTime.end === 'number') {
            setLocalFinalizedAt(undefined);
            return;
        }

        if (typeof effectiveTimeStart !== 'number') {
            return;
        }

        if (!isFinalized) {
            return;
        }

        setLocalFinalizedAt((prev) => prev ?? Date.now());
    }, [
        effectiveTimeStart,
        isFinalized,
        pinnedTime.end,
        time?.end,
    ]);

    const effectiveTimeEnd = isFinalized ? (pinnedTime.end ?? time?.end ?? localFinalizedAt) : undefined;
    const isActive = !isFinalized && activeLatched;
    const shouldTreatAsFinalized = isFinalized;

    const diffStats = React.useMemo(() => {
        return (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool]);
    const writeLineCount = React.useMemo(() => {
        return normalizedPartTool === 'write' ? parseWriteLineCount(input) : null;
    }, [input, normalizedPartTool]);
    const isMultiFileApplyPatch = normalizedPartTool === 'apply_patch' && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as TranscriptToolPart) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const description = getToolDescription(normalizedPart, state, currentDirectory);
    const ipythonInputPresentation = React.useMemo(
        () => normalizedPartTool === 'ipython' && typeof input?.code === 'string'
            ? getIPythonInputPresentation(input.code)
            : null,
        [input?.code, normalizedPartTool],
    );
    const ipythonDiffSummaries = React.useMemo(
        () => normalizedPartTool === 'ipython' ? getIPythonDiffSummaries(metadata) : [],
        [metadata, normalizedPartTool],
    );
    const ipythonDiffsOmitted = normalizedPartTool === 'ipython'
        && Number.isSafeInteger(metadata?.ipythonDiffsOmitted)
        && Number(metadata?.ipythonDiffsOmitted) > 0
        ? Number(metadata?.ipythonDiffsOmitted)
        : 0;
    const ipythonLineCounts = React.useMemo(
        () => normalizedPartTool === 'ipython' && typeof input?.code === 'string'
            ? getIPythonLineCounts(input.code, stateWithData.output, ipythonDiffSummaries.length > 0)
            : null,
        [input?.code, ipythonDiffSummaries.length, normalizedPartTool, stateWithData.output],
    );
    const ipythonDuration = normalizedPartTool === 'ipython'
        ? formatIPythonDuration(metadata?.durationMs)
        : null;
    const isIPythonBashCell = ipythonInputPresentation?.language === 'bash';
    const displayName = isIPythonBashCell
        ? 'Bash'
        : getToolMetadata(normalizedPartTool || part.tool).displayName;
    
    // Tool title/description — shown inline as context
    const justificationText = React.useMemo(() => {
        if (normalizedPartTool === 'bash') {
            return null;
        }
        if (normalizedPartTool === 'apply_patch') {
            return null;
        }
        if (normalizedPartTool === 'lsp') {
            return null;
        }
        if (
            descriptionPath
            && (normalizedPartTool === 'apply_patch' || normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'write')
        ) {
            return null;
        }
        const title = (stateWithData as { title?: string }).title;
        if (typeof title === 'string' && title.trim().length > 0) {
            return title;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, normalizedPartTool, stateWithData, input]);
    const runtime = React.useContext(RuntimeAPIContext);

    const openApplyPatchFile = (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => {
        if (!runtime?.editor) {
            return;
        }

        event.stopPropagation();
        const displayPath = typeof file.relativePath === 'string'
            ? file.relativePath
            : typeof file.filePath === 'string'
                ? getRelativePath(file.filePath, currentDirectory)
                : '';
        openApplyPatchFileInEditor({
            currentDirectory,
            diffLabel: `${displayPath} (changes)`,
            editor: runtime.editor,
            file,
            isVSCode: runtime.runtime.isVSCode,
        });
    };

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        let toolDiff: string | undefined;
        if (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit') {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (normalizedPartTool === 'apply_patch') {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (['write', 'create', 'file_write'].includes(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        } else if (normalizedPartTool === 'lsp') {
            filePath = input?.filePath || input?.file_path || input?.path;
            const line = input?.line;
            targetLine = typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : undefined;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
            if (runtime.runtime.isVSCode && toolDiff && (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')) {
                const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { line: targetLine, patch: toolDiff });
                return;
            }
            runtime.editor.openFile(absolutePath, targetLine);
        } else {
            onToggle(part.id);
        }
    };

    const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    const iconStyle = !isTaskTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
    const titleStyle = !isTaskTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
    const shouldRenderTaskSummary = useDeferredExpandedContent(isTaskTool && (metadataTaskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || !!taskSessionId));
    const shouldRenderExpandedContent = useDeferredExpandedContent(!isTaskTool && isExpanded);

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    return (
        <div>
            {}
            <div
                className={cn(
                    'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl',
                    isMultiFileApplyPatch ? 'flex-wrap items-start cursor-pointer' : 'items-center cursor-pointer',
                )}
                onClick={isMultiFileApplyPatch ? () => onToggle(part.id) : handleMainClick}
                onKeyDown={isMultiFileApplyPatch ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onToggle(part.id);
                } : handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex gap-1.5', isMultiFileApplyPatch ? 'w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5' : 'items-center flex-shrink-0')}>
                    {isMultiFileApplyPatch ? (
                        <>
                            <div className="flex h-5 flex-shrink-0 items-center gap-1.5">
                                <span className="relative h-3.5 w-3.5 flex-shrink-0">
                                    <span className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded ? 'opacity-0' : 'group-hover/tool:opacity-0',
                                    )} style={iconStyle}>
                                        {getToolIcon(normalizedPartTool || part.tool)}
                                    </span>
                                    <Icon
                                        name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                        className={cn(
                                            'absolute inset-0 h-3.5 w-3.5 transition-opacity',
                                            isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                                        )}
                                    />
                                </span>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            <ApplyPatchFileButtons
                                metadata={metadata}
                                animate={animateTailText}
                                showFileIcons={showToolFileIcons}
                                textClassName={TOOL_ROW_DESCRIPTION_CLASS}
                                openDiffLabel={t('chat.toolPart.openFileDiff')}
                                onFileClick={runtime?.editor ? openApplyPatchFile : undefined}
                            />
                        </>
                    ) : (
                        <>
                            <div
                                // h-5 matches StaticToolRow's icon column, so expandable
                                // and static rows come out the same height (the 14px
                                // icon alone left these rows ~2px shorter).
                                className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer"
                                onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                            >
                                <div
                                    className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded && 'opacity-0',
                                        !isExpanded && 'group-hover/tool:opacity-0'
                                    )}
                                    style={iconStyle}
                                >
                                    {getToolIcon(normalizedPartTool || part.tool)}
                                </div>
                                <div
                                    className={cn(
                                        'absolute inset-0 transition-opacity flex items-center justify-center',
                                        isExpanded && 'opacity-100',
                                        !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                                    )}
                                >
                                    {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                    title={displayName}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            {normalizedPartTool === 'bash' && typeof effectiveTimeStart === 'number' ? (
                                <span className={cn('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)}>
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                        </>
                    )}
                </div>

                {!isMultiFileApplyPatch && (
                    <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                            {justificationText && (
                                <span
                                    className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                    style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && normalizedPartTool === 'lsp' && descriptionPath ? (
                                renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                            ) : null}
                            {!justificationText && normalizedPartTool !== 'lsp' && description && (
                                descriptionPath && description === descriptionPath ? (
                                    renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : 'static'}
                                        className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                        style={{ color: 'var(--tools-description)' }}
                                        title={description}
                                    >
                                        {description}
                                    </Text>
                                )
                            )}
                            {ipythonLineCounts && ipythonLineCounts.input > 0 ? (
                                <span className="flex-shrink-0 tabular-nums text-muted-foreground/80">
                                    · ↑ {ipythonLineCounts.input}{ipythonLineCounts.output > 0 ? ` ↓ ${ipythonLineCounts.output}` : ''} lines
                                </span>
                            ) : null}
                            {ipythonDuration ? (
                                <span className="flex-shrink-0 tabular-nums text-muted-foreground/80">· {ipythonDuration}</span>
                            ) : null}
                            {diffStats && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                                    <span style={{ color: 'var(--tools-description)' }}>/</span>
                                    <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
                                </span>
                            )}
                            {writeLineCount && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{writeLineCount}</span>
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {!isExpanded && (ipythonDiffSummaries.length > 0 || ipythonDiffsOmitted > 0) ? (
                <div className="ml-5 space-y-0.5 pr-2">
                    {ipythonDiffSummaries.map((summary) => (
                        <div key={summary.path} className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
                            <span className="shrink-0" aria-hidden="true">╰─</span>
                            <span className="min-w-0 flex-1 truncate" title={summary.path}>{summary.path}</span>
                            <span className="shrink-0 tabular-nums" style={{ color: 'var(--status-success)' }}>+{summary.additions}</span>
                            <span className="shrink-0 tabular-nums" style={{ color: 'var(--status-error)' }}>-{summary.deletions}</span>
                        </div>
                    ))}
                    {ipythonDiffsOmitted > 0 ? (
                        <div className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
                            <span className="shrink-0" aria-hidden="true">╰─</span>
                            <span className="min-w-0 flex-1 truncate">
                                {t('chat.toolPart.ipythonDiffsOmitted', { count: ipythonDiffsOmitted })}
                            </span>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {}
            {shouldRenderTaskSummary ? (
                currentDirectory && taskSessionId && !hasFinalMetadataTaskSummary ? (
                    <ConnectedTaskToolSummary
                        currentDirectory={currentDirectory}
                        metadataEntries={metadataTaskSummaryEntries}
                        isExpanded={isExpanded}
                        isMobile={isMobile}
                        output={taskOutputString}
                        sessionId={taskSessionId}
                        onShowPopup={onShowPopup}
                        input={input}
                        animateTailText={animateTailText}
                        isActive={isActive}
                        onEntriesChange={notifyTaskSummaryChange}
                    />
                ) : (
                    <ObservedTaskToolSummary
                        entries={metadataTaskSummaryEntries}
                        isExpanded={isExpanded}
                        isMobile={isMobile}
                        output={taskOutputString}
                        sessionId={taskSessionId}
                        onShowPopup={onShowPopup}
                        input={input}
                        animateTailText={animateTailText}
                        isActive={isActive}
                        onEntriesChange={notifyTaskSummaryChange}
                    />
                )
            ) : null}

            {!isTaskTool ? (
                <div
                    ref={expandedContentRef}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    {shouldRenderExpandedContent ? (
                        <div
                            className="relative ml-2 pl-3"
                        >
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                            <ToolExpandedContent
                                part={part}
                                state={state}
                                currentDirectory={currentDirectory}
                                isExpanded={isExpanded}
                                onShowPopup={onShowPopup}
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

class ToolPartErrorBoundary extends React.Component<{
    children: React.ReactNode;
    displayName: string;
    errorLabel: string;
    resetKey: unknown;
    toolName: string;
}, { hasError: boolean; error?: Error }> {
    state: { hasError: boolean; error?: Error } = { hasError: false };

    static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
        return { hasError: true, error };
    }

    componentDidUpdate(prevProps: { resetKey: unknown }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: undefined });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool part failed to render; showing safe fallback.', error);
        }
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const message = this.state.error?.message;
        return (
            <div className="flex items-center gap-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0">
                <div className="h-3.5 w-3.5 flex-shrink-0" style={TOOL_ERROR_ICON_STYLE}>
                    {getToolIcon(this.props.toolName)}
                </div>
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')} style={TOOL_ERROR_TITLE_STYLE}>
                    {this.props.displayName}
                </span>
                {message ? (
                    <span className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={message}>
                        {this.props.errorLabel}: {message}
                    </span>
                ) : null}
            </div>
        );
    }
}

const ToolPart: React.FC<ToolPartProps> = (props) => {
    const { t } = useI18n();
    const toolName = normalizeToolName(props.part.tool) || 'tool';
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolPartErrorBoundary
            displayName={displayName}
            errorLabel={t('chat.toolPart.error')}
            resetKey={props.part}
            toolName={toolName}
        >
            <ToolPartContent {...props} />
        </ToolPartErrorBoundary>
    );
};

export default React.memo(ToolPart, (prev, next) => {
    return areRenderRelevantPartsEqual([prev.part], [next.part])
        && prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.alwaysShowActions === next.alwaysShowActions
        && prev.onContentChange === next.onContentChange
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText;
});
