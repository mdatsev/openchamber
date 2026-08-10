import React from 'react';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import { ChatInput } from './ChatInput';
import { PrimeComposer, PrimeDraftComposer } from './PrimeComposer';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { StatusRowContainer } from './StatusRowContainer';
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { PromptNavigatorRail, type PromptNavigatorEntry } from './components/PromptNavigatorRail';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatAutoFollow, type AnimationHandlers, type ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessionMessageLoadState,
    useSessionParts,
    useSyncDirectory,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSession,
    useSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { usePlanDetection } from '@/hooks/usePlanDetection';
import { useI18n } from '@/lib/i18n';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getEmbeddedSessionChatOriginSessionId } from '@/components/layout/contextPanelEmbeddedChat';
import { resolveChatPromptReadOnly } from './chatPromptReadOnly';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createFirstVisibleSessionPerformanceTracker } from '@/sync/session-load-performance';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { adaptOpenCodeMessage, adaptOpenCodeMessages } from './transcript/openCodeTranscriptAdapter';
import type { TranscriptMessage, TranscriptMessageActions } from './transcript/types';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ensurePrimeCatalog } from '@/stores/usePrimeCatalogStore';
import { getContextObligatoryMessages } from '@/lib/contextObligatoryMessages';
import { setContextObligatoryMessage } from '@/sync/session-actions';
import { useShallow } from 'zustand/react/shallow';
import type { ChatHarness, ChatIdentity } from '@/lib/chat-identity';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useChatSelectionStore } from '@/stores/useChatSelectionStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import {
    getPrimeTranscriptKey,
    loadEarlierPrimeTranscript,
    loadPrimeTranscript,
    usePrimeTranscriptStore,
} from '@/stores/usePrimeTranscriptStore';
import {
    activatePrimeSessionFromUserSelection,
    getPrimeLiveKey,
    suspendHiddenPrimeLiveSessions,
    usePrimeLiveStore,
} from '@/stores/usePrimeLiveStore';
import {
    getPrimeDraftComposerKey,
    selectPrimeDraftCreationPending,
    usePrimeComposerStore,
} from '@/stores/usePrimeComposerStore';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const CHAT_SCROLL_STYLE = {
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
const CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[data-radix-popper-content-wrapper]',
].join(',');
const isHTMLElement = (target: EventTarget | null): target is HTMLElement => {
    return target instanceof HTMLElement;
};

const shouldIgnoreChatNavigationTarget = (target: EventTarget | null): boolean => {
    if (!isHTMLElement(target)) {
        return false;
    }

    return Boolean(target.closest(CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR));
};

const shouldIgnoreChatNavigationForFocus = (activeElement: Element | null, scrollContainer: HTMLElement | null): boolean => {
    if (typeof document === 'undefined') {
        return true;
    }

    if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
        return true;
    }

    if (shouldIgnoreChatNavigationTarget(activeElement)) {
        return true;
    }

    return !scrollContainer?.contains(activeElement);
};

const hasBlockingChatOverlay = (): boolean => {
    const {
        isAboutDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isImagePreviewOpen,
        isMultiRunLauncherOpen,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
    } = useUIStore.getState();

    return isAboutDialogOpen
        || isCommandPaletteOpen
        || isHelpDialogOpen
        || isImagePreviewOpen
        || isMultiRunLauncherOpen
        || isSessionSwitcherOpen
        || isSettingsDialogOpen;
};

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

type ChatViewportProps = {
    currentSessionId: string;
    currentSessionKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    stickyUserHeader: boolean;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    pendingRevealWork: boolean;
    renderedMessages: TranscriptMessage[];
    activeStreamingMessage: TranscriptMessage | null;
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('./message/types').StreamPhase | null;
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    handleHistoryScroll: () => void;
    scrollToBottom: () => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    isProgrammaticFollowActive: boolean;
    showLoadOlderButton: boolean;
    onLoadOlder: () => void;
    turnIds: string[];
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    showPromptNavigator: boolean;
    canLoadEarlierPrompts: boolean;
    isLoadingOlderPrompts: boolean;
    onLoadEarlierPrompts: () => void;
    messageActions?: TranscriptMessageActions;
    reviewTransferDirection?: ReviewTransferDirection | null;
    showConnectedFooter?: boolean;
};

