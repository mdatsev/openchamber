import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { usePrimeSessionSelection } from '@/hooks/usePrimeSessionSelection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChatIdentity } from '@/lib/chat-identity';
import { createChatDraftIdentity, getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useDeviceInfo, useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { useI18n } from '@/lib/i18n';
import { createPrimeChatIdentity } from '@/lib/prime/identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useInputStore } from '@/sync/input-store';
import { resolveOpenDraftWorkingDirectory, useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { refreshPrimeCatalogAfterCreation } from '@/stores/usePrimeCatalogStore';
import { usePrimeDraftSourceStore } from '@/stores/usePrimeDraftSourceStore';
import {
  getPrimeLiveKey,
  usePrimeLiveStore,
} from '@/stores/usePrimeLiveStore';
import {
  abortPrimeTurn,
  createPrimeSessionFromDraft,
  getPrimeComposerKey,
  getPrimeDraftComposerKey,
  initializePrimeDraftConfiguration,
  selectPrimeComposerSnapshot,
  selectPrimeDraftComposerSnapshot,
  selectPrimeDraftCreationPending,
  setPrimeComposerDraft,
  setPrimeDraftComposerDraft,
  submitPrimePrompt,
  usePrimeComposerStore,
} from '@/stores/usePrimeComposerStore';
import {
  ComposerControllerProvider,
  ComposerModelControls,
} from './composer/controller/ComposerControllerProvider';
import type {
  ComposerController,
  ComposerModelControlsRenderer,
} from './composer/controller/types';
import {
  ComposerEditor,
  type ComposerChange,
  type ComposerEditorHandle,
} from './composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import type { ComposerLanguageContext } from './composer/language/tokenize';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import {
  DraftTargetSelectors,
  MobileDraftTargetSheets,
  MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import {
  PrimeDraftMobileModelButton,
  PrimeDraftModelControls,
  PrimeMobileModelButton,
  PrimeModelControls,
} from './PrimeModelControls';

const EMPTY_NAMES = new Set<string>();
const LIVE_RECONNECTING_NOTICE_DELAY_MS = 500;
const PRIME_LANGUAGE_CONTEXT: ComposerLanguageContext = {
  inputMode: 'normal',
  knownAgentNames: EMPTY_NAMES,
  confirmedMentions: EMPTY_NAMES,
  knownSlashNames: EMPTY_NAMES,
  knownSnippetTriggers: EMPTY_NAMES,
  attachmentFilenames: [],
};
const noop = () => {};
const subscribeToReactState: ComposerController['subscribe'] = () => () => {};
const isDraftIdentity = (
  identity: ChatIdentity | ChatDraftIdentity,
): identity is ChatDraftIdentity => identity.sessionId === null;

type PrimeComposerFrameProps = {
  composerKey: string;
  message: string;
  status: string | null;
  statusIsError: boolean;
  canSend: boolean;
  canAbort: boolean;
  editable: boolean;
  newSessionDraftOpen: boolean;
  isDraftScreen: boolean;
  modelIdentity?: ChatIdentity | ChatDraftIdentity;
  mobileOverlayOpen?: boolean;
  beforeComposer?: React.ReactNode;
  onChange: (change: ComposerChange) => void;
  onSubmit: () => void;
  onAbort: () => void;
};

const PrimeComposerFrame: React.FC<PrimeComposerFrameProps> = ({
  composerKey,
  message,
  status,
  statusIsError,
  canSend,
  canAbort,
  editable,
  newSessionDraftOpen,
  isDraftScreen,
  modelIdentity,
  mobileOverlayOpen = false,
  beforeComposer,
  onChange,
  onSubmit,
  onAbort,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { isMobile } = useDeviceInfo();
  const hasHardwareKeyboard = useHardwareKeyboard();
  const { enabled: isTabletLayout } = useTabletLayout();
  const inputBarOffset = useUIStore((state) => state.inputBarOffset);
  const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
  const setExpandedInput = useUIStore((state) => state.setExpandedInput);
  const editorRef = React.useRef<ComposerEditorHandle>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const editorViewStore = React.useRef(createComposerEditorViewStore()).current;
  const [mobileControlsPanel, setMobileControlsPanel] = React.useState<'model' | 'agent' | 'variant' | null>(null);

  React.useEffect(() => () => {
    editorViewStore.view?.destroy();
    editorViewStore.view = null;
  }, [editorViewStore]);

  const mobileShell = useMobileComposerShell({
    isMobile,
    editorRef,
    formRef,
    setExpandedInput,
    alwaysExpanded: hasHardwareKeyboard || isTabletLayout,
    holders: {
      controlsPanelOpen: Boolean(modelIdentity && mobileControlsPanel !== null),
      attachMenuOpen: false,
      draftPickerOpen: mobileOverlayOpen,
      issuePickerOpen: false,
      prPickerOpen: false,
      isDragging: false,
    },
  });

  useMobileViewportPin({
    isMobile,
    isFullscreen: false,
    isDraftScreen,
    isFocused: mobileShell.focused,
    formRef,
    editorRef,
  });

  const hasContent = message.trim().length > 0;
  const renderModelControls = React.useCallback<ComposerModelControlsRenderer>((props) => {
    if (!modelIdentity) return null;
    return isDraftIdentity(modelIdentity)
      ? <PrimeDraftModelControls {...props} identity={modelIdentity} />
      : <PrimeModelControls {...props} identity={modelIdentity} />;
  }, [modelIdentity]);
  const controllerSnapshot = React.useMemo(() => ({
    actions: {
      canSend,
      canAbort,
      hasContent,
      canSubmit: editable,
      canQueue: false,
    },
  }), [canAbort, canSend, editable, hasContent]);
  const controller = React.useMemo<ComposerController>(() => ({
    getSnapshot: () => controllerSnapshot,
    subscribe: subscribeToReactState,
    actions: {
      primaryAction: onSubmit,
      queueMessage: noop,
      abort: onAbort,
    },
    renderCommandMenu: () => null,
    renderModelControls,
  }), [controllerSnapshot, onAbort, onSubmit, renderModelControls]);

  const radius = isMobile ? '1.5rem' : 'var(--radius-xl)';
  const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : 'px-2.5 py-1.5';
  const footerGapClass = isMobile ? 'gap-x-1.5' : 'gap-x-2';
  const buttonSizeClass = isMobile ? 'h-8 w-8' : 'h-6 w-6';
  const sendIconSizeClass = 'h-4 w-4';
  const stopIconSizeClass = isMobile ? 'h-6 w-6' : 'h-5 w-5';
  const iconSizeClass = 'h-[18px] w-[18px]';
  const footerIconButtonClass = cn(
    'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed',
    buttonSizeClass,
  );

  return (
    <ComposerControllerProvider controller={controller}>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className={cn('relative w-full pt-0 pb-4', isMobile && 'bottom-safe-area oc-mobile-composer')}
        style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
      >
        <div className="chat-input-column relative overflow-visible">
          {status ? (
            <p
              role={statusIsError ? 'alert' : 'status'}
              className={cn(
                'mb-1.5 px-2 typography-meta',
                statusIsError ? 'text-[var(--status-error)]' : 'text-muted-foreground',
              )}
            >
              {status}
            </p>
          ) : null}
          {beforeComposer}
          {isMobile && !mobileShell.expanded ? (
            <MobilePillComposer
              message={message}
              sessionId={modelIdentity ? composerKey : null}
              newSessionDraftOpen={newSessionDraftOpen}
              hasContent={hasContent}
              isVSCode={false}
              footerIconButtonClass={footerIconButtonClass}
              iconSizeClass={iconSizeClass}
              stopIconSizeClass={stopIconSizeClass}
              theme={currentTheme}
              showAuxiliaryControls={false}
              showNewSessionAction={false}
              onExpand={mobileShell.expand}
              onApplySuggestion={noop}
              onNewSession={noop}
              onPickLocalFiles={noop}
              onOpenIssuePicker={noop}
              onOpenPrPicker={noop}
              onOpenAttachSheet={noop}
              onStartDictation={noop}
            />
          ) : (
            <div
              className="flex flex-col relative overflow-visible border border-border/80 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] focus-within:ring-1 focus-within:ring-primary/50"
              style={{ borderRadius: radius, backgroundColor: currentTheme?.colors?.surface?.subtle }}
            >
              {isMobile && modelIdentity ? (
                <div className="scrollbar-none relative z-10 flex items-center overflow-x-auto px-3 pb-0.5 pt-1.5">
                  {isDraftIdentity(modelIdentity) ? (
                    <PrimeDraftMobileModelButton
                      identity={modelIdentity}
                      onOpen={() => setMobileControlsPanel('model')}
                    />
                  ) : (
                    <PrimeMobileModelButton
                      identity={modelIdentity}
                      onOpen={() => setMobileControlsPanel('model')}
                    />
                  )}
                </div>
              ) : null}
              <ComposerEditor
                ref={editorRef}
                viewStore={editorViewStore}
                data-testid="chat-input"
                value={message}
                languageContext={PRIME_LANGUAGE_CONTEXT}
                onChange={onChange}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || (isMobile && !event.ctrlKey && !event.metaKey)) return false;
                  if (!canSend) return false;
                  event.preventDefault();
                  onSubmit();
                  return true;
                }}
                onFocus={mobileShell.onEditorFocus}
                onBlur={mobileShell.onEditorBlur}
                placeholder={t('chat.chatInput.placeholder.prime')}
                editable={editable}
                autoCorrect={isMobile}
                autoCapitalize={isMobile ? 'sentences' : 'none'}
                spellCheck={isMobile || inputSpellcheckEnabled}
                maxLines={isMobile ? 16 : 8}
                className={cn(
                  'min-h-[52px] px-3 relative z-10',
                  isMobile ? 'py-2.5' : 'pt-4 pb-2',
                  'typography-markdown md:typography-ui-label',
                )}
              />
              <ComposerFooter
                isMobile={isMobile}
                isVSCode={false}
                sessionId={modelIdentity ? composerKey : null}
                newSessionDraftOpen={newSessionDraftOpen}
                messageLength={message.length}
                radius={radius}
                footerPaddingClass={footerPaddingClass}
                footerGapClass={footerGapClass}
                footerIconButtonClass={footerIconButtonClass}
                iconSizeClass={iconSizeClass}
                sendIconSizeClass={sendIconSizeClass}
                stopIconSizeClass={stopIconSizeClass}
                isExpandedInput={false}
                permissionAutoAcceptEnabled={false}
                isPermissionAutoAcceptInteractive={false}
                dictationActive={false}
                showAuxiliaryControls={false}
                onPickLocalFiles={noop}
                onOpenIssuePicker={noop}
                onOpenPrPicker={noop}
                onOpenAttachSheet={noop}
                onToggleExpandedInput={noop}
                onTogglePermissionAutoAccept={noop}
                onStartDictation={noop}
                onDictationInsert={noop}
                onDictationInsertAndSend={noop}
                onDictationContentHeightChange={noop}
              />
            </div>
          )}
          {isMobile && modelIdentity ? (
            <ComposerModelControls
              className="hidden"
              mobilePanel={mobileControlsPanel}
              onMobilePanelChange={setMobileControlsPanel}
            />
          ) : null}
        </div>
      </form>
    </ComposerControllerProvider>
  );
};

