import fs from 'node:fs';
import path from 'node:path';

const CANONICAL_CUSTOM_REMOTE = 'https://github.com/mdatsev/openchamber.git';
const CANONICAL_CUSTOM_BRANCH = 'custom';
const CUSTOM_FETCH_REF = 'refs/openchamber/fork-runtime/custom';
const OFFICIAL_PACKAGE_URL = 'https://registry.npmjs.org/@openchamber%2fweb/latest';
const OFFICIAL_RELEASES_URL = 'https://github.com/openchamber/openchamber/releases/tag';
const COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const SUCCESS_CACHE_TTL_MS = 60_000;
const FAILURE_RETRY_TTL_MS = 15_000;
const MAX_OPERATION_LOG_LINES = 32;

let forkUpdateOperationActive = false;

export const isForkUpdateOperationActive = () => forkUpdateOperationActive;

class ForkRuntimeError extends Error {
  constructor(code, message, output = []) {
    super(message);
    this.name = 'ForkRuntimeError';
    this.code = code;
    this.output = output;
  }
}

const nowIso = () => new Date().toISOString();

const normalizeEnvironmentString = (value, fallback = '') => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
);

const isSafeBranchName = (value) => (
  value.length <= 200
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  && !value.includes('..')
  && !value.includes('//')
  && !value.includes('@{')
  && !value.endsWith('/')
  && !value.endsWith('.')
  && !value.endsWith('.lock')
);

const errorPayload = (code, message) => ({ code, message });

const isMissingPathError = (error) => error?.code === 'ENOENT';

const boundedOutputLines = (stdout, stderr) => `${stdout || ''}\n${stderr || ''}`
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(-6)
  .map((line) => line.slice(0, 240));

const readStartupHead = (repoPath) => {
  try {
    const dotGitPath = path.join(repoPath, '.git');
    const dotGitStats = fs.statSync(dotGitPath);
    let gitDirectory = dotGitPath;
    if (dotGitStats.isFile()) {
      const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return null;
      const candidate = pointer.slice('gitdir:'.length).trim();
      gitDirectory = path.resolve(repoPath, candidate);
    }

    const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return { commit: head, branch: null };
    if (!head.startsWith('ref: ')) return null;
    const ref = head.slice('ref: '.length).trim();
    const commonDirectory = (() => {
      try {
        const relative = fs.readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim();
        return path.resolve(gitDirectory, relative);
      } catch {
        return gitDirectory;
      }
    })();
    let commit = null;
    for (const baseDirectory of [gitDirectory, commonDirectory]) {
      try {
        const value = fs.readFileSync(path.join(baseDirectory, ref), 'utf8').trim();
        if (/^[0-9a-f]{40,64}$/i.test(value)) {
          commit = value;
          break;
        }
      } catch {
      }
    }
    if (!commit) {
      const packedRefs = fs.readFileSync(path.join(commonDirectory, 'packed-refs'), 'utf8');
      const match = packedRefs.split('\n').find((line) => line.endsWith(` ${ref}`));
      const value = match?.split(' ')[0] ?? '';
      if (/^[0-9a-f]{40,64}$/i.test(value)) commit = value;
    }
    if (!commit) return null;
    return {
      commit,
      branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
    };
  } catch {
    return null;
  }
};