const ChatViewport = React.memo(({
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    directory,
    scrollRef,
    messageListRef,
    pendingRevealWork,
    renderedMessages,
    activeStreamingMessage,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleHistoryScroll,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    onLoadOlder,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
    messageActions,
    reviewTransferDirection,
    showConnectedFooter = true,
}: ChatViewportProps) => {
    const { t } = useI18n();
    const promptEntries = React.useMemo<PromptNavigatorEntry[]>(() => {
        const messageById = new Map(renderedMessages.map((message) => [message.id, message]));
        return turnIds.flatMap((turnId) => {
            const preview = messageById.get(turnId)?.promptPreview;
            return preview ? [{ turnId, preview }] : [];
        });
    }, [renderedMessages, turnIds]);
    const promptTurnIdSet = React.useMemo(() => new Set(promptEntries.map((entry) => entry.turnId)), [promptEntries]);
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || promptTurnIdSet.has(activeTurnId)) return activeTurnId;
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (promptTurnIdSet.has(turnId)) return turnId;
        }
        return null;
    }, [activeTurnId, promptTurnIdSet, turnIds]);
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);

    return (
        <div
            className={cn(
                'relative min-h-0',
                isDesktopExpandedInput
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'flex-1'
            )}
            aria-hidden={isDesktopExpandedInput}
        >
            <div className="absolute inset-0">
                <ScrollShadow
                    className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target"
                    ref={scrollRef}
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow={isMobile && stickyUserHeader}
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    onScroll={handleHistoryScroll}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className="relative z-0 min-h-full">
                        {showLoadOlderButton && (
                            <div className="flex justify-center pt-3 pb-1">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={onLoadOlder}
                                    disabled={isLoadingOlder}
                                >
                                    {isLoadingOlder && (
                                        <Icon name="loader-4" className="size-4 animate-spin" />
                                    )}
                                    {t('chat.history.loadOlder')}
                                </Button>
                            </div>
                        )}
                        <MessageList
                            key={currentSessionKey}
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            disableStaging={pendingRevealWork}
                            messages={renderedMessages}
                            activeStreamingMessage={activeStreamingMessage}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            isLoadingOlder={isLoadingOlder}
                            scrollToBottom={scrollToBottom}
                            scrollRef={scrollRef}
                            messageActions={messageActions}
                            reviewTransferDirection={reviewTransferDirection}
                        />
                        {(sessionQuestions.length > 0 || sessionPermissions.length > 0) && (
                            <div>
                                {sessionQuestions.map((question) => (
                                    <QuestionCard key={question.id} question={question} />
                                ))}
                                {sessionPermissions.map((permission) => (
                                    <PermissionCard key={permission.id} permission={permission} />
                                ))}
                            </div>
                        )}

                        {showConnectedFooter ? (
                            <>
                                <SessionRecapNote sessionId={currentSessionId} directory={directory} isMobile={isMobile} />
                                <div className="mb-3">
                                    <StatusRowContainer />
                                </div>
                            </>
                        ) : null}

                        <div className="flex-shrink-0" style={{ height: isMobile ? '40px' : '10vh' }} aria-hidden="true" />
                    </div>
                </ScrollShadow>
                <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
                {showPromptNavigator && promptEntries.length >= 2 ? (
                    <PromptNavigatorRail
                        entries={promptEntries}
                        activeTurnId={railActiveTurnId}
                        onSelectTurn={onSelectTurn}
                        canLoadEarlier={canLoadEarlierPrompts}
                        isLoadingOlder={isLoadingOlderPrompts}
                        onLoadEarlier={onLoadEarlierPrompts}
                    />
                ) : null}
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.currentSessionKey === next.currentSessionKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.stickyUserHeader === next.stickyUserHeader
        && prev.directory === next.directory
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.pendingRevealWork === next.pendingRevealWork
        && prev.renderedMessages === next.renderedMessages
        && prev.activeStreamingMessage === next.activeStreamingMessage
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleHistoryScroll === next.handleHistoryScroll
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive
        && prev.showLoadOlderButton === next.showLoadOlderButton
        && prev.onLoadOlder === next.onLoadOlder
        && prev.turnIds === next.turnIds
        && prev.activeTurnId === next.activeTurnId
        && prev.onSelectTurn === next.onSelectTurn
        && prev.showPromptNavigator === next.showPromptNavigator
        && prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts
        && prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts
        && prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts
        && prev.messageActions === next.messageActions
        && prev.reviewTransferDirection === next.reviewTransferDirection
        && prev.showConnectedFooter === next.showConnectedFooter;
});

ChatViewport.displayName = 'ChatViewport';

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-64' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
    {
        id: 2,
        toolRows: [
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-40' },
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-48' },
        ],
        textWidths: ['w-20', 'w-[88%]', 'w-[70%]'],
    },
    {
        id: 3,
        toolRows: [
            { id: 'shell', titleWidth: 'w-28', detailWidth: 'w-44' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-56' },
        ],
        textWidths: ['w-24', 'w-[84%]', 'w-[64%]'],
    },
];

