import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { formatSessionCompactDateLabel, normalizePath } from '@/components/session/sidebar/utils';
import { useSwitcherItems } from '@/components/session/sidebar/shell/useSwitcherItems';
import { selectQuestionBadgeSessionScopes } from '@/components/session/sidebar/sessions/sessionNodeItemUtils';
import type { SessionNode } from '@/components/session/sidebar/types';
import {
  SessionBlockingRequestBadges,
  SessionGoalIndicator,
  SessionLeadingIndicatorGlyph,
  SessionPersistentErrorIndicator,
  SessionPrIndicator,
  SessionCheckoutIndicators,
} from '@/components/session/sidebar/SessionRowIndicators';
import { useSessionRowIndicatorModel } from '@/components/session/sidebar/useSessionRowIndicatorModel';
import { useTabletLayout } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore } from '@/stores/useGitStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChildStoreManager } from '@/sync/sync-context';

const RECENT_SESSIONS_LIMIT = 10;
/** Matches the metadata popover's width so both header dropdowns read as a pair. */
const TABLET_POPOVER_WIDTH = 380;

const getSessionTitle = (session: Session, fallback: string): string =>
  session.title?.trim() || fallback;

/** One switcher row: sidebar-equivalent activity and permission indicators,
    title, "project · branch", and compact time. No subsession chevrons on
    mobile by design. */
