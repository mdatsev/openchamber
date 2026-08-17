#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const configuredRepoPath = process.env.OPENCHAMBER_CUSTOM_FORK_REPO || '';
const configuredStatePath = process.env.OPENCHAMBER_CUSTOM_FORK_UPDATE_STATE || '';
const configuredHelperPath = process.env.OPENCHAMBER_CUSTOM_FORK_UPDATE_HELPER || '';
const repoPath = configuredRepoPath ? path.resolve(configuredRepoPath) : '';
const branch = process.env.OPENCHAMBER_CUSTOM_FORK_BRANCH || 'custom';
const statePath = configuredStatePath ? path.resolve(configuredStatePath) : '';
const helperPath = configuredHelperPath ? path.resolve(configuredHelperPath) : '';
const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const syncDirectory = async (directoryPath) => {
  let handle;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Some platforms do not support syncing directory handles.
  } finally {
    await handle?.close().catch(() => {});
  }
};

const syncParentDirectories = async (...filePaths) => {
  const directories = new Set(filePaths.filter(Boolean).map((filePath) => path.dirname(filePath)));
  for (const directory of directories) await syncDirectory(directory);
};

const pathExists = async (filePath) => {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const runGit = (args, { allowFailure = false } = {}) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repoPath, ...args], {
    env: gitEnvironment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error && !allowFailure) {
      reject(new Error('Git could not apply the prepared custom update.'));
      return;
    }
    resolve({
      ok: !error,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
    });
  });
});

const writeState = async (state) => {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const handle = await fs.open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, statePath);
  await syncDirectory(path.dirname(statePath));
};