const ReadOnlyPromptBanner: React.FC = () => {
    const { t } = useI18n();

    return (
        <div className="p-3">
            <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 typography-ui-label text-muted-foreground">
                {t('chat.container.readOnlySubagentPromptBanner')}
            </div>
        </div>
    );
};

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    return label || formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

const DRAFT_HARNESS_LABEL_KEYS = {
    opencode: 'sessions.harness.openCode',
    prime: 'sessions.harness.primeAgent',
} as const satisfies Record<ChatHarness, 'sessions.harness.openCode' | 'sessions.harness.primeAgent'>;

const DraftHarnessPicker: React.FC = () => {
    const { t } = useI18n();
    const harness = useSessionUIStore((state) => state.newSessionDraft.harness ?? 'opencode');
    const setHarness = useSessionUIStore((state) => state.setNewSessionDraftHarness);

    return (
        <div
            role="group"
            aria-label={t('chat.draftHarness.pickerAria')}
            className="flex shrink-0 items-center justify-center gap-1 px-3 pt-3"
        >
            {(['opencode', 'prime'] as const).map((candidate) => (
                <Button
                    key={candidate}
                    variant="chip"
                    size="xs"
                    aria-pressed={harness === candidate}
                    onClick={() => {
                        setHarness(candidate);
                        if (candidate === 'prime') useUIStore.getState().setExpandedInput(false);
                    }}
                >
                    {t(DRAFT_HARNESS_LABEL_KEYS[candidate])}
                </Button>
            ))}
        </div>
    );
};

const DraftWelcome: React.FC = () => {
    const { t } = useI18n();
    const harness = useSessionUIStore((state) => state.newSessionDraft.harness ?? 'opencode');
    const selectedProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId ?? null);
    const targetDirectory = useSessionUIStore((state) => (
        state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride
    ));
    const primeDraftKey = React.useMemo(() => {
        const identity = createChatDraftIdentity(getRuntimeKey(), targetDirectory, null, 'prime');
        return identity ? getPrimeDraftComposerKey(identity) : null;
    }, [targetDirectory]);
    const primeCreationPending = usePrimeComposerStore((state) => (
        primeDraftKey
            ? selectPrimeDraftCreationPending(state, getRuntimeKey())
            : false
    ));
    const projectLabel = useProjectsStore(React.useCallback((state) => {
        const projectId = selectedProjectId ?? state.activeProjectId;
        const project = (projectId
            ? state.projects.find((candidate) => candidate.id === projectId)
            : null) ?? state.projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [selectedProjectId]));

    return (
        <div className="oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
                {renderDraftTitle(
                    projectLabel
                        ? t('chat.emptyState.draftTitleWithProject', { project: projectLabel })
                        : t('chat.emptyState.draftTitle'),
                    projectLabel,
                )}
            </h1>
            <fieldset
                disabled={harness === 'prime' && primeCreationPending}
                aria-busy={harness === 'prime' && primeCreationPending}
                className="oc-draft-starters mt-8 max-w-md disabled:opacity-50"
            >
                <DraftPresetChips
                    onSubmit={(starter) => useInputStore.getState().requestPresetSubmit(
                        starter.submitText,
                        starter.ref.type,
                        harness,
                    )}
                />
            </fieldset>
        </div>
    );
};

type ChatContainerProps = {
    active?: boolean;
    autoOpenDraft?: boolean;
    readOnly?: boolean;
};