export const createForkRuntime = ({
  serverDirectory,
  openchamberVersion,
  serverStartedAt,
  managedRestartSupported,
  environment = process.env,
  execFileImpl = null,
  fetchImpl = fetch,
  fsPromises = fs.promises,
}) => {
  const inferredRepoPath = path.resolve(serverDirectory, '..', '..', '..');
  const configuredRepoPath = normalizeEnvironmentString(
    environment.OPENCHAMBER_CUSTOM_FORK_REPO,
    inferredRepoPath,
  );
  const repoPath = path.resolve(configuredRepoPath);
  const customRemote = normalizeEnvironmentString(
    environment.OPENCHAMBER_CUSTOM_FORK_REMOTE,
    CANONICAL_CUSTOM_REMOTE,
  );
  const customBranch = normalizeEnvironmentString(
    environment.OPENCHAMBER_CUSTOM_FORK_BRANCH,
    CANONICAL_CUSTOM_BRANCH,
  );
  const bunBinary = normalizeEnvironmentString(environment.OPENCHAMBER_BUN_BINARY, 'bun');
  const updateStatePath = normalizeEnvironmentString(environment.OPENCHAMBER_CUSTOM_FORK_UPDATE_STATE);
  const updateHelperPath = normalizeEnvironmentString(environment.OPENCHAMBER_CUSTOM_FORK_UPDATE_HELPER);
  const updateProtocol = normalizeEnvironmentString(environment.OPENCHAMBER_CUSTOM_FORK_UPDATE_PROTOCOL);
  const runningVersion = normalizeEnvironmentString(openchamberVersion, 'unknown');
  const startedAt = normalizeEnvironmentString(serverStartedAt, nowIso());
  const commandEnvironment = {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
  };
  const startupHead = readStartupHead(repoPath);

  let resolvedExecFile = execFileImpl;
  const getExecFile = async () => {
    if (resolvedExecFile) return resolvedExecFile;
    const childProcess = await import('node:child_process');
    resolvedExecFile = childProcess.execFile;
    return resolvedExecFile;
  };

  const runFile = async (file, args, {
    cwd = repoPath,
    env = commandEnvironment,
    timeout = COMMAND_TIMEOUT_MS,
    maxBuffer = 1024 * 1024,
    allowExitCodes = [],
    label = path.basename(file),
    exposeOutput = false,
  } = {}) => {
    const executeFile = await getExecFile();
    return new Promise((resolve, reject) => {
      executeFile(file, args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer,
        timeout,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const exitCode = Number.isInteger(error?.code) ? error.code : 0;
        if (error && !allowExitCodes.includes(exitCode)) {
          const suffix = exitCode ? ` (exit ${exitCode})` : '';
          reject(new ForkRuntimeError(
            'COMMAND_FAILED',
            `${label} failed${suffix}.`,
            exposeOutput ? boundedOutputLines(stdout, stderr) : [],
          ));
          return;
        }
        resolve({
          exitCode,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      });
    });
  };

  const runGit = (args, options = {}) => runFile('git', args, {
    ...options,
    label: options.label || 'Git command',
  });

  const readPackageVersion = async (packagePath) => {
    const payload = JSON.parse(await fsPromises.readFile(packagePath, 'utf8'));
    if (typeof payload?.version !== 'string' || !payload.version.trim()) {
      throw new ForkRuntimeError('PACKAGE_VERSION_INVALID', 'OpenChamber package version is invalid.');
    }
    return payload.version.trim();
  };

  const readVersionAtRef = async (ref) => {
    const result = await runGit(['show', `${ref}:packages/web/package.json`], {
      label: 'Reading target package version',
    });
    const payload = JSON.parse(result.stdout);
    if (typeof payload?.version !== 'string' || !payload.version.trim()) {
      throw new ForkRuntimeError('PACKAGE_VERSION_INVALID', 'Target OpenChamber package version is invalid.');
    }
    return payload.version.trim();
  };

  const readWorkspaceNamesAtRef = async (ref) => {
    const result = await runGit(['ls-tree', '-r', '--name-only', ref, '--', 'packages'], {
      label: 'Reading workspace manifests',
    });
    return new Set(result.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => /^packages\/[^/]+\/package\.json$/.test(value))
      .map((value) => value.split('/')[1]));
  };

  const readCheckoutIdentity = async () => {
    try {
      const [commitResult, branchResult, statusResult, tagsResult, version] = await Promise.all([
        runGit(['rev-parse', 'HEAD'], { label: 'Reading checkout commit' }),
        runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
          allowExitCodes: [1],
          label: 'Reading checkout branch',
        }),
        runGit(['status', '--porcelain=v1', '--untracked-files=all'], {
          label: 'Reading checkout state',
        }),
        runGit(['tag', '--points-at', 'HEAD'], { label: 'Reading checkout tags' }),
        readPackageVersion(path.join(repoPath, 'packages', 'web', 'package.json')),
      ]);
      const tags = tagsResult.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
      return {
        commit: commitResult.stdout.trim() || null,
        version,
        tag: tags[0] || null,
        tags,
        branch: branchResult.stdout.trim() || null,
        dirty: statusResult.stdout.length > 0,
        error: null,
      };
    } catch {
      return {
        commit: null,
        version: null,
        tag: null,
        tags: [],
        branch: null,
        dirty: null,
        error: errorPayload('CHECKOUT_IDENTITY_UNAVAILABLE', 'Could not read the custom checkout identity.'),
      };
    }
  };

  const compareCommits = async (left, right) => {
    const result = await runGit(['rev-list', '--left-right', '--count', `${left}...${right}`], {
      label: 'Comparing OpenChamber revisions',
    });
    const [aheadValue, behindValue] = result.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadValue, 10);
    const behind = Number.parseInt(behindValue, 10);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
      throw new ForkRuntimeError('COMPARISON_INVALID', 'Git returned an invalid revision comparison.');
    }
    let state = 'current';
    if (ahead > 0 && behind > 0) state = 'diverged';
    else if (ahead > 0) state = 'ahead';
    else if (behind > 0) state = 'behind';
    return { state, ahead, behind };
  };

  const initializeSource = async () => {
    if (!customRemote) {
      return {
        sourceCheckout: false,
        running: null,
        unsupportedReason: errorPayload('CUSTOM_REMOTE_NOT_CONFIGURED', 'The custom fork remote is not configured.'),
      };
    }
    if (!isSafeBranchName(customBranch)) {
      return {
        sourceCheckout: false,
        running: null,
        unsupportedReason: errorPayload('CUSTOM_BRANCH_INVALID', 'The configured custom fork branch is invalid.'),
      };
    }

    try {
      const [repoRealPath, packageRealPath, topLevelResult] = await Promise.all([
        fsPromises.realpath(repoPath),
        fsPromises.realpath(path.resolve(serverDirectory, '..')),
        runGit(['rev-parse', '--show-toplevel'], { label: 'Locating custom source checkout' }),
      ]);
      const topLevelRealPath = await fsPromises.realpath(topLevelResult.stdout.trim());
      const expectedPackageRealPath = await fsPromises.realpath(path.join(repoRealPath, 'packages', 'web'));
      if (repoRealPath !== topLevelRealPath || packageRealPath !== expectedPackageRealPath) {
        throw new ForkRuntimeError(
          'SOURCE_CHECKOUT_MISMATCH',
          'The running OpenChamber server is not loaded from the configured custom checkout.',
        );
      }
    } catch (error) {
      const reason = error instanceof ForkRuntimeError
        ? errorPayload(error.code, error.message)
        : errorPayload('SOURCE_CHECKOUT_REQUIRED', 'Managed fork updates require a source checkout.');
      return { sourceCheckout: false, running: null, unsupportedReason: reason };
    }

    const observedCheckout = await readCheckoutIdentity();
    let running = observedCheckout;
    if (startupHead?.commit) {
      const tagsResult = await runGit(['tag', '--points-at', startupHead.commit], {
        label: 'Reading startup revision tags',
      }).catch(() => ({ stdout: '' }));
      const tags = tagsResult.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
      running = {
        ...observedCheckout,
        commit: startupHead.commit,
        branch: startupHead.branch,
        dirty: observedCheckout.commit === startupHead.commit ? observedCheckout.dirty : null,
        tag: tags[0] || null,
        tags,
      };
    }
    if (running.error || !running.commit) {
      return {
        sourceCheckout: false,
        running,
        unsupportedReason: errorPayload(
          'RUNNING_IDENTITY_UNAVAILABLE',
          'Managed fork updates require an identifiable source checkout.',
        ),
      };
    }
    return { sourceCheckout: true, running, unsupportedReason: null };
  };

  let initializationPromise = null;
  const getInitialization = () => {
    if (!initializationPromise) {
      initializationPromise = initializeSource().then((source) => ({
        ...source,
        running: {
          commit: source.running?.commit ?? null,
          version: runningVersion,
          tag: source.running?.tag ?? null,
          tags: source.running?.tags ?? [],
          branch: source.running?.branch ?? null,
          dirty: source.running?.dirty ?? null,
          startedAt,
          error: source.running?.error ?? (source.sourceCheckout ? null : source.unsupportedReason),
        },
      }));
    }
    return initializationPromise;
  };

  let customCache = null;
  let customRefreshPromise = null;
  let officialCache = null;
  let officialRefreshPromise = null;
  let operation = { phase: 'idle' };
  let operationPromise = null;

  const cachedSourceResult = (cache, stale, checkedAt, error) => ({
    ...cache.value,
    checkedAt,
    lastSuccessfulAt: cache.lastSuccessfulAt,
    stale,
    error: error ?? cache.value.error ?? null,
  });

  const refreshCustomStatus = async ({ force = false } = {}) => {
    const source = await getInitialization();
    const checkedAt = nowIso();
    if (!source.sourceCheckout) {
      return {
        branch: customBranch,
        latestCommit: null,
        latestVersion: null,
        comparison: 'unknown',
        ahead: null,
        behind: null,
        checkedAt,
        lastSuccessfulAt: null,
        stale: true,
        error: source.unsupportedReason,
      };
    }

    const now = Date.now();
    if (!force && customCache) {
      if (customCache.error && now - customCache.attemptedAt < FAILURE_RETRY_TTL_MS) {
        return cachedSourceResult(customCache, true, customCache.checkedAt, customCache.error);
      }
      if (!customCache.error && now - customCache.succeededAt < SUCCESS_CACHE_TTL_MS) {
        return cachedSourceResult(customCache, false, customCache.checkedAt, null);
      }
    }
    if (customRefreshPromise) return customRefreshPromise;

    customRefreshPromise = (async () => {
      const attemptedAt = Date.now();
      const attemptCheckedAt = nowIso();
      try {
        await runGit([
          'fetch',
          '--no-tags',
          '--force',
          '--',
          customRemote,
          `+refs/heads/${customBranch}:${CUSTOM_FETCH_REF}`,
        ], {
          timeout: COMMAND_TIMEOUT_MS,
          label: 'Refreshing canonical custom branch',
        });
        const [commitResult, latestVersion] = await Promise.all([
          runGit(['rev-parse', `${CUSTOM_FETCH_REF}^{commit}`], {
            label: 'Reading canonical custom revision',
          }),
          readVersionAtRef(CUSTOM_FETCH_REF),
        ]);
        const latestCommit = commitResult.stdout.trim();
        let comparison = { state: 'unknown', ahead: null, behind: null };
        let comparisonError = null;
        try {
          comparison = await compareCommits(source.running.commit, latestCommit);
        } catch {
          comparisonError = errorPayload(
            'RUNNING_COMPARISON_UNAVAILABLE',
            'Could not compare the loaded OpenChamber revision with the custom branch.',
          );
        }
        const value = {
          branch: customBranch,
          latestCommit,
          latestVersion,
          comparison: comparison.state,
          ahead: comparison.ahead,
          behind: comparison.behind,
          error: comparisonError,
        };
        customCache = {
          value,
          attemptedAt,
          succeededAt: attemptedAt,
          checkedAt: attemptCheckedAt,
          lastSuccessfulAt: attemptCheckedAt,
          error: null,
        };
        return cachedSourceResult(customCache, false, attemptCheckedAt, comparisonError);
      } catch {
        const refreshError = errorPayload(
          'CUSTOM_FETCH_FAILED',
          'Failed to refresh the canonical custom branch.',
        );
        if (customCache?.value) {
          customCache = {
            ...customCache,
            attemptedAt,
            checkedAt: attemptCheckedAt,
            error: refreshError,
          };
          return cachedSourceResult(customCache, true, attemptCheckedAt, refreshError);
        }
        return {
          branch: customBranch,
          latestCommit: null,
          latestVersion: null,
          comparison: 'unknown',
          ahead: null,
          behind: null,
          checkedAt: attemptCheckedAt,
          lastSuccessfulAt: null,
          stale: true,
          error: refreshError,
        };
      } finally {
        customRefreshPromise = null;
      }
    })();
    return customRefreshPromise;
  };

  const refreshOfficialStatus = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && officialCache) {
      if (officialCache.error && now - officialCache.attemptedAt < FAILURE_RETRY_TTL_MS) {
        return cachedSourceResult(officialCache, true, officialCache.checkedAt, officialCache.error);
      }
      if (!officialCache.error && now - officialCache.succeededAt < SUCCESS_CACHE_TTL_MS) {
        return cachedSourceResult(officialCache, false, officialCache.checkedAt, null);
      }
    }
    if (officialRefreshPromise) return officialRefreshPromise;

    officialRefreshPromise = (async () => {
      const attemptedAt = Date.now();
      const attemptCheckedAt = nowIso();
      try {
        const response = await fetchImpl(OFFICIAL_PACKAGE_URL, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'openchamber-fork-runtime',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new ForkRuntimeError(
            'OFFICIAL_RELEASE_FETCH_FAILED',
            `The npm registry returned ${response.status}.`,
          );
        }
        const payload = await response.json();
        const latestVersion = typeof payload?.version === 'string' ? payload.version.trim() : '';
        if (!latestVersion) {
          throw new ForkRuntimeError('OFFICIAL_RELEASE_INVALID', 'The npm registry response has no version.');
        }
        const value = {
          latestVersion,
          releaseUrl: `${OFFICIAL_RELEASES_URL}/v${encodeURIComponent(latestVersion)}`,
          error: null,
        };
        officialCache = {
          value,
          attemptedAt,
          succeededAt: attemptedAt,
          checkedAt: attemptCheckedAt,
          lastSuccessfulAt: attemptCheckedAt,
          error: null,
        };
        return cachedSourceResult(officialCache, false, attemptCheckedAt, null);
      } catch {
        const refreshError = errorPayload(
          'OFFICIAL_RELEASE_FETCH_FAILED',
          'Failed to read the latest official @openchamber/web release.',
        );
        if (officialCache?.value) {
          officialCache = {
            ...officialCache,
            attemptedAt,
            checkedAt: attemptCheckedAt,
            error: refreshError,
          };
          return cachedSourceResult(officialCache, true, attemptCheckedAt, refreshError);
        }
        return {
          latestVersion: null,
          releaseUrl: null,
          checkedAt: attemptCheckedAt,
          lastSuccessfulAt: null,
          stale: true,
          error: refreshError,
        };
      } finally {
        officialRefreshPromise = null;
      }
    })();
    return officialRefreshPromise;
  };

  const getStaticUpdateCapability = (source) => {
    if (!source.sourceCheckout) {
      return { supported: false, reason: source.unsupportedReason };
    }
    if (!managedRestartSupported) {
      return {
        supported: false,
        reason: errorPayload(
          'MANAGED_RESTART_REQUIRED',
          'Managed fork updates require managed OpenChamber restart support.',
        ),
      };
    }
    if (
      !path.isAbsolute(updateStatePath)
      || !path.isAbsolute(updateHelperPath)
      || !fs.existsSync(updateHelperPath)
      || updateProtocol !== '1'
    ) {
      return {
        supported: false,
        reason: errorPayload(
          'UPDATE_HELPER_REQUIRED',
          'Managed fork updates require the installed pre-start update helper.',
        ),
      };
    }
    return { supported: true, reason: null };
  };

  const getUpdateBlock = async (checkout, custom) => {
    if (checkout.error || !checkout.commit) {
      return errorPayload('CHECKOUT_IDENTITY_UNAVAILABLE', 'The live checkout identity is unavailable.');
    }
    if (checkout.branch !== customBranch) {
      return errorPayload(
        'CUSTOM_BRANCH_REQUIRED',
        `The live checkout must be on branch ${customBranch}.`,
      );
    }
    if (checkout.dirty !== false) {
      return errorPayload(
        'CHECKOUT_NOT_CLEAN',
        'The live checkout must be fully clean, including untracked files.',
      );
    }
    if (custom.stale || custom.error || !custom.latestCommit) {
      return errorPayload(
        'CUSTOM_REFRESH_REQUIRED',
        'A fresh canonical custom branch status is required before updating.',
      );
    }
    try {
      const comparison = await compareCommits(checkout.commit, custom.latestCommit);
      if (comparison.ahead > 0) {
        return errorPayload(
          'FAST_FORWARD_REQUIRED',
          comparison.behind > 0
            ? 'The live checkout has diverged from the canonical custom branch.'
            : 'The live checkout contains commits not present on the canonical custom branch.',
        );
      }
      return null;
    } catch {
      return errorPayload(
        'CHECKOUT_COMPARISON_UNAVAILABLE',
        'Could not verify that the custom update is a fast-forward.',
      );
    }
  };

  const getStatus = async ({ force = false } = {}) => {
    await syncUpdateState();
    const source = await getInitialization();
    const [checkout, custom, official] = await Promise.all([
      source.sourceCheckout ? readCheckoutIdentity() : Promise.resolve({
        commit: null,
        version: null,
        tag: null,
        tags: [],
        branch: null,
        dirty: null,
        error: source.unsupportedReason,
      }),
      refreshCustomStatus({ force }),
      refreshOfficialStatus({ force }),
    ]);
    let checkoutComparison = { state: 'unknown', ahead: null, behind: null };
    let checkoutComparisonError = null;
    if (!custom.stale && custom.latestCommit && checkout.commit) {
      try {
        checkoutComparison = await compareCommits(checkout.commit, custom.latestCommit);
      } catch {
        checkoutComparisonError = errorPayload(
          'CHECKOUT_COMPARISON_UNAVAILABLE',
          'Could not compare the checked-out OpenChamber revision with the custom branch.',
        );
      }
    }
    const staticCapability = getStaticUpdateCapability(source);
    const blockReason = staticCapability.supported
      ? await getUpdateBlock(checkout, custom)
      : null;

    return {
      running: source.running,
      checkout,
      custom: {
        ...custom,
        runningComparison: {
          state: custom.comparison,
          ahead: custom.ahead,
          behind: custom.behind,
          error: custom.error,
        },
        checkoutComparison: {
          ...checkoutComparison,
          error: checkoutComparisonError,
        },
      },
      official,
      checkedAt: nowIso(),
      capabilities: {
        status: { supported: true },
        restart: { supported: managedRestartSupported === true },
        update: {
          supported: staticCapability.supported,
          unsupportedReason: staticCapability.reason,
          blocked: Boolean(blockReason),
          blockReason,
          canUpdate: staticCapability.supported && !blockReason,
        },
      },
      operation,
    };
  };

  const appendOperationLog = (phase, message) => {
    const logs = [
      ...(Array.isArray(operation.logs) ? operation.logs : []),
      { at: nowIso(), phase, message: String(message).slice(0, 240) },
    ].slice(-MAX_OPERATION_LOG_LINES);
    operation = { ...operation, logs };
  };

  const transitionOperation = (phase, details, message) => {
    operation = {
      ...operation,
      ...details,
      phase,
      updatedAt: nowIso(),
    };
    if (message) appendOperationLog(phase, message);
  };

  const pathExists = async (filePath) => {
    try {
      await fsPromises.lstat(filePath);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  };

  const assertDirectory = async (directory, code, message) => {
    try {
      const stats = await fsPromises.stat(directory);
      if (stats.isDirectory()) return;
    } catch {
    }
    throw new ForkRuntimeError(code, message);
  };

  const mergeMissingAssets = async (sourceDirectory, targetDirectory) => {
    if (!await pathExists(sourceDirectory)) return;
    await fsPromises.mkdir(targetDirectory, { recursive: true });
    const entries = await fsPromises.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      if (!await pathExists(targetPath)) {
        await fsPromises.cp(sourcePath, targetPath, { recursive: true, force: false });
      } else if (entry.isDirectory()) {
        await mergeMissingAssets(sourcePath, targetPath);
      }
    }
  };

  const cleanupUpdate = async ({ stagingPath, tempRoot, worktreeAdded }) => {
    if (worktreeAdded) {
      try {
        await runGit(['worktree', 'remove', '--force', stagingPath], {
          label: 'Removing update worktree',
        });
      } catch {
        appendOperationLog(operation.phase, 'Staging worktree cleanup requires a later retry.');
      }
    }
    if (tempRoot) {
      try {
        await fsPromises.rm(tempRoot, { recursive: true, force: true });
      } catch {
        appendOperationLog(operation.phase, 'Temporary update files could not be fully removed.');
      }
    }
  };

  const readUpdateState = async () => {
    if (!path.isAbsolute(updateStatePath) || !await pathExists(updateStatePath)) return null;
    try {
      return JSON.parse(await fsPromises.readFile(updateStatePath, 'utf8'));
    } catch {
      return {
        version: 1,
        phase: 'failed',
        error: errorPayload('UPDATE_STATE_INVALID', 'The prepared custom update state is invalid.'),
      };
    }
  };

  const writeUpdateState = async (state) => {
    const temporaryPath = `${updateStatePath}.${process.pid}.tmp`;
    await fsPromises.mkdir(path.dirname(updateStatePath), { recursive: true });
    const handle = await fsPromises.open(temporaryPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(temporaryPath, updateStatePath);
    let directoryHandle;
    try {
      directoryHandle = await fsPromises.open(path.dirname(updateStatePath), 'r');
      await directoryHandle.sync();
    } catch {
      // Some platforms do not support syncing directory handles.
    } finally {
      await directoryHandle?.close().catch(() => {});
    }
  };

  const syncUpdateState = async () => {
    if (operationPromise) return;
    const state = await readUpdateState();
    if (!state || (state.phase !== 'prepared' && state.phase !== 'failed')) return;
    let timestamp;
    if (typeof state.updatedAt === 'string') {
      timestamp = state.updatedAt;
    } else if (typeof state.preparedAt === 'string') {
      timestamp = state.preparedAt;
    } else {
      timestamp = nowIso();
    }
    operation = {
      phase: state.phase === 'prepared' ? 'ready' : 'failed',
      startedAt: typeof state.startedAt === 'string' ? state.startedAt : timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      from: typeof state.from === 'string' ? state.from : null,
      target: typeof state.target === 'string' ? state.target : null,
      ...(state.phase === 'failed'
        ? { error: state.error ?? errorPayload('FORK_UPDATE_APPLY_FAILED', 'The prepared update could not be applied.') }
        : { changed: true, prepared: true }),
      logs: Array.isArray(state.logs) ? state.logs.slice(-MAX_OPERATION_LOG_LINES) : [],
    };
  };

  const performUpdate = async () => {
    const source = await getInitialization();
    const staticCapability = getStaticUpdateCapability(source);
    if (!staticCapability.supported) {
      throw new ForkRuntimeError(staticCapability.reason.code, staticCapability.reason.message);
    }

    transitionOperation('checking', {}, 'Refreshing the canonical custom branch.');
    const custom = await refreshCustomStatus({ force: true });
    const checkout = await readCheckoutIdentity();
    const blockReason = await getUpdateBlock(checkout, custom);
    if (blockReason) throw new ForkRuntimeError(blockReason.code, blockReason.message);

    const from = checkout.commit;
    const target = custom.latestCommit;
    transitionOperation('checking', { from, target }, 'Verified the live checkout and update target.');
    if (from === target) {
      transitionOperation('ready', {
        changed: false,
        alreadyCurrent: true,
        completedAt: nowIso(),
      }, 'The custom checkout is already current; no files were changed.');
      return;
    }

    let tempRoot = null;
    let stagingPath = null;
    let worktreeAdded = false;
    let prepared = false;
    try {
      transitionOperation('preparing', {}, 'Creating a detached staging worktree beside the live checkout.');
      tempRoot = await fsPromises.mkdtemp(path.join(path.dirname(repoPath), '.openchamber-update-'));
      stagingPath = path.join(tempRoot, 'checkout');
      await runGit(['worktree', 'add', '--detach', stagingPath, target], {
        label: 'Creating update worktree',
      });
      worktreeAdded = true;

      transitionOperation('installing', {}, 'Installing the target lockfile in the staging worktree.');
      const installResult = await runFile(bunBinary, ['install', '--frozen-lockfile'], {
        cwd: stagingPath,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        label: 'Staged bun install',
        exposeOutput: true,
      });
      for (const line of boundedOutputLines(installResult.stdout, installResult.stderr)) {
        appendOperationLog('installing', line);
      }

      transitionOperation('building', {}, 'Building the target web application in the staging worktree.');
      const buildResult = await runFile(bunBinary, ['run', 'build:web'], {
        cwd: stagingPath,
        env: { ...commandEnvironment, OPENCHAMBER_BUILD_COMMIT: target },
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        label: 'Staged web build',
        exposeOutput: true,
      });
      for (const line of boundedOutputLines(buildResult.stdout, buildResult.stderr)) {
        appendOperationLog('building', line);
      }

      const stagedNodeModules = path.join(stagingPath, 'node_modules');
      const stagedDist = path.join(stagingPath, 'packages', 'web', 'dist');
      const stagedAssets = path.join(stagedDist, 'assets');
      await assertDirectory(
        stagedNodeModules,
        'STAGED_INSTALL_INVALID',
        'The staged install did not produce root node_modules.',
      );
      try {
        const indexStats = await fsPromises.stat(path.join(stagedDist, 'index.html'));
        if (!indexStats.isFile()) throw new Error('not a file');
      } catch {
        throw new ForkRuntimeError('STAGED_BUILD_INVALID', 'The staged build has no valid index.html.');
      }
      await assertDirectory(stagedAssets, 'STAGED_BUILD_INVALID', 'The staged build has no assets directory.');
      if ((await fsPromises.readdir(stagedAssets)).length === 0) {
        throw new ForkRuntimeError('STAGED_BUILD_INVALID', 'The staged build assets directory is empty.');
      }
      await mergeMissingAssets(path.join(repoPath, 'packages', 'web', 'dist', 'assets'), stagedAssets);
      appendOperationLog('building', 'Validated the staged index and assets and retained existing hashed chunks.');

      const liveIdentity = await readCheckoutIdentity();
      if (liveIdentity.commit !== from) {
        throw new ForkRuntimeError('CHECKOUT_CHANGED', 'The live checkout commit changed while the update was prepared.');
      }
      if (liveIdentity.branch !== customBranch) {
        throw new ForkRuntimeError('CUSTOM_BRANCH_REQUIRED', `The live checkout is no longer on branch ${customBranch}.`);
      }
      if (liveIdentity.dirty !== false) {
        throw new ForkRuntimeError('CHECKOUT_NOT_CLEAN', 'The live checkout changed while the update was prepared.');
      }
      const liveComparison = await compareCommits(liveIdentity.commit, target);
      if (liveComparison.ahead > 0) {
        throw new ForkRuntimeError('FAST_FORWARD_REQUIRED', 'The prepared update is no longer a fast-forward.');
      }

      transitionOperation('applying', {}, 'Recording the validated update for the next managed restart.');
      const backupRoot = path.join(tempRoot, 'backups');
      await fsPromises.mkdir(backupRoot, { recursive: true });
      const plannedSwaps = [{
        action: 'replace',
        stagedPath: stagedNodeModules,
        livePath: path.join(repoPath, 'node_modules'),
        backupPath: path.join(backupRoot, 'node_modules'),
        name: 'root node_modules',
      }];
      const stagingPackagesPath = path.join(stagingPath, 'packages');
      const livePackagesPath = path.join(repoPath, 'packages');
      const [targetWorkspaceNames, currentWorkspaceNames] = await Promise.all([
        readWorkspaceNamesAtRef(target),
        readWorkspaceNamesAtRef(from),
      ]);
      const workspaceNames = new Set([
        ...targetWorkspaceNames,
        ...currentWorkspaceNames,
      ]);
      for (const workspaceName of workspaceNames) {
        const stagedWorkspaceNodeModules = path.join(stagingPackagesPath, workspaceName, 'node_modules');
        const liveWorkspaceNodeModules = path.join(livePackagesPath, workspaceName, 'node_modules');
        const stagedWorkspaceDependenciesExist = await pathExists(stagedWorkspaceNodeModules);
        if (!stagedWorkspaceDependenciesExist && !await pathExists(liveWorkspaceNodeModules)) continue;
        const workspaceBackupRoot = path.join(backupRoot, 'packages', workspaceName);
        await fsPromises.mkdir(workspaceBackupRoot, { recursive: true });
        plannedSwaps.push({
          action: stagedWorkspaceDependenciesExist ? 'replace' : 'remove',
          stagedPath: stagedWorkspaceDependenciesExist ? stagedWorkspaceNodeModules : null,
          livePath: liveWorkspaceNodeModules,
          backupPath: path.join(workspaceBackupRoot, 'node_modules'),
          name: `${workspaceName} node_modules`,
        });
      }
      plannedSwaps.push({
        action: 'replace',
        stagedPath: stagedDist,
        livePath: path.join(repoPath, 'packages', 'web', 'dist'),
        backupPath: path.join(backupRoot, 'web-dist'),
        name: 'web dist',
      });
      const stagedUpdateHelper = path.join(
        stagingPath,
        'scripts',
        'openchamber-runtime',
        'apply-custom-update.mjs',
      );
      try {
        const helperStats = await fsPromises.stat(stagedUpdateHelper);
        if (!helperStats.isFile()) throw new Error('not a file');
      } catch {
        throw new ForkRuntimeError('STAGED_HELPER_INVALID', 'The staged update helper is missing.');
      }
      const stagedHelperProtocol = await runFile(process.execPath, [stagedUpdateHelper, '--protocol'], {
        cwd: stagingPath,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        label: 'Checking staged update helper protocol',
      });
      if (stagedHelperProtocol.stdout.trim() !== updateProtocol) {
        throw new ForkRuntimeError(
          'STAGED_HELPER_INCOMPATIBLE',
          'The staged update helper does not support the active update protocol.',
        );
      }
      plannedSwaps.push({
        action: 'replace-file',
        stagedPath: stagedUpdateHelper,
        livePath: updateHelperPath,
        backupPath: `${updateHelperPath}.previous`,
        candidatePath: `${updateHelperPath}.next`,
        name: 'managed update helper',
      });
      const preparedAt = nowIso();
      await writeUpdateState({
        version: 1,
        phase: 'prepared',
        repoPath,
        branch: customBranch,
        from,
        target,
        tempRoot,
        stagingPath,
        swaps: plannedSwaps,
        startedAt: operation.startedAt,
        preparedAt,
        updatedAt: preparedAt,
        logs: operation.logs,
      });
      prepared = true;
      transitionOperation('ready', {
        changed: true,
        prepared: true,
        alreadyCurrent: false,
        completedAt: preparedAt,
      }, 'The custom update is prepared and will be applied before the next managed start.');
    } finally {
      if (!prepared) {
        await cleanupUpdate({ stagingPath, tempRoot, worktreeAdded });
      }
    }
  };

  const startUpdate = async () => {
    if (operationPromise) {
      return {
        accepted: false,
        status: 409,
        body: {
          accepted: false,
          code: 'FORK_UPDATE_IN_PROGRESS',
          error: 'A fork update operation is already in progress.',
          operation,
        },
      };
    }

    const timestamp = nowIso();
    operation = {
      phase: 'checking',
      startedAt: timestamp,
      updatedAt: timestamp,
      from: null,
      target: null,
      logs: [{ at: timestamp, phase: 'checking', message: 'Fork update accepted.' }],
    };
    const initializationClaim = getInitialization();
    operationPromise = initializationClaim;
    forkUpdateOperationActive = true;

    const releaseInitializationClaim = () => {
      if (operationPromise === initializationClaim) operationPromise = null;
      forkUpdateOperationActive = false;
    };

    let source;
    try {
      source = await initializationClaim;
      const existingState = await readUpdateState();
      if (existingState?.phase === 'prepared') {
        releaseInitializationClaim();
        await syncUpdateState();
        return {
          accepted: false,
          status: 409,
          body: {
            accepted: false,
            code: 'FORK_UPDATE_ALREADY_PREPARED',
            error: 'A prepared custom update is waiting for OpenChamber restart.',
            operation,
          },
        };
      }
      if (existingState?.phase === 'failed' && path.isAbsolute(updateStatePath)) {
        await fsPromises.rm(updateStatePath, { force: true });
      }
    } catch (error) {
      releaseInitializationClaim();
      throw error;
    }
    const capability = getStaticUpdateCapability(source);
    if (!capability.supported) {
      releaseInitializationClaim();
      operation = { phase: 'idle' };
      return {
        accepted: false,
        status: 409,
        body: {
          accepted: false,
          code: capability.reason.code,
          error: capability.reason.message,
        },
      };
    }

    const activeOperation = performUpdate();
    operationPromise = activeOperation;
    void activeOperation.catch((error) => {
      if (Array.isArray(error?.output)) {
        for (const line of error.output) appendOperationLog(operation.phase, line);
      }
      const safeError = error instanceof ForkRuntimeError
        ? errorPayload(error.code, error.message)
        : errorPayload('FORK_UPDATE_FAILED', `Fork update failed during ${operation.phase}.`);
      transitionOperation('failed', {
        error: safeError,
        completedAt: nowIso(),
      }, safeError.message);
    }).finally(() => {
      if (operationPromise === activeOperation) operationPromise = null;
      forkUpdateOperationActive = false;
    });

    return {
      accepted: true,
      status: 202,
      body: { accepted: true, operation },
    };
  };

  const registerRoutes = (app) => {
    app.get('/api/openchamber/fork/status', async (req, res) => {
      try {
        return res.json(await getStatus({ force: req.query.refresh === 'true' }));
      } catch {
        return res.status(500).json({
          error: errorPayload('FORK_STATUS_FAILED', 'Failed to read fork runtime status.'),
          operation,
        });
      }
    });

    app.post('/api/openchamber/fork/update', async (_req, res) => {
      try {
        const result = await startUpdate();
        return res.status(result.status).json(result.body);
      } catch {
        return res.status(500).json({
          accepted: false,
          code: 'FORK_UPDATE_START_FAILED',
          error: 'Failed to start the fork update operation.',
        });
      }
    });
  };

  if (managedRestartSupported) void getInitialization();

  return {
    getStatus,
    registerRoutes,
    startUpdate,
  };
};
