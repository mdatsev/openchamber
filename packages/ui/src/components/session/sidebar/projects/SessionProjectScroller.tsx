import React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import type { SessionGroup } from '../types';
import { ProjectHeaderIdentity, SortableGroupItem, SortableProjectItem } from './sortableItems';
import { SessionGroupSection, type SessionGroupSectionProps } from './SessionGroupSection';
import { buildGroupRenderDescriptors, resolveSearchResultPlacement, selectRenderedProjectSections, type ProjectSection } from './sessionProjectRender';
import { formatProjectLabel, normalizePath } from '../utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitCleanStatusMap, useGitStore, useGitUpstreamAheadStatusMap } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { sessionEvents } from '@/lib/sessionEvents';

type SessionProjectScrollerState = Pick<SessionGroupSectionProps,
  | 'editingId'
  | 'openSidebarMenuKey'
  | 'setOpenSidebarMenuKey'
> & {
  visibleSessionCountByGroup: Map<string, number>;
};

type SessionProjectScrollerGroupProps = Pick<SessionGroupSectionProps,
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'groupSearchDataByGroup'
  | 'collapsedGroups'
  | 'hideDirectoryControls'
  | 'mobileVariant'
  | 'alwaysShowActions'
  | 'activeProjectId'
  | 'notifyOnSubtasks'
  | 'expandedParents'
  | 'editTitle'
  | 'copiedSessionId'
  | 'folderRename'
  | 'setFolderRenameDraft'
  | 'clearFolderRename'
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'allowReselect'
  | 'onSessionSelected'
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'setSessionSearchQuery'
  | 'setIsSessionSearchOpen'
  | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm'
  | 'startFolderRename'
  | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
> & {
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
};

type SessionProjectScrollerGroupActions = Pick<SessionGroupSectionProps,
  | 'showMoreGroupSessions'
  | 'resetGroupSessionLimit'
  | 'setActiveProjectIdOnly'
  | 'setSessionSwitcherOpen'
  | 'openNewSessionDraft'
  | 'onToggleCollapsedGroup'
>;

type SessionProjectScrollerModel = {
  topContent?: React.ReactNode;
  /**
   * Whether the top content itself holds search results. The managed chats
   * render only there, so without this the "no project section matched" branch
   * below would drop a matching chat and claim there is nothing to show.
   */
  topContentHasSearchMatches?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  projectRepoStatus: Map<string, boolean | null>;
  stuckProjectHeaders: Set<string>;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  state: SessionProjectScrollerState;
  groupProps: SessionProjectScrollerGroupProps;
};

type SessionProjectScrollerView = {
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  hideDirectoryControls: boolean;
  isDesktopShellRuntime: boolean;
  stickyZoneHeaders: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  projectSortOrder: ProjectSortOrder;
};

type SessionProjectScrollerActions = {
  group: SessionProjectScrollerGroupActions;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  setSingleProjectId: (id: string) => void;
};

type Props = {
  model: SessionProjectScrollerModel;
  view: SessionProjectScrollerView;
  actions: SessionProjectScrollerActions;
};

const TOP_FADE_MAX_SIZE = 48;
const TOP_FADE_MIN_SIZE = 32;
const TOP_FADE_CLEAR_MAX_SIZE = 24;

const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => (
  formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(project.normalizedPath, homeDirectory)
    || project.normalizedPath,
  )
);

