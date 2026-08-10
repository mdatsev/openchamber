import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';
import { isDiscoverableSession } from '@/stores/useDisposableSideChatsStore';

type Project = {
  id: string;
  normalizedPath: string;
};

type Worktree = {
  path: string;
};

export type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree';
};

export type SessionOwnershipIndexFor<TSession> = {
  byIdentityKey: Map<string, DirectoryOwner>;
  bySessionId: Map<string, DirectoryOwner>;
  sessionsByProject: Map<string, TSession[]>;
  archivedSessionsByProject: Map<string, TSession[]>;
  sessionsByScope: Map<string, Set<string>>;
  omittedIdentityKeys: Set<string>;
  omittedSessionIds: Set<string>;
  directoryResolutions: number;
};

export type SessionOwnershipIndex = SessionOwnershipIndexFor<Session>;

export type SessionOwnershipRecordAdapter<TSession> = {
  getIdentityKey: (session: TSession) => string;
  getSessionId: (session: TSession) => string;
  getParentIdentityKey: (session: TSession) => string | null;
  getDirectory: (session: TSession) => string | null;
  isArchived: (session: TSession) => boolean;
  isDiscoverable: (session: TSession) => boolean;
};

const shouldReplaceOwner = (existing: DirectoryOwner | undefined, candidate: DirectoryOwner): boolean => {
  if (!existing) return true;
  if (candidate.kind !== existing.kind) {
    return candidate.kind === 'project';
  }
  if (candidate.projectRoot.length !== existing.projectRoot.length) {
    return candidate.projectRoot.length > existing.projectRoot.length;
  }
  return candidate.projectId.localeCompare(existing.projectId) < 0;
};

const setOwner = (owners: Map<string, DirectoryOwner>, directory: string, candidate: DirectoryOwner): void => {
  if (shouldReplaceOwner(owners.get(directory), candidate)) {
    owners.set(directory, candidate);
  }
};

const resolveOpenCodeSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory) ?? normalizePath(record.project?.worktree);
};

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:$/.test(directory)) {
    return null;
  }
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Z]:\//.test(directory)) return directory.slice(0, 2);
  return directory.slice(0, separator);
};

