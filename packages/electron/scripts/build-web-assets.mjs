import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const electronDir = path.join(repoRoot, 'packages', 'electron');

const resourcesDir = path.join(electronDir, 'resources');
const resourcesWebDistDir = path.join(resourcesDir, 'web-dist');
const webDistDir = path.join(webDir, 'dist');
const cacheFile = path.join(electronDir, '.cache', 'web-assets.json');
const useCache = process.argv.includes('--cache');
const CACHE_VERSION = 1;

const buildInputs = [
  path.join(repoRoot, 'bun.lock'),
  path.join(repoRoot, 'package.json'),
  path.join(repoRoot, 'postcss.config.js'),
  path.join(repoRoot, 'vite-theme-plugin.ts'),
  path.join(repoRoot, 'packages', 'ui', 'package.json'),
  path.join(repoRoot, 'packages', 'ui', 'src'),
  path.join(electronDir, 'scripts', 'build-web-assets.mjs'),
  path.join(webDir, 'index.html'),
  path.join(webDir, 'mini-chat.html'),
  path.join(webDir, 'mobile.html'),
  path.join(webDir, 'package.json'),
  path.join(webDir, 'public'),
  path.join(webDir, 'src'),
  path.join(webDir, 'vite.config.ts'),
];

const quoteWindowsCommandArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

const run = (cmd, args, cwd) => {
  const isWindowsCommandScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const result = isWindowsCommandScript
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', ['call', quoteWindowsCommandArg(cmd), ...args.map(quoteWindowsCommandArg)].join(' ')],
        { cwd, stdio: 'inherit', windowsVerbatimArguments: true },
      )
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
};

const resolveBun = () => {
  if (typeof process.env.BUN === 'string' && process.env.BUN.trim()) {
    return process.env.BUN.trim();
  }
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['bun'], { encoding: 'utf8' });
    const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const resolved = candidates.find((entry) => /\.(exe|cmd|bat)$/i.test(entry)) || candidates[0];
    return resolved || 'bun';
  }
  const result = spawnSync('/bin/bash', ['-lc', 'command -v bun'], { encoding: 'utf8' });
  const resolved = (result.stdout || '').trim();
  return resolved || 'bun';
};

const relativePath = (target) => path.relative(repoRoot, target).split(path.sep).join('/');

const hashPath = async (hash, target) => {
  const stat = await fs.lstat(target);
  const relative = relativePath(target);
  if (stat.isDirectory()) {
    hash.update(`directory:${relative}\0`);
    const entries = (await fs.readdir(target)).sort();
    for (const entry of entries) {
      await hashPath(hash, path.join(target, entry));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relative}:${await fs.readlink(target)}\0`);
    return;
  }
  hash.update(`file:${relative}:${stat.size}\0`);
  hash.update(await fs.readFile(target));
};

const getBuildHash = async (bunExe) => {
  const hash = createHash('sha256');
  hash.update(`cache-version:${CACHE_VERSION}\0`);
  hash.update(`platform:${process.platform}:${process.arch}\0`);
  hash.update(`node:${process.version}\0`);
  const bunVersion = spawnSync(bunExe, ['--version'], { encoding: 'utf8' });
  if (bunVersion.error) throw bunVersion.error;
  if (bunVersion.status !== 0) throw new Error(`Failed to read Bun version from ${bunExe}`);
  hash.update(`bun:${String(bunVersion.stdout).trim()}\0`);

  const buildEnvironment = Object.entries(process.env)
    .filter(([key]) => key === 'NODE_ENV' || key === 'OPENCHAMBER_DISABLE_PWA_DEV' || key.startsWith('VITE_'))
    .sort(([left], [right]) => left.localeCompare(right));
  hash.update(`environment:${JSON.stringify(buildEnvironment)}\0`);

  for (const input of buildInputs) {
    await hashPath(hash, input);
  }
  return hash.digest('hex');
};

const getOutputManifest = async (root, directory = root) => {
  const output = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await getOutputManifest(root, target));
      continue;
    }
    const stat = await fs.stat(target);
    output.push({ path: path.relative(root, target).split(path.sep).join('/'), size: stat.size });
  }
  return output;
};

const hasValidCachedOutput = async (buildHash) => {
  try {
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cache.version !== CACHE_VERSION || cache.buildHash !== buildHash || !Array.isArray(cache.output)) {
      return false;
    }
    for (const entry of cache.output) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.size !== 'number') return false;
      if (!entry.path || path.isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').includes('..')) return false;
      const stat = await fs.stat(path.join(resourcesWebDistDir, entry.path));
      if (!stat.isFile() || stat.size !== entry.size) return false;
    }
    return cache.output.length > 0;
  } catch {
    return false;
  }
};

const writeCache = async (buildHash) => {
  const cacheDir = path.dirname(cacheFile);
  await fs.mkdir(cacheDir, { recursive: true });
  const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
  const cache = {
    version: CACHE_VERSION,
    buildHash,
    output: await getOutputManifest(resourcesWebDistDir),
  };
  await fs.writeFile(temporaryFile, `${JSON.stringify(cache)}\n`);
  await fs.rename(temporaryFile, cacheFile);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const removeDir = async (target) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
};

const copyDir = async (src, dst) => {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
};

const bunExe = resolveBun();
const buildHash = useCache ? await getBuildHash(bunExe) : null;

if (buildHash && await hasValidCachedOutput(buildHash)) {
  console.log('[electron] bundled web assets unchanged; reusing cached build.');
  process.exit(0);
}

console.log('[electron] building web UI dist...');
run(bunExe, ['run', 'build'], webDir);

console.log('[electron] staging packaged resources...');
await fs.mkdir(resourcesDir, { recursive: true });
const stagedWebDistDir = await fs.mkdtemp(path.join(resourcesDir, 'web-dist-staging-'));
await copyDir(webDistDir, stagedWebDistDir);
await removeDir(resourcesWebDistDir);
await fs.rename(stagedWebDistDir, resourcesWebDistDir);

if (buildHash) {
  await writeCache(buildHash);
}

console.log(`[electron] web assets ready: ${resourcesWebDistDir}`);