const OpenCodeChatContainer: React.FC<ChatContainerProps> = ({ active = true, autoOpenDraft = true, readOnly = false }) => {
    const { t } = useI18n();
    // Session UI state
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const visibleChatIdentity = useChatSelectionStore((state) => state.visibleChatIdentity);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const currentSessionKey = currentSessionId
        ? JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId])
        : null;
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, false, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );
    const loadMoreMessages = React.useCallback(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming state
    const streamingMessageId = useStreamingStore(
        React.useCallback(
            (s) => (currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId],
        ),
    );
    const activeStreamingPhase = useStreamingStore(
        React.useCallback(
            (s) => {
                if (!streamingMessageId) return null;
                return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
            },
            [streamingMessageId],
        ),
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const hasRenderableSessionSnapshot = useSessionRenderable(currentSessionId ?? '', effectiveSessionDirectory);
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {
        enabled: active,
        suspendPartUpdates: Boolean(streamingMessageId),
        suspendPartUpdatesForMessageId: streamingMessageId,
    });
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const liveStreamingParts = useSessionParts(streamingMessageId ?? '', effectiveSessionDirectory);
    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
    const transcriptMessages = React.useMemo(
        () => adaptOpenCodeMessages(sessionMessages, { planModeEnabled }),
        [planModeEnabled, sessionMessages],
    );
    const sessionMessageLoadState = useSessionMessageLoadState(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const [firstVisiblePerformance] = React.useState(createFirstVisibleSessionPerformanceTracker);

    React.useEffect(() => {
        if (!active || !currentSessionKey || !hasRenderableSessionSnapshot || sessionMessages.length === 0) return;
        return firstVisiblePerformance.schedule(currentSessionKey, sessionMessages.length);
    }, [active, currentSessionKey, firstVisiblePerformance, hasRenderableSessionSnapshot, sessionMessages.length]);

    // Plan detection - watches messages for plan creation and signals store
    usePlanDetection(currentSessionId ?? '', sessionMessages);

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/questions for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionQuestions = useScopedBlockingQuestions(currentSessionId, effectiveSessionDirectory);

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        const lastMessage = sessionMessages[sessionMessages.length - 1]?.info as Message | undefined;
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
        );
    }, [currentSessionId, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!activeRetryStatus) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);

    // History metadata — use sync's hasMore/isLoading
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        return {
            limit: sessionMessages.length,
            complete: sessionMessageLoadState.complete || !sessionMessageLoadState.cursor,
            loading: sessionMessageLoadState.status === 'loading',
        };
    }, [currentSessionId, sessionMessageLoadState.complete, sessionMessageLoadState.cursor, sessionMessageLoadState.status, sessionMessages.length]);

    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const draftHarness = newSessionDraft?.harness ?? 'opencode';
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile too: the mobile
    // composer enters the same fullscreen-input mode via its drag handle.
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    const messageListRef = React.useRef<MessageListHandle | null>(null);
    const currentSession = useSession(currentSessionId, effectiveSessionDirectory);
    const parentSession = useParentSession(currentSessionId, effectiveSessionDirectory);
    const contextPinnedMessageIds = useGlobalSessionsStore(useShallow((state) => {
        if (!currentSessionId) return [];
        const session = state.activeSessions.find((candidate) => candidate.id === currentSessionId)
            ?? state.archivedSessions.find((candidate) => candidate.id === currentSessionId);
        return getContextObligatoryMessages(session).map((entry) => entry.id).sort();
    }));
    const contextPinnedMessageIdSet = React.useMemo(
        () => new Set(contextPinnedMessageIds),
        [contextPinnedMessageIds],
    );
    const reviewTransferDirection = useGlobalSessionsStore((state) => (
        currentSessionId ? state.reviewTransferBySessionId.get(currentSessionId) ?? null : null
    ));
    const transcriptMessageActions = React.useMemo<TranscriptMessageActions | undefined>(() => {
        if (!currentSessionId) return undefined;
        return {
            revert: (messageId) => {
                useSessionUIStore.getState().revertToMessage(currentSessionId, messageId);
            },
            fork: (messageId) => {
                useSessionUIStore.getState().forkFromMessage(currentSessionId, messageId);
            },
            isContextPinned: (messageId) => contextPinnedMessageIdSet.has(messageId),
            ...(!isVSCode ? {
                setContextPinned: async (
                    messageId: string,
                    createdAt: number,
                    role: 'user' | 'assistant',
                    pinned: boolean,
                ) => {
                    await setContextObligatoryMessage(currentSessionId, effectiveSessionDirectory, {
                        id: messageId,
                        createdAt,
                        role,
                    }, pinned);
                },
            } : null),
        };
    }, [contextPinnedMessageIdSet, currentSessionId, effectiveSessionDirectory, isVSCode]);

    // In the embedded session-chat iframe, hide "Return to parent" when
    // viewing the panel's anchor session (the one recorded in the URL). Going
    // up from the anchor would show the primary session that's already in the
    // main chat. Drilling into a deeper subtask (currentSessionId ≠ anchor)
    // re-enables the button to navigate back to the embedded session.
    const embeddedPanelAnchorSessionId = getEmbeddedSessionChatOriginSessionId();
    const hideReturnToParent =
        embeddedPanelAnchorSessionId !== null && currentSessionId === embeddedPanelAnchorSessionId;

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        setCurrentSession(parentSession.id, parentDirectory);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession && !hideReturnToParent ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSession.title?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSession.title })
                : t('chat.container.returnToParent.title')}
        >
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;
    const promptReadOnly = resolveChatPromptReadOnly(currentSession, allowPromptingSubagentSessions, readOnly);

    React.useEffect(() => {
        // VS Code/Cursor/Positron webviews delete window.parent (and window.top).
        // The old `window.parent === window` check does not catch that, so
        // `window.parent.postMessage(...)` threw on chat open:
        // TypeError: Cannot read properties of undefined (reading 'postMessage')
        if (typeof window === 'undefined' || !window.parent || window.parent === window) {
            return;
        }

        const parentWindow = window.parent;
        const applySetting = (value: boolean) => {
            useUIStore.getState().setAllowPromptingSubagentSessions(value);
        };
        const scopedWindow = window as typeof window & {
            __openchamberApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        const applySync = (payload: { allowPromptingSubagentSessions: boolean }) => {
            applySetting(payload.allowPromptingSubagentSessions);
        };
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== parentWindow || event.origin !== window.location.origin) return;
            const data = event.data as { type?: unknown; payload?: { allowPromptingSubagentSessions?: unknown } };
            if (data?.type !== 'openchamber:chat-settings-sync'
                || typeof data.payload?.allowPromptingSubagentSessions !== 'boolean') return;
            applySetting(data.payload.allowPromptingSubagentSessions);
        };

        scopedWindow.__openchamberApplyChatSettingsSync = applySync;
        window.addEventListener('message', handleMessage);
        parentWindow.postMessage({ type: 'openchamber:chat-settings-request' }, window.location.origin);
        return () => {
            window.removeEventListener('message', handleMessage);
            if (scopedWindow.__openchamberApplyChatSettingsSync === applySync) {
                delete scopedWindow.__openchamberApplyChatSettingsSync;
            }
        };
    }, []);

    React.useEffect(() => {
        const visiblePrimeSession = visibleChatIdentity?.runtimeKey === getRuntimeKey()
            && visibleChatIdentity.harness === 'prime';
        if (autoOpenDraft && !currentSessionId && !draftOpen && !visiblePrimeSession) {
            // Programmatic fallback, not user navigation — must not clear the
            // persisted last-session pointer the cold-launch restore reads.
            openNewSessionDraft({ automatic: true });
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, openNewSessionDraft, visibleChatIdentity]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
    } = useChatAutoFollow({
        currentSessionId,
        currentSessionKey,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
    });

    const viewportMessages = transcriptMessages;

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const renderedTranscriptMessages = timelineController.renderedMessages;
    const activeStreamingMessage = React.useMemo(() => {
        if (!streamingMessageId) return null;
        const sourceMessage = sessionMessages.find((message) => message.info.id === streamingMessageId);
        if (!sourceMessage) return null;
        return adaptOpenCodeMessage({ ...sourceMessage, parts: liveStreamingParts }, { planModeEnabled });
    }, [liveStreamingParts, planModeEnabled, sessionMessages, streamingMessageId]);

    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);
    // Mobile loads older history via an explicit top button instead of a
    // scroll-position trigger (see handleHistoryScroll in the controller).
    const showLoadOlderButton = isMobileSurfaceRuntime()
        && timelineController.historySignals.canLoadEarlier;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = React.useCallback(() => {
        void timelineLoadEarlier({ userInitiated: true });
    }, [timelineLoadEarlier]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    }, [navigation]);
    const canLoadEarlierPrompts = timelineController.historySignals.canLoadEarlier;
    const showPromptNavigator = !isMobile
        && !isVSCode
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [showPromptNavigator]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId || isDesktopExpandedInput) {
            return;
        }

        const handleChatTurnKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
                return;
            }

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }

            const { activeMainTab } = useUIStore.getState();
            if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
                return;
            }

            const scrollContainer = scrollRef.current;
            if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
                return;
            }

            if (shouldIgnoreChatNavigationTarget(event.target)) {
                return;
            }

            event.preventDefault();
            const offset = event.key === 'ArrowUp' ? -1 : 1;
            void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
        };

        window.addEventListener('keydown', handleChatTurnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleChatTurnKeyDown);
        };
    }, [currentSessionId, isDesktopExpandedInput, navigation, scrollRef]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        let rafId = 0;
        const scheduleUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateChatScrollHeight();
            });
        };

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', scheduleUpdate);
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', scheduleUpdate);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const lastScrolledSessionKeyRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const retrySessionLoad = React.useCallback(() => {
        if (!active || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId, true, effectiveSessionDirectory);
    }, [active, currentSessionId, effectiveSessionDirectory, sync]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (lastScrolledSessionKeyRef.current === currentSessionKey) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionKeyRef.current = currentSessionKey;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [active, currentSessionId, currentSessionKey, releaseAutoFollow, restoreSnapshot]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (hasRenderableSessionSnapshot) return;
        void ensureSessionRenderable(currentSessionId);
    }, [active, currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot]);

	if (!currentSessionId && !draftOpen) {
		// With auto-open, the draft welcome opens on the next tick (effect below),
		// so the empty state is only ever transient here — render a neutral
		// background instead of flashing the logo / "start a new chat" on refresh.
		// Keep the empty state when there's nothing to auto-open or an init error to show.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

    if (!currentSessionId && draftOpen) {
        const compactDraftLayout = useCompactDraftLayout;
        return (
            // No transform on this root: it would become the containing block for
            // the fullscreen composer's position:fixed visual-viewport pinning in
            // mobile browsers (see ChatInput's composerFormRef effect).
            <div data-composer-bound className="relative flex h-full flex-col bg-background">
                <DraftHarnessPicker />
                {compactDraftLayout && !isDesktopExpandedInput ? <DraftWelcome /> : null}
                <div
                    className={cn(
                        'relative z-10 flex min-h-0',
                        isDesktopExpandedInput
                            ? 'flex-1 bg-background'
                            : compactDraftLayout
                                ? 'bg-background px-0'
                                : 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]'
                    )}
                >
                    {promptReadOnly
                        ? <ReadOnlyPromptBanner />
                        : draftHarness === 'prime'
                            ? <PrimeDraftComposer />
                            : <ChatInput scrollToBottom={scrollToBottomOnSend} />}
                </div>
            </div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking) {
		if (sessionMessageLoadState.status === 'error') {
			return (
				<div data-composer-bound className="relative flex h-full flex-col bg-background">
					{returnToParentButton}
					<div className="flex min-h-0 flex-1 items-center justify-center px-6">
						<div className="max-w-sm text-center">
							<div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] text-[var(--status-error)]">
								<Icon name="error-warning" className="size-4" />
							</div>
							<p className="typography-ui-label font-medium text-foreground">{t('chat.container.sessionLoadError.title')}</p>
							<p className="typography-meta mt-1 text-muted-foreground">{t('chat.container.sessionLoadError.description')}</p>
							<Button variant="outline" size="sm" className="mt-4" onClick={retrySessionLoad}>
								{t('chat.container.sessionLoadError.retry')}
							</Button>
						</div>
					</div>
					<div className="relative z-10 bg-background">
						{promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={scrollToBottomOnSend} />}
					</div>
				</div>
			);
		}
		return (
			<div data-composer-bound className="relative flex flex-col h-full bg-background">
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6" style={CHAT_SCROLL_STYLE}>
                        <div className="space-y-4">
                            {HYDRATING_SKELETON_ITEMS.map((item) => (
                                <div key={item.id} className="group w-full">
                                    <div className="chat-message-column">
                                        <div className="space-y-2.5 px-4 py-3">
                                            <div className="space-y-1.5">
                                                {item.toolRows.map((row) => {
                                                    return (
                                                        <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                            <Skeleton className="h-3.5 w-3.5 rounded-full flex-shrink-0" />
                                                            <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                            <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[0])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[1])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[2])} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div
                    className={cn(
                        'relative z-10',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
                    {promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={scrollToBottomOnSend} />}
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && !sessionIsWorking) {
		return (
			// No transform here either — same fixed-positioning constraint as the
			// draft branch above.
			<div data-composer-bound className="relative flex flex-col h-full bg-background">
				{returnToParentButton}
				<div
					className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    {!isDesktopExpandedInput ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <ChatEmptyState />
                        </div>
                    ) : null}
                </div>
                <div
                    className={cn(
                        'relative z-10',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
                    {promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={scrollToBottomOnSend} />}
				</div>
            </div>
        );
    }

	return (
		<div data-composer-bound className="relative flex flex-col h-full bg-background">
			{returnToParentButton}
			<ChatViewport
				currentSessionId={currentSessionId}
                currentSessionKey={currentSessionKey ?? currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                directory={effectiveSessionDirectory}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={renderedTranscriptMessages}
                activeStreamingMessage={activeStreamingMessage}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={timelineController.handleHistoryScroll}
                scrollToBottom={resumeToLatestInstant}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
                isProgrammaticFollowActive={isFollowingProgrammatically}
                showLoadOlderButton={showLoadOlderButton}
                onLoadOlder={handleLoadOlderClick}
                turnIds={timelineController.turnIds}
                activeTurnId={timelineController.activeTurnId}
                onSelectTurn={handlePromptNavigatorSelect}
                showPromptNavigator={showPromptNavigator}
                canLoadEarlierPrompts={canLoadEarlierPrompts}
                isLoadingOlderPrompts={timelineController.isLoadingOlder}
                onLoadEarlierPrompts={handleLoadOlderClick}
                messageActions={transcriptMessageActions}
                reviewTransferDirection={reviewTransferDirection}
            />

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background'
                )}
            >
                {!isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                {promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={scrollToBottomOnSend} />}
            </div>

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
                canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                isLoadingEarlier={timelineController.isLoadingOlder}
                onLoadEarlier={handleLoadOlderClick}
            />
        </div>
    );
};


const EMPTY_TRANSCRIPT_MESSAGES: TranscriptMessage[] = [];
const TRANSCRIPT_BANNER_INLINE_ISSUES = new Set([
    'prime_transcript_truncated',
    'prime_transcript_messages_omitted',
    'prime_live_transcript_older_omitted',
]);

const PrimeReconnectControls: React.FC<{
    reconnecting: boolean;
    hasConnectedSnapshot: boolean;
    onReconnect: () => void;
}> = ({ reconnecting, hasConnectedSnapshot, onReconnect }) => {
    const { t } = useI18n();

    return (
        <div className="chat-input-column pb-4">
            <div
                role="status"
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-[var(--surface-elevated)] px-3 py-2.5"
            >
                <div className="min-w-0 flex-1">
                    <p className="typography-ui-label text-foreground">
                        {t('chat.primeSession.liveControls.readOnly')}
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={reconnecting}
                    onClick={onReconnect}
                    className="shrink-0"
                >
                    {reconnecting
                        ? t('chat.primeSession.liveControls.reconnecting')
                        : hasConnectedSnapshot
                            ? t('chat.primeSession.liveControls.reconnect')
                            : t('chat.primeSession.liveControls.enable')}
                </Button>
            </div>
        </div>
    );
};

const PassiveTranscriptContainer: React.FC<{
    identity: ChatIdentity;
    active: boolean;
}> = ({ identity, active }) => {
    const { t } = useI18n();
    const apis = useRuntimeAPIs();
    const transcriptKey = getPrimeTranscriptKey(identity);
    const liveKey = getPrimeLiveKey(identity);
    const snapshot = usePrimeTranscriptStore((state) => state.byKey.get(transcriptKey) ?? null);
    const live = usePrimeLiveStore((state) => state.byKey.get(liveKey));
    const messages = snapshot?.messages ?? EMPTY_TRANSCRIPT_MESSAGES;
    const activationPending = live?.desiredActive === true && live.availability === 'activating';
    const showComposer = active && live?.desiredActive === true && !activationPending;
    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const isTimelineDialogOpen = useUIStore((state) => state.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    React.useEffect(() => {
        if (!active) return;
        void ensurePrimeCatalog(identity.runtimeKey, apis);
        void loadPrimeTranscript(identity, apis);
    }, [active, apis, identity]);

    const reconnect = React.useCallback(() => {
        if (activationPending) return;
        void activatePrimeSessionFromUserSelection(identity, apis);
    }, [activationPending, apis, identity]);
    const liveControlArea = active
        ? showComposer
            ? <PrimeComposer identity={identity} />
            : (
                <PrimeReconnectControls
                    reconnecting={activationPending}
                    hasConnectedSnapshot={Boolean(live?.snapshot)}
                    onReconnect={reconnect}
                />
            )
        : null;

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);
    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
        isFollowingProgrammatically,
    } = useChatAutoFollow({
        currentSessionId: transcriptKey,
        currentSessionKey: transcriptKey,
        sessionMessageCount: messages.length,
        sessionIsWorking: false,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
    });
    const loadEarlier = React.useCallback(async () => {
        await loadEarlierPrimeTranscript(identity, apis);
    }, [apis, identity]);
    const historyMeta = React.useMemo(() => ({
        limit: messages.length,
        complete: snapshot?.complete ?? false,
        loading: snapshot?.loadingOlder ?? snapshot?.availability === 'loading',
    }), [messages.length, snapshot?.availability, snapshot?.complete, snapshot?.loadingOlder]);
    const timelineController = useChatTimelineController({
        sessionId: transcriptKey,
        sessionKey: transcriptKey,
        messages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages: loadEarlier,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);
    const navigation = useChatTurnNavigation({
        sessionId: transcriptKey,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    }, [navigation]);
    const handleLoadEarlier = React.useCallback(() => {
        void timelineController.loadEarlier({ userInitiated: true });
    }, [timelineController]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    const showPromptNavigator = !isMobile
        && !isVSCode
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;
    const hasRetainedTranscriptIssue = messages.length > 0 && Boolean(snapshot && (
        snapshot.availability === 'unavailable'
        || snapshot.issues.some((issue) => !TRANSCRIPT_BANNER_INLINE_ISSUES.has(issue.code))
    ));
    const liveUnavailableNotice = live?.availability === 'unavailable' && live.issues.length > 0 ? (
        <div
            role="status"
            className="mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-foreground"
        >
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <span>{t('chat.primeSession.readOnlyUnavailable')}</span>
        </div>
    ) : null;

    if (!snapshot || (snapshot.availability === 'loading' && messages.length === 0)) {
        return (
            <div className="flex h-full flex-col bg-background">
                <div className="min-h-0 flex-1 px-6 pt-8">
                    <div className="chat-message-column space-y-4">
                        <Skeleton className="h-16 w-3/4 self-end rounded-2xl" />
                        <Skeleton className="h-28 w-full rounded-2xl" />
                        <Skeleton className="h-20 w-5/6 rounded-2xl" />
                    </div>
                </div>
                {liveControlArea}
            </div>
        );
    }

    if (snapshot.availability === 'unavailable' && messages.length === 0) {
        return (
            <div className="flex h-full flex-col bg-background">
                <div className="flex min-h-0 flex-1 items-center justify-center px-6">
                    <div className="max-w-sm text-center">
                        <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] text-[var(--status-error)]">
                            <Icon name="error-warning" className="size-4" />
                        </div>
                        <p className="typography-ui-label font-medium text-foreground">{t('chat.container.sessionLoadError.title')}</p>
                        <p className="typography-meta mt-1 text-muted-foreground">{t('chat.container.sessionLoadError.description')}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            onClick={() => { void loadPrimeTranscript(identity, apis); }}
                        >
                            {t('chat.container.sessionLoadError.retry')}
                        </Button>
                    </div>
                </div>
                {liveControlArea}
            </div>
        );
    }

    if (messages.length === 0) {
        return (
            <div className="flex h-full flex-col bg-background">
                {liveUnavailableNotice}
                <div className="min-h-0 flex-1" />
                {liveControlArea}
            </div>
        );
    }

    return (
        <div className="relative flex h-full flex-col bg-background">
            {liveUnavailableNotice}
            {hasRetainedTranscriptIssue ? (
                <div
                    role="status"
                    className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-foreground"
                >
                    <Icon name="error-warning" className="size-4 shrink-0 text-[var(--status-warning)]" />
                    <span>{t('chat.container.partialTranscript.description')}</span>
                </div>
            ) : null}
            <ChatViewport
                currentSessionId={transcriptKey}
                currentSessionKey={transcriptKey}
                isDesktopExpandedInput={false}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={timelineController.renderedMessages}
                activeStreamingMessage={null}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={snapshot.liveIsWorking}
                streamingMessageId={snapshot.liveActiveMessageId}
                activeStreamingPhase={snapshot.liveIsWorking ? 'streaming' : null}
                retryOverlay={null}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={timelineController.handleHistoryScroll}
                scrollToBottom={resumeToLatestInstant}
                sessionQuestions={EMPTY_QUESTIONS}
                sessionPermissions={EMPTY_PERMISSIONS}
                isProgrammaticFollowActive={isFollowingProgrammatically}
                showLoadOlderButton={isMobileSurfaceRuntime() && timelineController.historySignals.canLoadEarlier}
                onLoadOlder={handleLoadEarlier}
                turnIds={timelineController.turnIds}
                activeTurnId={timelineController.activeTurnId}
                onSelectTurn={handlePromptNavigatorSelect}
                showPromptNavigator={showPromptNavigator}
                canLoadEarlierPrompts={timelineController.historySignals.canLoadEarlier}
                isLoadingOlderPrompts={timelineController.isLoadingOlder}
                onLoadEarlierPrompts={handleLoadEarlier}
                showConnectedFooter={false}
            />
            {liveControlArea}
            <ScrollToBottomButton
                visible={timelineController.showScrollToBottom}
                onClick={navigation.resumeToLatest}
            />
            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
                canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                isLoadingEarlier={timelineController.isLoadingOlder}
                onLoadEarlier={handleLoadEarlier}
            />
        </div>
    );
};

export const ChatContainer: React.FC<ChatContainerProps> = (props) => {
    const visibleChatIdentity = useChatSelectionStore((state) => state.visibleChatIdentity);
    const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
    React.useEffect(() => {
        // The OpenCode no-session fallback may race a routed Prime identity on
        // cold boot. Its automatic draft intentionally cannot clear Prime
        // selection, so close that fallback once the routed identity is known.
        if (draftOpen && visibleChatIdentity?.harness === 'prime') {
            useSessionUIStore.getState().closeNewSessionDraft();
        }
    }, [draftOpen, visibleChatIdentity]);
    React.useEffect(() => {
        suspendHiddenPrimeLiveSessions(draftOpen ? null : visibleChatIdentity);
    }, [draftOpen, visibleChatIdentity]);
    if (!draftOpen && visibleChatIdentity?.harness === 'prime') {
        return (
            <PassiveTranscriptContainer
                identity={visibleChatIdentity}
                active={props.active ?? true}
            />
        );
    }
    return <OpenCodeChatContainer {...props} />;
};