const isWithin = (parentPath, candidatePath) => {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const validateState = (state) => {
  if (
    state?.version !== 1
    || !['prepared', 'applying-source', 'applying-directories', 'failed'].includes(state.phase)
    || state.repoPath !== repoPath
    || state.branch !== branch
    || !/^[0-9a-f]{40,64}$/i.test(state.from)
    || !/^[0-9a-f]{40,64}$/i.test(state.target)
    || typeof state.tempRoot !== 'string'
    || typeof state.stagingPath !== 'string'
    || !Array.isArray(state.swaps)
  ) {
    throw new Error('Prepared custom update state is invalid.');
  }
  const expectedTempPrefix = `${path.dirname(repoPath)}${path.sep}.openchamber-update-`;
  if (
    !state.tempRoot.startsWith(expectedTempPrefix)
    || state.stagingPath !== path.join(state.tempRoot, 'checkout')
  ) {
    throw new Error('Prepared custom update paths are invalid.');
  }
  const rootNodeModules = path.join(repoPath, 'node_modules');
  const webDist = path.join(repoPath, 'packages', 'web', 'dist');
  for (const swap of state.swaps) {
    const action = swap.action;
    const livePath = typeof swap?.livePath === 'string' ? path.resolve(swap.livePath) : '';
    const stagedPath = typeof swap?.stagedPath === 'string' ? path.resolve(swap.stagedPath) : null;
    const backupPath = typeof swap?.backupPath === 'string' ? path.resolve(swap.backupPath) : '';
    const candidatePath = typeof swap?.candidatePath === 'string' ? path.resolve(swap.candidatePath) : null;
    const relativeLivePath = path.relative(path.join(repoPath, 'packages'), livePath);
    const packageNodeModules = !relativeLivePath.startsWith('..')
      && relativeLivePath.split(path.sep).length === 2
      && relativeLivePath.endsWith(`${path.sep}node_modules`);
    const supportedAction = ['replace', 'remove', 'replace-file'].includes(action);
    const allowedLivePath = livePath === rootNodeModules
      || livePath === webDist
      || livePath === helperPath
      || packageNodeModules;
    let validStagedPath;
    if (action === 'remove') {
      validStagedPath = stagedPath === null;
    } else {
      validStagedPath = Boolean(stagedPath && isWithin(state.stagingPath, stagedPath));
    }
    let validRecoveryPaths;
    if (action === 'replace-file') {
      validRecoveryPaths = livePath === helperPath
        && backupPath === `${helperPath}.previous`
        && candidatePath === `${helperPath}.next`;
    } else {
      validRecoveryPaths = isWithin(path.join(state.tempRoot, 'backups'), backupPath)
        && candidatePath === null;
    }
    if (
      !supportedAction
      || !allowedLivePath
      || !validStagedPath
      || !validRecoveryPaths
      || typeof swap.name !== 'string'
    ) {
      throw new Error('A prepared custom update directory is invalid.');
    }
  }
  return state;
};

const readHead = async () => (await runGit(['rev-parse', 'HEAD'])).stdout.trim();
const readBranch = async () => (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
const readDirty = async () => (await runGit(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.length > 0;

const cleanupStaging = async (state) => {
  await runGit(['worktree', 'remove', '--force', state.stagingPath], { allowFailure: true });
  await runGit(['worktree', 'prune'], { allowFailure: true });
  await fs.rm(state.tempRoot, { recursive: true, force: true });
  await syncDirectory(path.dirname(state.tempRoot));
};

const recordSafeFailure = async (state, message) => {
  const timestamp = new Date().toISOString();
  const failedState = {
    ...state,
    phase: 'failed',
    safeToStart: true,
    updatedAt: timestamp,
    error: { code: 'FORK_UPDATE_APPLY_FAILED', message },
    logs: [
      ...(Array.isArray(state.logs) ? state.logs : []),
      { at: timestamp, phase: 'failed', message },
    ].slice(-32),
  };
  await writeState(failedState);
  await cleanupStaging(failedState);
};

const validateWebDist = async (distPath) => {
  const assetsPath = path.join(distPath, 'assets');
  const assets = await fs.readdir(assetsPath);
  if (assets.length === 0) throw new Error('Prepared web assets are empty.');
  const htmlFiles = (await fs.readdir(distPath)).filter((name) => name.endsWith('.html'));
  if (!htmlFiles.includes('index.html')) throw new Error('Prepared web index is missing.');
  for (const htmlFile of htmlFiles) {
    const html = await fs.readFile(path.join(distPath, htmlFile), 'utf8');
    for (const reference of html.matchAll(/(?:src|href)=["'](?:\.?\/)?assets\/([^"'?]+)[^"']*["']/g)) {
      if (!await pathExists(path.join(assetsPath, reference[1]))) {
        throw new Error(`Prepared web asset referenced by ${htmlFile} is missing.`);
      }
    }
  }
};

const ensureTarget = async (swap, { active, completed }) => {
  if (swap.action === 'remove') {
    const liveExists = await pathExists(swap.livePath);
    const backupExists = await pathExists(swap.backupPath);
    if (completed) {
      if (liveExists) throw new Error(`Removed ${swap.name} unexpectedly exists.`);
      return;
    }
    if (!active) throw new Error(`Removal state for ${swap.name} is incomplete.`);
    await fs.mkdir(path.dirname(swap.backupPath), { recursive: true });
    if (liveExists && !backupExists) {
      await fs.rename(swap.livePath, swap.backupPath);
      await syncParentDirectories(swap.livePath, swap.backupPath);
    }
    if (await pathExists(swap.livePath)) throw new Error(`Could not remove ${swap.name}.`);
    return;
  }

  if (swap.action === 'replace-file') {
    const liveExists = await pathExists(swap.livePath);
    const stagedExists = await pathExists(swap.stagedPath);
    const backupExists = await pathExists(swap.backupPath);
    const candidateExists = await pathExists(swap.candidatePath);
    if (!active && !completed) throw new Error(`Replacement state for ${swap.name} is incomplete.`);
    if (completed) {
      if (!liveExists) throw new Error(`Applied ${swap.name} is missing.`);
      return;
    }
    if (!candidateExists && stagedExists) {
      await fs.mkdir(path.dirname(swap.candidatePath), { recursive: true });
      const temporaryCandidate = `${swap.candidatePath}.${process.pid}.tmp`;
      await fs.copyFile(swap.stagedPath, temporaryCandidate);
      const candidateHandle = await fs.open(temporaryCandidate, 'r');
      try {
        await candidateHandle.sync();
      } finally {
        await candidateHandle.close();
      }
      await fs.rename(temporaryCandidate, swap.candidatePath);
      await syncDirectory(path.dirname(swap.candidatePath));
    }
    if (await pathExists(swap.candidatePath)) {
      if (liveExists && !backupExists) {
        await fs.rename(swap.livePath, swap.backupPath);
        await syncParentDirectories(swap.livePath, swap.backupPath);
      }
      await fs.rename(swap.candidatePath, swap.livePath);
      await syncParentDirectories(swap.candidatePath, swap.livePath);
      return;
    }
    if (!stagedExists && liveExists && backupExists) return;
    throw new Error(`Prepared ${swap.name} is missing.`);
  }

  const stagedExists = await pathExists(swap.stagedPath);
  const liveExists = await pathExists(swap.livePath);
  const backupExists = await pathExists(swap.backupPath);
  if (!stagedExists) {
    if (!liveExists || (!active && !completed)) throw new Error(`Prepared ${swap.name} is missing.`);
    return;
  }
  if (!active && !completed) throw new Error(`Replacement state for ${swap.name} is incomplete.`);
  if (liveExists && backupExists) {
    throw new Error(`Prepared ${swap.name} has ambiguous recovery state.`);
  }
  await fs.mkdir(path.dirname(swap.livePath), { recursive: true });
  await fs.mkdir(path.dirname(swap.backupPath), { recursive: true });
  if (liveExists) {
    await fs.rename(swap.livePath, swap.backupPath);
    await syncParentDirectories(swap.livePath, swap.backupPath);
  }
  await fs.rename(swap.stagedPath, swap.livePath);
  await syncParentDirectories(swap.stagedPath, swap.livePath);
};

const main = async () => {
  if (process.argv[2] === '--protocol') {
    process.stdout.write('1\n');
    return;
  }
  if (process.argv[2] === '--validate-dist') {
    if (!repoPath) throw new Error('Custom OpenChamber repository is not configured.');
    await validateWebDist(path.join(repoPath, 'packages', 'web', 'dist'));
    return;
  }
  if (!repoPath || !statePath || !await pathExists(statePath)) return;
  let state = validateState(JSON.parse(await fs.readFile(statePath, 'utf8')));
  if (state.phase === 'failed') {
    if (state.safeToStart === true) {
      await cleanupStaging(state).catch(() => {});
      return;
    }
    throw new Error(state.error?.message || 'Prepared custom update requires manual recovery.');
  }

  let head = await readHead();
  if (head !== state.from && head !== state.target) {
    throw new Error('Checkout HEAD changed after the custom update was prepared.');
  }
  if (await readBranch() !== branch) {
    throw new Error('The custom checkout branch changed after the update was prepared.');
  }

  if (head === state.from) {
    if (await readDirty()) {
      if (state.phase === 'prepared') {
        await recordSafeFailure(state, 'The live checkout changed after the update was prepared.');
        return;
      }
      throw new Error('The custom checkout became dirty during update recovery.');
    }
    state = { ...state, phase: 'applying-source', updatedAt: new Date().toISOString() };
    await writeState(state);
    const merge = await runGit(['merge', '--ff-only', '--no-edit', state.target], { allowFailure: true });
    head = await readHead();
    if (!merge.ok && head !== state.target) {
      if (await readDirty()) {
        throw new Error('The source fast-forward failed with tracked checkout changes.');
      }
      await recordSafeFailure(state, 'The prepared source revision could not be fast-forwarded.');
      return;
    }
  }

  if (await readHead() !== state.target) throw new Error('Prepared source revision was not applied.');
  if (await readDirty()) throw new Error('The target checkout has unexpected tracked changes.');
  state = {
    ...state,
    phase: 'applying-directories',
    activeSwap: Number.isInteger(state.activeSwap) ? state.activeSwap : null,
    completedSwaps: Array.isArray(state.completedSwaps) ? state.completedSwaps : [],
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);
  for (let index = 0; index < state.swaps.length; index += 1) {
    const completed = state.completedSwaps.includes(index);
    if (!completed && state.activeSwap !== index) {
      state = { ...state, activeSwap: index, updatedAt: new Date().toISOString() };
      await writeState(state);
    }
    await ensureTarget(state.swaps[index], {
      active: state.activeSwap === index,
      completed,
    });
    if (!completed) {
      state = {
        ...state,
        activeSwap: null,
        completedSwaps: [...state.completedSwaps, index],
        updatedAt: new Date().toISOString(),
      };
      await writeState(state);
    }
  }

  const liveDist = path.join(repoPath, 'packages', 'web', 'dist');
  await validateWebDist(liveDist);
  if (!await pathExists(path.join(repoPath, 'node_modules'))) {
    throw new Error('Applied root dependencies are missing.');
  }
  if (await readHead() !== state.target || await readDirty()) {
    throw new Error('Applied custom checkout did not verify cleanly.');
  }

  for (const swap of state.swaps) {
    await fs.rm(swap.backupPath, { recursive: true, force: true });
    await syncDirectory(path.dirname(swap.backupPath));
  }
  await cleanupStaging(state);
  await fs.rm(statePath, { force: true });
  await syncDirectory(path.dirname(statePath));
  process.stdout.write(`Applied custom OpenChamber update ${state.target.slice(0, 12)}.\n`);
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Prepared custom update failed.'}\n`);
  process.exitCode = 1;
}