export const PrimeComposer: React.FC<{ identity: ChatIdentity }> = ({ identity }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const liveKey = getPrimeLiveKey(identity);
  const composerKey = getPrimeComposerKey(identity);
  const live = usePrimeLiveStore((state) => state.byKey.get(liveKey));
  const composer = usePrimeComposerStore((state) => (
    state.byKey.get(composerKey) ?? selectPrimeComposerSnapshot(state, identity)
  ));

  const snapshot = live?.snapshot ?? null;
  const fresh = live?.desiredActive === true
    && live.availability === 'live'
    && snapshot?.freshness.state === 'fresh'
    && snapshot.capabilities.mutations;
  const pending = composer.pendingAction !== null;
  const hasContent = composer.draft.trim().length > 0;
  const canSend = Boolean(fresh
    && !pending
    && snapshot?.status.activity === 'idle'
    && snapshot.capabilities.actions.canSend
    && hasContent);
  const canAbort = Boolean(fresh
    && !pending
    && snapshot?.status.activity === 'working'
    && snapshot.turn.active
    && snapshot.capabilities.actions.canAbort);
  const liveReconnecting = live?.desiredActive === true && (
    live.availability === 'connecting'
    || live.availability === 'stale'
    || snapshot?.freshness.state === 'stale'
  );
  const [reconnectingNoticeReady, setReconnectingNoticeReady] = React.useState(false);
  React.useEffect(() => {
    if (!liveReconnecting) {
      setReconnectingNoticeReady(false);
      return;
    }
    const timeout = setTimeout(
      () => setReconnectingNoticeReady(true),
      LIVE_RECONNECTING_NOTICE_DELAY_MS,
    );
    return () => clearTimeout(timeout);
  }, [liveReconnecting]);
  const composerStatus = composer.pendingAction
    ? t('chat.primeComposer.pending')
    : composer.retryAction
      ? t('chat.primeComposer.outcomeUncertain')
      : composer.issueCode === 'prime_prompt_too_large'
        ? t('chat.primeComposer.draftLimitReached')
        : composer.issueCode
          ? t('chat.primeComposer.failed')
          : liveReconnecting && reconnectingNoticeReady
            ? t('chat.primeComposer.liveReconnecting')
            : null;
  const composerStatusIsError = composer.retryAction !== null || composer.issueCode !== null;

  const submit = React.useCallback(() => {
    if (!canSend) return;
    void submitPrimePrompt(identity, apis);
  }, [apis, canSend, identity]);
  const abort = React.useCallback(() => {
    if (!canAbort) return;
    void abortPrimeTurn(identity, apis);
  }, [apis, canAbort, identity]);

  return (
    <PrimeComposerFrame
      composerKey={composerKey}
      message={composer.draft}
      status={composerStatus}
      statusIsError={composerStatusIsError}
      canSend={canSend}
      canAbort={canAbort}
      editable={live?.desiredActive === true}
      newSessionDraftOpen={false}
      isDraftScreen={false}
      modelIdentity={identity}
      onChange={({ value }) => setPrimeComposerDraft(identity, value)}
      onSubmit={submit}
      onAbort={abort}
    />
  );
};