const SwitcherRow: React.FC<{
  node: SessionNode;
  session: Session;
  directory: string | null;
  projectRootDirectory: string | null;
  branch: string | null;
  meta: string;
  active: boolean;
  pinned: boolean;
  onSelect: () => void;
}> = ({ node, session, directory, projectRootDirectory, branch, meta, active, pinned, onSelect }) => {
  const { t } = useI18n();
  const sessionDirectory = directory ?? resolveGlobalSessionDirectory(session);
  const indicatorModel = useSessionRowIndicatorModel({
    node,
    directory: sessionDirectory,
    active,
    pinned,
    includeDescendants: true,
    includeUnreadSubtasks: true,
    projectRootDirectory,
    branch,
  });
  const timeLabel = formatSessionCompactDateLabel(session.time?.updated ?? session.time?.created ?? 0);

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active && 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]',
      )}
      onClick={onSelect}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('block truncate typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
          {getSessionTitle(session, t('sessions.sidebar.session.untitled'))}
        </span>
        {meta ? (
          <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      <SessionCheckoutIndicators model={indicatorModel} variant="mobile" />
      <SessionPrIndicator model={indicatorModel} variant="mobile" />
      {/* Activity sits on the right, before permissions and time — no reserved left gutter. */}
      {indicatorModel.leading && (
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <SessionLeadingIndicatorGlyph indicator={indicatorModel.leading} variant="mobile" />
        </span>
      )}
      {indicatorModel.hasPersistentError ? <SessionPersistentErrorIndicator variant="mobile" /> : null}
      <SessionBlockingRequestBadges model={indicatorModel} />
      {/* The elapsed turn takes the time slot while it matters, then hands it
          back to the relative timestamp. */}
      {indicatorModel.showActivityDuration ? (
        <SessionActivityDuration
          sessionId={session.id}
          running={indicatorModel.isStreaming}
          className="typography-micro"
        />
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1">
          <SessionGoalIndicator goal={indicatorModel.goal} variant="mobile" />
          {timeLabel ? (
            <span className="typography-micro text-muted-foreground tabular-nums">{timeLabel}</span>
          ) : null}
        </span>
      )}
    </button>
  );
};

/** Recent-sessions popover under the mobile header, opened by tapping the
    session title. Same visual family as the metadata/usage overlay. */
export const MobileSessionSwitcher: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}> = ({ open, onClose, anchorRef }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  // Tablet: a phone-width sheet stretched across the whole chat column looks
  // broken — anchor a popover under the title instead. Mirror image of the
  // metadata/usage popover, which anchors to the ring on the right.
  const { enabled: isTabletLayout } = useTabletLayout();
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [anchorLeft, setAnchorLeft] = React.useState<number | null>(null);

  // The shell has transformed ancestors, so the fixed wrapper's containing
  // block is the chat column, NOT the viewport — anchor in the wrapper's own
  // coordinate space (see SessionMetadataOverlay for the same reasoning).
  React.useLayoutEffect(() => {
    if (!open || !isTabletLayout || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      setAnchorLeft(Math.min(
        Math.max(relativeLeft, 8),
        Math.max(8, wrapperRect.width - TABLET_POPOVER_WIDTH - 8),
      ));
    };
    compute();
    // Re-anchor if the chat column shifts while the popover is open (sidebar
    // toggle/resize, orientation change) — the header buttons move with it.
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isTabletLayout, open, shouldRender]);

  const isPopover = isTabletLayout && anchorLeft !== null;
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const { git, github } = useRuntimeAPIs();
  const fetchWorktreeComparison = useGitStore((state) => state.fetchWorktreeComparison);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const ensureWorktreeComparison = useGitStore((state) => state.ensureWorktreeComparison);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const childStores = useChildStoreManager();
  const bootstrapDemandOwner = `mobile-session-switcher:${React.useId()}`;

  const items = useSwitcherItems(open || shouldRender, { maxParents: RECENT_SESSIONS_LIMIT });
  const worktreeDirectories = React.useMemo(() => Array.from(new Set(
    items
      .map((item) => normalizePath(item.node.worktree?.path ?? null))
      .filter((directory): directory is string => Boolean(directory)),
  )), [items]);
  const rootDirectories = React.useMemo(() => Array.from(new Set(
    items
      .filter((item) => (
        !item.node.worktree
        && normalizePath(item.groupDirectory) === normalizePath(item.projectRootDirectory)
      ))
      .map((item) => normalizePath(item.groupDirectory))
      .filter((directory): directory is string => Boolean(directory)),
  )), [items]);
  const prTargets = React.useMemo(() => {
    const targetsByKey = new Map<string, { directory: string; branch: string }>();
    for (const item of items) {
      const directory = normalizePath(item.node.worktree?.path ?? null);
      const branch = item.secondaryMeta?.branchLabel?.trim() || item.node.worktree?.branch?.trim();
      if (!directory || !branch) continue;
      const key = getGitHubPrStatusKey(directory, branch);
      if (!targetsByKey.has(key)) targetsByKey.set(key, { directory, branch });
    }
    return targetsByKey;
  }, [items]);

  React.useEffect(() => {
    if (worktreeDirectories.length === 0 && rootDirectories.length === 0) return;
    if (git.getWorktreeComparison) {
      for (const directory of worktreeDirectories) {
        void ensureWorktreeComparison(directory, git, { mode: 'combined' });
      }
    }
    for (const directory of worktreeDirectories) {
      void ensureStatus(directory, git);
    }
    for (const directory of rootDirectories) {
      void ensureStatus(directory, git);
    }
    const worktreeDirectorySet = new Set(worktreeDirectories);
    const rootDirectorySet = new Set(rootDirectories);
    const refreshVisibleWorktreeComparisons = () => {
      if (!git.getWorktreeComparison) return;
      for (const directory of worktreeDirectories) {
        void fetchWorktreeComparison(directory, git, { mode: 'combined' });
        void fetchStatus(directory, git, { silent: true });
      }
    };
    return sessionEvents.onGitRefreshHint((hint) => {
      const directory = normalizePath(hint.directory);
      if (!directory) return;
      if (git.getWorktreeComparison && worktreeDirectorySet.has(directory)) {
        void fetchWorktreeComparison(directory, git, { mode: 'combined' });
      }
      if (worktreeDirectorySet.has(directory)) {
        void fetchStatus(directory, git, { silent: true });
      }
      if (rootDirectorySet.has(directory)) {
        void fetchStatus(directory, git, { silent: true });
        refreshVisibleWorktreeComparisons();
      }
    });
  }, [ensureStatus, ensureWorktreeComparison, fetchStatus, fetchWorktreeComparison, git, rootDirectories, worktreeDirectories]);

  React.useEffect(() => {
    if (!githubAuthChecked || !githubAuthStatus?.connected || !github || prTargets.size === 0) return;
    prTargets.forEach((target, key) => {
      ensurePrStatusEntry(key);
      setPrStatusParams(key, {
        directory: target.directory,
        branch: target.branch,
        remoteName: null,
        canShow: true,
        github,
        githubAuthChecked,
        githubConnected: githubAuthStatus.connected,
      });
    });
    void refreshPrStatusTargets([...prTargets.values()], {
      silent: true,
      markInitialResolved: true,
    });
  }, [
    ensurePrStatusEntry,
    github,
    githubAuthChecked,
    githubAuthStatus?.connected,
    prTargets,
    refreshPrStatusTargets,
    setPrStatusParams,
  ]);

  React.useEffect(() => {
    const directories = new Set<string>();
    for (const item of items) {
      for (const scope of selectQuestionBadgeSessionScopes(item.node, false, item.groupDirectory)) {
        directories.add(scope.directory);
      }
    }
    childStores.setBootstrapDemand(
      bootstrapDemandOwner,
      Array.from(directories, (directory) => ({
        directory,
        priority: 'visible' as const,
        reason: 'action-demand' as const,
      })),
    );
  }, [bootstrapDemandOwner, childStores, items]);

  React.useEffect(
    () => () => childStores.clearBootstrapDemand(bootstrapDemandOwner),
    [bootstrapDemandOwner, childStores],
  );

  React.useEffect(() => {
    if (open) {
      // Fresh authoritative snapshot on open — updated stamps re-sort recents
      // (see raiseSessionOrderingBaselines) while the cached list shows first.
      void refreshGlobalSessions();
      setShouldRender(true);
      setIsExiting(false);
      return;
    }
    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => document.removeEventListener('pointerdown', closeIfOutside, true);
  }, [anchorRef, onClose, open]);

  const handleSelect = React.useCallback((session: Session) => {
    void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    onClose();
  }, [onClose, setCurrentSession]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('sessions.switcher.openAria')}
        className={cn(
          'flex flex-col overflow-hidden rounded-[20px] border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
          isPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-switcher-out' : 'session-switcher-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(isPopover
            ? {
                top: 8,
                left: anchorLeft ?? 8,
                width: `min(${TABLET_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center typography-small text-muted-foreground">
              {t('sessions.switcher.empty')}
            </p>
          ) : (
            items.map((item) => {
              const session = item.node.session;
              const meta = [item.secondaryMeta?.projectLabel, item.secondaryMeta?.branchLabel]
                .filter(Boolean)
                .join(' · ');
              return (
                <SwitcherRow
                  key={session.id}
                  node={item.node}
                  session={session}
                  directory={item.groupDirectory}
                  projectRootDirectory={item.projectRootDirectory}
                  branch={item.secondaryMeta?.branchLabel ?? item.node.worktree?.branch ?? null}
                  meta={meta}
                  active={session.id === currentSessionId}
                  pinned={item.pinned}
                  onSelect={() => {
                    if (item.projectId) setActiveProjectIdOnly(item.projectId);
                    handleSelect(session);
                  }}
                />
              );
            })
          )}
        </div>
      </div>
      <style>{`
        @keyframes session-switcher-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-switcher-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};