const ProjectWorktreeChangesIndicator = React.memo(function ProjectWorktreeChangesIndicator({
  groups,
  showTooltip = true,
}: {
  groups: SessionGroup[];
  showTooltip?: boolean;
}) {
  const { t } = useI18n();
  const directories = React.useMemo(() => groups
    .filter((group) => !group.isMain && !group.isArchivedBucket)
    .map((group) => normalizePath(group.directory ?? null))
    .filter((directory): directory is string => Boolean(directory)), [groups]);
  const hasWorktreeChanges = useGitStore(React.useCallback((state) => directories.some((directory) => {
    const comparison = state.directories.get(directory)?.worktreeComparisonSummary;
    return Boolean(comparison?.available && (comparison.hasCommittedChanges || comparison.isDirty));
  }), [directories]));
  const hasUnpushedCommits = useGitStore(React.useCallback((state) => directories.some((directory) => (
    (state.directories.get(directory)?.status?.ahead ?? 0) > 0
  )), [directories]));
  if (!hasWorktreeChanges && !hasUnpushedCommits) return null;

  const changeLabel = t('sessions.sidebar.project.status.worktreeChanges');
  const pushLabel = t('gitView.sync.pushTooltip');
  const indicator = (
    <span className="inline-flex shrink-0 items-center gap-1 text-status-warning">
      {hasWorktreeChanges || hasUnpushedCommits ? (
        <span className="inline-flex size-4 items-center justify-center" role="img" aria-label={hasWorktreeChanges ? changeLabel : pushLabel}>
          <Icon name="node-tree" className="size-3.5" />
        </span>
      ) : null}
      {hasUnpushedCommits ? (
        <span className="inline-flex size-4 items-center justify-center" role="img" aria-label={pushLabel}>
          <Icon name="arrow-up" className="size-3.5" />
        </span>
      ) : null}
    </span>
  );
  if (!showTooltip) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {hasWorktreeChanges ? <div>{changeLabel}</div> : null}
        {hasUnpushedCommits ? <div>{pushLabel}</div> : null}
      </TooltipContent>
    </Tooltip>
  );
});
function SessionProjectScrollerComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const { model, view, actions } = props;
  const isInlineEditing = model.state.editingId !== null;
  const enableStickyFade = view.isDesktopShellRuntime && view.stickyZoneHeaders && !model.singleProjectMode;
  const projectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  // Keep per-scroll measurements out of React state so the interaction guard
  // can read the current fade boundary without rerendering the sidebar.
  const topFadeSizeRef = React.useRef(0);
  // Update the viewport-owned fade on every scroll, but cross the React
  // render boundary only when the sticky identity overlay appears or hides.
  const syncTopFade = React.useCallback((scroller: HTMLElement) => {
    const hasTopScroll = scroller.scrollTop > 1;
    const topFadeSize = hasTopScroll
      ? Math.min(TOP_FADE_MIN_SIZE + scroller.scrollTop, TOP_FADE_MAX_SIZE)
      : 0;
    topFadeSizeRef.current = topFadeSize;
    const fadeRoot = scroller.closest<HTMLElement>('.oc-sticky-fade-root');
    fadeRoot?.style.setProperty('--scroll-shadow-top-size', `${topFadeSize}px`);
    fadeRoot?.style.setProperty(
      '--scroll-shadow-top-clear-size',
      `${Math.min(Math.max(topFadeSize - 8, 0), TOP_FADE_CLEAR_MAX_SIZE)}px`,
    );
  }, []);
  const blockObscuredInteraction = React.useCallback((
    event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>,
  ) => {
    // SAFETY: React's mouse and pointer events are dispatched from Elements.
    if ((event.target as Element).closest('[data-overlay-scrollbar-thumb], [data-sidebar-sticky-header]')) return;
    const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (eventY >= topFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const renderedSections = selectRenderedProjectSections(
    model.sectionsForRender,
    model.singleProjectMode,
    model.singleProjectId,
  );
  const hasProjectScroller = model.projectSections.length > 0 && renderedSections.length > 0;
  React.useLayoutEffect(() => {
    if (enableStickyFade && hasProjectScroller && scrollContainerRef.current) {
      syncTopFade(scrollContainerRef.current);
    }
  }, [enableStickyFade, hasProjectScroller, syncTopFade]);
  let stuckProject: ProjectSection['project'] | null = null;
  for (const section of model.projectSections) {
    if (model.stuckProjectHeaders.has(section.project.id)) {
      stuckProject = section.project;
    }
  }
  // The IntersectionObserver reports the stuck header asynchronously, a frame or
  // two after the synchronous fade has already hidden the real header — which
  // otherwise leaves a one-frame gap where the title blinks out with no crisp
  // replacement. Seed the overlay with the topmost rendered project so it is
  // ready in the same frame; the observer then corrects it. When shared sessions
  // lead the list, the Recent fallback below owns the top instead of a project.
  const leadingProject =
    stuckProject ?? (model.hasSharedSessions ? null : renderedSections[0]?.project ?? null);
  const leadingProjectLabel = leadingProject ? getProjectLabel(leadingProject, view.homeDirectory) : null;
  const projectPickerOptions = React.useMemo(() => model.projectSections.map((section) => ({
    id: section.project.id,
    projectLabel: getProjectLabel(section.project, view.homeDirectory),
    projectDescription: formatPathForDisplay(section.project.normalizedPath, view.homeDirectory),
    projectIcon: section.project.icon,
    projectColor: section.project.color,
    projectIconImage: section.project.iconImage,
    projectIconBackground: section.project.iconBackground,
  })), [model.projectSections, view.homeDirectory]);
  const structuralGroupsByProjectId = React.useMemo(
    () => new Map(model.projectSections.map((section) => [section.project.id, section.groups])),
    [model.projectSections],
  );
  const projectPaths = React.useMemo(
    () => model.projectSections.map((section) => section.project.normalizedPath),
    [model.projectSections],
  );
  const projectRootCleanStatus = useGitCleanStatusMap(projectPaths);
  const projectRootAheadStatus = useGitUpstreamAheadStatusMap(projectPaths);
  const { git } = useRuntimeAPIs();
  const worktreeDirectories = React.useMemo(() => model.projectSections
    .flatMap((section) => section.groups)
    .filter((group) => !group.isArchivedBucket && Boolean(group.worktree))
    .map((group) => normalizePath(group.directory ?? null))
    .filter((directory): directory is string => Boolean(directory)), [model.projectSections]);
  const worktreeDirectoriesKey = worktreeDirectories.join('\0');
  const projectPathsKey = projectPaths.join('\0');
  React.useEffect(() => {
    const linkedDirectories = worktreeDirectoriesKey ? worktreeDirectoriesKey.split('\0') : [];
    const rootDirectories = projectPathsKey ? projectPathsKey.split('\0') : [];
    const linkedDirectorySet = new Set(linkedDirectories);
    const rootDirectorySet = new Set(rootDirectories);
    const { ensureWorktreeComparison, fetchWorktreeComparison, ensureStatus, fetchStatus } = useGitStore.getState();
    const refreshLinkedDirectory = (directory: string) => {
      if (!linkedDirectorySet.has(directory)) return;
      if (git.getWorktreeComparison) void fetchWorktreeComparison(directory, git, { mode: 'combined' });
      void fetchStatus(directory, git, { silent: true });
    };
    linkedDirectories.forEach((directory) => {
      if (git.getWorktreeComparison) void ensureWorktreeComparison(directory, git, { mode: 'combined' });
      void ensureStatus(directory, git);
    });
    return sessionEvents.onGitRefreshHint((hint) => {
      const directory = normalizePath(hint.directory);
      if (!directory) return;
      if (rootDirectorySet.has(directory)) {
        linkedDirectories.forEach(refreshLinkedDirectory);
        void fetchStatus(directory, git, { silent: true });
        return;
      }
      refreshLinkedDirectory(directory);
    });
  }, [git, projectPathsKey, worktreeDirectoriesKey]);
  const leadingProjectGroups = leadingProject ? structuralGroupsByProjectId.get(leadingProject.id) ?? [] : [];
  const leadingProjectHasRootChanges = leadingProject
    ? projectRootCleanStatus.get(leadingProject.normalizedPath) === false
    : false;
  const leadingProjectRootAhead = leadingProject
    ? projectRootAheadStatus.get(leadingProject.normalizedPath) ?? null
    : null;
  const leadingProjectHasRootAhead = Boolean(leadingProjectRootAhead && leadingProjectRootAhead > 0);

  if (model.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className="space-y-1 pb-1 pl-2.5 pr-2">{model.topContent}{model.emptyState}</ScrollableOverlay>;
  }

  if (model.sectionsForRender.length === 0) {
    const placement = resolveSearchResultPlacement(model.topContentHasSearchMatches === true);
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className="space-y-1 pb-1 pl-2.5 pr-2">
      {placement === 'top-content' ? model.topContent : model.searchEmptyState}
    </ScrollableOverlay>;
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <div
      className="oc-sticky-fade-root relative flex min-h-0 flex-1"
      // SAFETY: this custom property configures the viewport-owned edge fade.
      style={enableStickyFade ? { '--scroll-shadow-top-size': '0px' } as React.CSSProperties : undefined}
      onPointerDownCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onClickCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onContextMenuCapture={enableStickyFade ? blockObscuredInteraction : undefined}
    >
      <ScrollableOverlay
        ref={scrollContainerRef}
        useScrollShadow
        hideTopScrollShadow={!enableStickyFade}
        scrollShadowSize={96}
        outerClassName="flex-1 min-h-0"
        className="oc-sidebar-scroller oc-sticky-fade-scroller space-y-1.5 pb-1 pl-2.5 pr-2 [overflow-anchor:none]"
        onScroll={enableStickyFade ? (event) => syncTopFade(event.currentTarget) : undefined}
      >
      {model.topContent}
      {view.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem] py-1">
          {(() => {
            const activeSection = renderedSections.find((section) => section.project.id === model.activeProjectId) ?? renderedSections[0];
            if (!activeSection) {
              return view.hasSessionSearchQuery ? model.searchEmptyState : model.emptyState;
            }
            const descriptors = buildGroupRenderDescriptors(activeSection, { mainWorkspaceOnly: true });
            if (!descriptors.length) {
              return <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessions.sidebar.empty.noSessions.title')}</div>;
            }
            return descriptors.map(({ group, groupKey, projectId, hideGroupLabel }) => {
              return (
                <React.Fragment key={groupKey}>
                  <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={group} groupKey={groupKey} projectId={projectId} hideGroupLabel={hideGroupLabel} visibleSessionCount={model.state.visibleSessionCountByGroup.get(groupKey)} compactBodyPadding scrollContainerRef={scrollContainerRef} />
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : (
        <DndContext
          sensors={projectSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
             if (isInlineEditing) return;
            // Drag only allowed in manual sort mode - indices from visual order don't match store order in other modes
            if (view.projectSortOrder !== 'manual') return;
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIndex = model.sectionsForRender.findIndex((section) => section.project.id === active.id);
            const newIndex = model.sectionsForRender.findIndex((section) => section.project.id === over.id);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
            actions.reorderProjects(oldIndex, newIndex);
          }}
        >
            <SortableContext items={renderedSections.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
            {renderedSections.map((section) => {
              const project = section.project;
              const projectKey = project.id;
              const projectLabel = getProjectLabel(project, view.homeDirectory);
              const projectDescription = formatPathForDisplay(project.normalizedPath, view.homeDirectory);
              const isCollapsed = model.singleProjectMode ? false : view.collapsedProjects.has(projectKey);
              const isRepo = model.projectRepoStatus.get(projectKey);
              const rootHasChanges = projectRootCleanStatus.get(project.normalizedPath) === false;
              const rootUpstreamAhead = projectRootAheadStatus.get(project.normalizedPath) ?? null;
              const structuralGroups = structuralGroupsByProjectId.get(projectKey) ?? section.groups;

              return (
                <SortableProjectItem
                  key={projectKey}
                  id={projectKey}
                  disabled={model.singleProjectMode || view.projectSortOrder !== 'manual'}
                  projectLabel={projectLabel}
                  projectDescription={projectDescription}
                  projectIcon={project.icon}
                  projectColor={project.color}
                  projectIconImage={project.iconImage}
                  projectIconBackground={project.iconBackground}
                  isCollapsed={isCollapsed}
                  isRepo={Boolean(isRepo)}
                  isDesktopShell={view.isDesktopShellRuntime}
                  hideDirectoryControls={view.hideDirectoryControls}
                  mobileVariant={view.mobileVariant}
                  alwaysShowActions={view.alwaysShowActions}
                  statusIndicator={isCollapsed ? actions.renderProjectStatusIndicator?.(projectKey, section.groups) : null}
                  rootHasChanges={rootHasChanges}
                  rootUpstreamAhead={rootUpstreamAhead}
                  worktreeChangesIndicator={isCollapsed ? <ProjectWorktreeChangesIndicator groups={structuralGroups} /> : null}
                  openSidebarMenuKey={model.state.openSidebarMenuKey}
                  setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
                  projectPickerOptions={model.singleProjectMode ? projectPickerOptions : undefined}
                  onProjectSelect={model.singleProjectMode ? actions.setSingleProjectId : undefined}
                  onToggle={() => { if (!model.singleProjectMode) actions.toggleProject(projectKey); }}
                  onNewSession={() => {
                    if (projectKey !== model.activeProjectId) actions.setActiveProjectIdOnly(projectKey);
                    if (view.mobileVariant) actions.setSessionSwitcherOpen(false);
                    actions.openNewSessionDraft({
                      selectedProjectId: projectKey,
                      directoryOverride: project.normalizedPath,
                    });
                  }}
                  onNewWorktreeSession={() => {
                    if (projectKey !== model.activeProjectId) actions.setActiveProjectIdOnly(projectKey);
                    actions.openNewWorktreeDialog();
                  }}
                  onManageWorktrees={() => actions.openWorktreesPage(projectKey)}
                  onRenameStart={() => actions.openProjectEditDialog(projectKey)}
                  onClose={() => actions.removeProject(projectKey)}
                  sentinelRef={(el) => { model.projectHeaderSentinelRefs.current.set(projectKey, el); }}
                  showCreateButtons
                 >
                  {!isCollapsed ? (
                    <div className="space-y-0 pt-0.5 pb-0.5">
                      {(() => {
                         const orderedGroups = section.groups;
                        const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
                        const nestedGroups = rootGroup
                          ? orderedGroups.filter((group) => group.id !== rootGroup.id)
                          : orderedGroups;
                        return (
                          <DndContext
                            sensors={groupSensors}
                            collisionDetection={closestCenter}
                            onDragEnd={(event) => {
                               if (isInlineEditing) return;
                              const { active, over } = event;
                              if (!over || active.id === over.id) return;
                              const oldIndex = nestedGroups.findIndex((item) => item.id === active.id);
                              const newIndex = nestedGroups.findIndex((item) => item.id === over.id);
                              if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
                              const nextNested = arrayMove(nestedGroups, oldIndex, newIndex).map((item) => item.id);
                              const next = rootGroup ? [rootGroup.id, ...nextNested] : nextNested;
                                 actions.setGroupOrderByProject((prev) => {
                                const map = new Map(prev);
                                map.set(projectKey, next);
                                return map;
                              });
                            }}
                          >
                            {/* Root/flat sessions render directly under the
                                project zone header; worktree and archived
                                groups keep their own slim sortable sub-header. */}
                              {rootGroup ? <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={rootGroup} groupKey={`${projectKey}:${rootGroup.id}`} projectId={projectKey} hideGroupLabel visibleSessionCount={model.state.visibleSessionCountByGroup.get(`${projectKey}:${rootGroup.id}`)} scrollContainerRef={scrollContainerRef} /> : null}
                            <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                              {nestedGroups.map((group) => {
                                const groupKey = `${projectKey}:${group.id}`;
                                return (
                                   <SortableGroupItem key={group.id} id={group.id} disabled={isInlineEditing}>
                                      {(dragHandleProps) => <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={group} groupKey={groupKey} projectId={projectKey} visibleSessionCount={model.state.visibleSessionCountByGroup.get(groupKey)} dragHandleProps={dragHandleProps} scrollContainerRef={scrollContainerRef} />}
                                  </SortableGroupItem>
                                );
                              })}
                            </SortableContext>
                            <DragOverlay dropAnimation={null} />
                          </DndContext>
                        );
                      })()}
                    </div>
                  ) : null}
                </SortableProjectItem>
              );
            })}
          </SortableContext>
          <DragOverlay dropAnimation={null} />
        </DndContext>
      )}
      </ScrollableOverlay>
      {enableStickyFade && (leadingProject || model.hasSharedSessions) ? (
        <div
          className="oc-sticky-fade-overlay pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 py-1 pl-4 pr-5"
          aria-hidden="true"
        >
          {leadingProject && leadingProjectLabel ? (
            <>
              <ProjectHeaderIdentity
                id={leadingProject.id}
                projectLabel={leadingProjectLabel}
                projectIcon={leadingProject.icon}
                projectColor={leadingProject.color}
                projectIconImage={leadingProject.iconImage}
                projectIconBackground={leadingProject.iconBackground}
              />
              {leadingProjectHasRootChanges || leadingProjectHasRootAhead ? (
                <Icon name="git-repository" className="size-3.5 shrink-0 text-status-warning" />
              ) : null}
              {leadingProjectHasRootAhead ? (
                <Icon name="arrow-up" className="size-3.5 shrink-0 text-status-warning" aria-label={t('gitView.sync.pushTooltipAhead', { count: leadingProjectRootAhead ?? 0 })} />
              ) : null}
              {view.collapsedProjects.has(leadingProject.id) ? (
                <ProjectWorktreeChangesIndicator groups={leadingProjectGroups} showTooltip={false} />
              ) : null}
            </>
          ) : (
            <>
              <Icon name="history" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
              <span className="truncate text-[14px] font-semibold lowercase text-foreground">
                {t('sessions.sidebar.activity.recentTitle')}
              </span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export const SessionProjectScroller = React.memo(SessionProjectScrollerComponent);