export const PrimeDraftComposer: React.FC = () => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const selectPrimeSession = usePrimeSessionSelection();
  const { currentTheme } = useThemeSystem();
  const { isMobile } = useDeviceInfo();
  const pendingPresetSubmit = useInputStore((state) => state.pendingPresetSubmit);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const setNewSessionDraftTarget = useSessionUIStore((state) => state.setNewSessionDraftTarget);
  const runtimeKey = getRuntimeKey();
  const primeLiveStates = usePrimeLiveStore((state) => state.byKey);
  const {
    projects,
    selectedDraftProject,
    selectedDraftDirectory,
    selectedDraftBranchLabel,
    selectedDraftBranchIsKnown,
    projectRootBranchOption,
    worktreeBranchOptions,
    draftBranchItems,
    shouldShowDraftBranchSelector,
    handleDraftProjectChange,
    handleDraftDirectoryChange,
  } = useDraftTarget(true);
  const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
  const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
  const draftIdentity = React.useMemo(() => createChatDraftIdentity(
    runtimeKey,
    selectedDraftDirectory,
    null,
    'prime',
  ), [runtimeKey, selectedDraftDirectory]);
  const draftKey = draftIdentity ? getPrimeDraftComposerKey(draftIdentity) : null;
  const draftSourceKey = draftIdentity ? getChatDraftIdentityKey(draftIdentity) : null;
  const selectedConfigurationSource = usePrimeDraftSourceStore((state) => (
    draftSourceKey ? state.sourceByDraftKey.get(draftSourceKey) ?? null : null
  ));
  const composer = usePrimeComposerStore((state) => (
    draftIdentity ? selectPrimeDraftComposerSnapshot(state, draftIdentity) : null
  ));
  const configurationSourceSessionId = composer?.draftConfiguration?.sourceSessionId
    ?? selectedConfigurationSource?.sessionId
    ?? null;
  const configurationSource = React.useMemo(() => {
    if (!configurationSourceSessionId) return null;
    for (const state of primeLiveStates.values()) {
      const snapshot = state.snapshot;
      const currentModel = snapshot?.configuration.currentModel;
      if (state.identity.runtimeKey === runtimeKey
        && state.identity.sessionId === configurationSourceSessionId
        && snapshot?.sessionId === configurationSourceSessionId
        && snapshot.freshness.state === 'fresh'
        && currentModel
        && snapshot.configuration.models.some((model) => (
          model.provider === currentModel.provider && model.id === currentModel.id
        ))) return snapshot;
    }
    return null;
  }, [configurationSourceSessionId, primeLiveStates, runtimeKey]);
  const pending = usePrimeComposerStore((state) => (
    selectPrimeDraftCreationPending(state, runtimeKey)
  ));
  const message = composer?.draft ?? '';
  const canSend = Boolean(draftIdentity && message.trim() && !pending);

  React.useEffect(() => {
    if (draftIdentity && configurationSource) {
      initializePrimeDraftConfiguration(draftIdentity, configurationSource);
    }
  }, [configurationSource, draftIdentity]);

  React.useEffect(() => {
    setMobileDraftPickerQuery('');
  }, [mobileDraftPicker]);

  React.useEffect(() => {
    if (!selectedDraftProject || !selectedDraftDirectory) return;
    const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
    const draft = useSessionUIStore.getState().newSessionDraft;
    if (valid
      || draft.pendingWorktreeRequestId
      || draft.bootstrapPendingDirectory
      || draft.preserveDirectoryOverride) return;
    setNewSessionDraftTarget({
      projectId: selectedDraftProject.id,
      directoryOverride: selectedDraftProject.path,
    });
  }, [draftBranchItems, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget]);

  const finishCreation = React.useCallback(async (sessionId: string) => {
    if (getRuntimeKey() !== runtimeKey) return;
    await refreshPrimeCatalogAfterCreation(runtimeKey, apis).catch(() => undefined);
    if (getRuntimeKey() !== runtimeKey) return;
    useSessionUIStore.getState().closeNewSessionDraft();
    await selectPrimeSession(createPrimeChatIdentity(runtimeKey, sessionId));
  }, [apis, runtimeKey, selectPrimeSession]);

  const submit = React.useCallback((messageOverride?: string) => {
    if (!draftIdentity || pending) return;
    const capturedTarget = newSessionDraft;
    void createPrimeSessionFromDraft(draftIdentity, apis, messageOverride, {
      resolveWorkingDirectory: () => resolveOpenDraftWorkingDirectory(capturedTarget),
    }).then((response) => {
      if (response) void finishCreation(response.sessionId);
    });
  }, [apis, draftIdentity, finishCreation, newSessionDraft, pending]);

  React.useEffect(() => {
    if (pendingPresetSubmit?.harness !== 'prime' || !draftIdentity) return;
    const preset = useInputStore.getState().consumePendingPresetSubmit('prime');
    if (!preset || pending) return;
    const currentDraft = selectPrimeDraftComposerSnapshot(
      usePrimeComposerStore.getState(),
      draftIdentity,
    ).draft.trim();
    const presetText = currentDraft
      ? `${preset.text}${preset.type === 'command' ? ' ' : '\n'}${currentDraft}`
      : preset.text;
    setPrimeDraftComposerDraft(draftIdentity, presetText);
    submit(presetText);
  }, [draftIdentity, pending, pendingPresetSubmit, submit]);

  const composerStatus = pending
    ? t('chat.primeDraft.creating')
    : composer?.issueCode === 'prime_creation_uncertain'
      ? t('chat.primeDraft.creationUncertain')
      : composer?.issueCode === 'prime_unsupported'
        ? t('chat.primeDraft.unsupported')
        : composer?.issueCode === 'prime_creation_configuration_unavailable'
          ? t('chat.primeDraft.configurationUnavailable')
          : composer?.issueCode === 'prime_creation_source_refresh_failed'
            ? t('chat.primeDraft.sourceRefreshFailed')
            : composer?.issueCode === 'prime_prompt_too_large'
          ? t('chat.primeComposer.draftLimitReached')
          : composer?.issueCode
            ? t('chat.primeDraft.creationFailed')
            : null;
  const targetProps = selectedDraftProject ? {
    projects,
    selectedProject: selectedDraftProject,
    selectedDirectory: selectedDraftDirectory,
    selectedBranchLabel: selectedDraftBranchLabel,
    selectedBranchIsKnown: selectedDraftBranchIsKnown,
    projectRootBranchOption,
    worktreeBranchOptions,
    branchItems: draftBranchItems,
    showBranchSelector: shouldShowDraftBranchSelector,
    onProjectChange: handleDraftProjectChange,
    onDirectoryChange: handleDraftDirectoryChange,
    theme: currentTheme,
  } : null;

  return (
    <>
      <PrimeComposerFrame
        composerKey={draftKey ?? 'prime-draft'}
        message={message}
        status={composerStatus}
        statusIsError={Boolean(composer?.issueCode)}
        canSend={canSend}
        canAbort={false}
        editable={Boolean(draftIdentity)}
        newSessionDraftOpen
        isDraftScreen
        modelIdentity={draftIdentity ?? undefined}
        mobileOverlayOpen={mobileDraftPicker !== null}
        beforeComposer={targetProps
          ? isMobile
            ? (
                <MobileDraftTargetTriggers
                  selectedProject={targetProps.selectedProject}
                  selectedBranchLabel={targetProps.selectedBranchLabel}
                  showBranchSelector={targetProps.showBranchSelector}
                  theme={targetProps.theme}
                  onOpenPicker={setMobileDraftPicker}
                />
              )
            : <DraftTargetSelectors {...targetProps} />
          : null}
        onChange={({ value }) => {
          if (draftIdentity) setPrimeDraftComposerDraft(draftIdentity, value);
        }}
        onSubmit={() => submit()}
        onAbort={noop}
      />
      {isMobile && targetProps ? (
        <MobileDraftTargetSheets
          {...targetProps}
          openPicker={mobileDraftPicker}
          onOpenPickerChange={setMobileDraftPicker}
          query={mobileDraftPickerQuery}
          onQueryChange={setMobileDraftPickerQuery}
        />
      ) : null}
    </>
  );
};