export const createRootSessionOwnershipIndex = <TSession>(
  sessions: TSession[],
  projects: Project[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode: boolean,
  adapter: SessionOwnershipRecordAdapter<TSession>,
  archivedSessions: TSession[] = [],
): SessionOwnershipIndexFor<TSession> => {
  const ownerByDirectory = new Map<string, DirectoryOwner>();
  const projectByRoot = new Map<string, Project>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    const existingProject = projectByRoot.get(projectRoot);
    if (!existingProject || project.id.localeCompare(existingProject.id) < 0) {
      projectByRoot.set(projectRoot, project);
    }
    setOwner(ownerByDirectory, projectRoot, {
      projectId: project.id,
      projectRoot,
      scopeDirectory: projectRoot,
      kind: 'project',
    });
  }

  if (!isVSCode) {
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const projectRoot = normalizePath(projectPath);
      const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
      if (!project || !projectRoot) continue;
      for (const worktree of worktrees) {
        const directory = normalizePath(worktree.path);
        if (!directory) continue;
        setOwner(ownerByDirectory, directory, {
          projectId: project.id,
          projectRoot,
          scopeDirectory: directory,
          kind: 'worktree',
        });
      }
    }
  }

  const resolvedOwners = new Map<string, DirectoryOwner | null>();
  const resolveOwner = (directory: string | null): DirectoryOwner | null => {
    if (!directory) return null;
    if (resolvedOwners.has(directory)) {
      return resolvedOwners.get(directory) ?? null;
    }

    if (isVSCode) {
      const owner = ownerByDirectory.get(directory) ?? null;
      resolvedOwners.set(directory, owner);
      return owner;
    }

    const visited: string[] = [];
    let current: string | null = directory;
    let owner: DirectoryOwner | null = null;
    while (current) {
      if (resolvedOwners.has(current)) {
        owner = resolvedOwners.get(current) ?? null;
        break;
      }
      visited.push(current);
      owner = ownerByDirectory.get(current) ?? null;
      if (owner) break;
      current = getParentDirectory(current);
    }
    for (const visitedDirectory of visited) {
      resolvedOwners.set(visitedDirectory, owner);
    }
    return owner;
  };

  const discoverableSessions = [...sessions, ...archivedSessions].filter(adapter.isDiscoverable);
  const sessionByIdentity = new Map(discoverableSessions.map((session) => [adapter.getIdentityKey(session), session]));
  const rootByIdentity = new Map<string, TSession | null>();
  const resolvingIdentities = new Set<string>();
  const resolveRootSession = (session: TSession): TSession | null => {
    const identityKey = adapter.getIdentityKey(session);
    if (rootByIdentity.has(identityKey)) {
      return rootByIdentity.get(identityKey) ?? null;
    }
    if (resolvingIdentities.has(identityKey)) {
      rootByIdentity.set(identityKey, null);
      return null;
    }
    const parentIdentityKey = adapter.getParentIdentityKey(session);
    if (!parentIdentityKey) {
      rootByIdentity.set(identityKey, session);
      return session;
    }

    resolvingIdentities.add(identityKey);
    const parent = sessionByIdentity.get(parentIdentityKey);
    const root = parent ? resolveRootSession(parent) : null;
    resolvingIdentities.delete(identityKey);
    rootByIdentity.set(identityKey, root);
    return root;
  };

  const ownerByRootIdentity = new Map<string, DirectoryOwner | null>();
  const resolveSessionOwner = (session: TSession): DirectoryOwner | null => {
    const root = resolveRootSession(session);
    if (!root || adapter.isArchived(root) !== adapter.isArchived(session)) return null;
    const rootIdentityKey = adapter.getIdentityKey(root);
    if (ownerByRootIdentity.has(rootIdentityKey)) {
      return ownerByRootIdentity.get(rootIdentityKey) ?? null;
    }
    const owner = resolveOwner(adapter.getDirectory(root));
    ownerByRootIdentity.set(rootIdentityKey, owner);
    return owner;
  };

  const byIdentityKey = new Map<string, DirectoryOwner>();
  const bySessionId = new Map<string, DirectoryOwner>();
  const sessionsByProject = new Map<string, TSession[]>();
  const archivedSessionsByProject = new Map<string, TSession[]>();
  const sessionsByScope = new Map<string, Set<string>>();
  const omittedIdentityKeys = new Set<string>();
  const omittedSessionIds = new Set<string>();

  const bucket = (
    input: TSession[],
    target: Map<string, TSession[]>,
    scopeTarget?: Map<string, Set<string>>,
  ): void => {
    for (const session of input) {
      if (!adapter.isDiscoverable(session)) continue;
      const identityKey = adapter.getIdentityKey(session);
      const sessionId = adapter.getSessionId(session);
      const owner = resolveSessionOwner(session);
      if (!owner) {
        omittedIdentityKeys.add(identityKey);
        omittedSessionIds.add(sessionId);
        continue;
      }
      byIdentityKey.set(identityKey, owner);
      bySessionId.set(sessionId, owner);
      const projectSessions = target.get(owner.projectId);
      if (projectSessions) {
        projectSessions.push(session);
      } else {
        target.set(owner.projectId, [session]);
      }
      if (!scopeTarget) continue;
      const scopeSessions = scopeTarget.get(owner.scopeDirectory);
      if (scopeSessions) {
        scopeSessions.add(sessionId);
      } else {
        scopeTarget.set(owner.scopeDirectory, new Set([sessionId]));
      }
    }
  };

  bucket(sessions, sessionsByProject, sessionsByScope);
  bucket(archivedSessions, archivedSessionsByProject);

  return {
    byIdentityKey,
    bySessionId,
    sessionsByProject,
    archivedSessionsByProject,
    sessionsByScope,
    omittedIdentityKeys,
    omittedSessionIds,
    directoryResolutions: resolvedOwners.size,
  };
};

export const createSessionOwnershipIndex = (
  sessions: Session[],
  projects: Project[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode: boolean,
  archivedSessions: Session[] = [],
): SessionOwnershipIndex => createRootSessionOwnershipIndex(
  sessions,
  projects,
  availableWorktreesByProject,
  isVSCode,
  {
    getIdentityKey: (session) => session.id,
    getSessionId: (session) => session.id,
    getParentIdentityKey: (session) => (
      (session as Session & { parentID?: string | null }).parentID ?? null
    ),
    getDirectory: resolveOpenCodeSessionDirectory,
    isArchived: (session) => Boolean(session.time?.archived),
    isDiscoverable: (session) => isDiscoverableSession(session),
  },
  archivedSessions,
);
