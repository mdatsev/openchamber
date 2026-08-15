import express from 'express';
import { createProjectIdFromPath } from '../projects/project-id.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import {
  buildDeferredRestartResponse,
} from './config-mutation-response.js';

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    supervisedOpenCodeUpgradeRuntime,
    openCodeTurnAdmissionBarrier,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    upsertProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fsPromises = fs.promises,
    execFileImpl = execFile,
    environment = process.env,
  } = dependencies;

  let authLibrary = null;
  const pendingMcpAuthContextByState = new Map();
  const PENDING_MCP_AUTH_TTL_MS = 30 * 60 * 1000;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const normalizePendingString = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
  };

  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Self-contained page for the OAuth return leg: the system browser has no UI
  // session, so it cannot load the SPA behind the auth gate — everything it
  // needs ships inline. `openchamber://focus/mcp-auth` raises the desktop app;
  // the link stays visible because some browsers only follow custom-protocol
  // URLs from a user gesture.
  const renderMcpOAuthCallbackPage = ({ title, message, desktopReturn }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenChamber</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.5; opacity: 0.85; }
  a.return { display: inline-block; margin-top: 1.5rem; padding: 0.5rem 1.25rem; border-radius: 0.5rem;
             border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); color: inherit; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${desktopReturn ? `<a class="return" href="openchamber://focus/mcp-auth">Return to OpenChamber</a>
<script>window.location.href = 'openchamber://focus/mcp-auth';</script>` : ''}
</main>
</body>
</html>`;

  const readOpenCodeCurrentVersion = async () => {
    const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    });
    const health = await healthResponse.json().catch(() => null);
    if (!healthResponse.ok) {
      return { ok: false, status: healthResponse.status, error: health?.error || healthResponse.statusText };
    }
    const currentVersion = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
    return { ok: true, currentVersion };
  };

  const parseVersionForComparison = (value) => {
    const normalized = String(value || '').replace(/^v/, '').split('+')[0];
    const prereleaseIndex = normalized.indexOf('-');
    const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { parts, prerelease: prereleaseIndex >= 0 };
  };

  const compareVersions = (left, right) => {
    const a = parseVersionForComparison(left);
    const b = parseVersionForComparison(right);
    const length = Math.max(a.parts.length, b.parts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff !== 0) return diff;
    }
    if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
    return 0;
  };

  const fetchLatestOpenCodeVersionFromGithub = async () => {
    const response = await fetch('https://api.github.com/repos/anomalyco/opencode/releases/latest', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode releases responded with ${response.status}`);
    }
    const payload = await response.json();
    const tag = typeof payload?.tag_name === 'string' ? payload.tag_name.trim() : '';
    return tag.replace(/^v/, '');
  };

  const fetchLatestOpenCodeVersionFromNpm = async () => {
    const response = await fetch('https://registry.npmjs.org/opencode-ai/latest', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode npm registry responded with ${response.status}`);
    }
    const payload = await response.json();
    return typeof payload?.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
  };

  const fetchLatestOpenCodeVersion = async () => {
    const results = await Promise.allSettled([
      fetchLatestOpenCodeVersionFromNpm(),
      fetchLatestOpenCodeVersionFromGithub(),
    ]);
    const versions = results
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value);
    if (versions.length === 0) {
      const failure = results.find((result) => result.status === 'rejected');
      throw failure?.reason instanceof Error ? failure.reason : new Error('Failed to resolve latest OpenCode version');
    }
    return versions.sort((left, right) => compareVersions(right, left))[0];
  };

  const managedOpenCodeBinary = typeof environment.OPENCHAMBER_MANAGED_OPENCODE_BINARY === 'string'
    ? environment.OPENCHAMBER_MANAGED_OPENCODE_BINARY.trim()
    : '';
  let installedVersionCache = null;
  let installedVersionPromise = null;
  let installedVersionGeneration = 0;
  const readInstalledVersionFields = async () => {
    if (!managedOpenCodeBinary) return {};
    if (installedVersionCache && Date.now() - installedVersionCache.checkedAt < 30_000) {
      return installedVersionCache.fields;
    }
    if (installedVersionPromise) return installedVersionPromise;

    const generation = installedVersionGeneration;
    const probe = new Promise((resolve) => {
      execFileImpl(managedOpenCodeBinary, ['--version'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            installedVersion: null,
            installedVersionError: 'Failed to probe the configured managed OpenCode executable.',
          });
          return;
        }
        const output = `${typeof stdout === 'string' ? stdout : ''}\n${typeof stderr === 'string' ? stderr : ''}`.trim();
        const version = output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
        resolve(version
          ? { installedVersion: version }
          : {
              installedVersion: null,
              installedVersionError: 'The configured managed OpenCode executable returned no recognizable version.',
            });
      });
    });
    installedVersionPromise = probe;
    const fields = await probe;
    if (generation === installedVersionGeneration) {
      installedVersionCache = { checkedAt: Date.now(), fields };
    }
    if (installedVersionPromise === probe) installedVersionPromise = null;
    return fields;
  };
  const clearInstalledVersionCache = () => {
    installedVersionGeneration += 1;
    installedVersionCache = null;
    installedVersionPromise = null;
  };

  const pruneExpiredPendingMcpAuthContexts = () => {
    const now = Date.now();
    for (const [state, entry] of pendingMcpAuthContextByState.entries()) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
        pendingMcpAuthContextByState.delete(state);
      }
    }
  };

  app.get('/api/config/settings', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  let openCodeUpgradePromise = null;
  let openCodeUpgradeAbortController = null;
  let openCodeUpgradeOperation = { phase: 'idle' };
  const SUPERVISED_DRAIN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

  const wait = (duration, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('OpenCode upgrade was cancelled');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      const error = new Error('OpenCode upgrade was cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    timeout.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const waitForSupervisedIdle = async (signal, kind, statusPhase = 'queued') => {
    const deadline = Date.now() + SUPERVISED_DRAIN_TIMEOUT_MS;
    await openCodeTurnAdmissionBarrier.waitForDrained({
      signal,
      timeoutMs: SUPERVISED_DRAIN_TIMEOUT_MS,
    });
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for active OpenCode turns to finish');
      }
      let activity = await supervisedOpenCodeUpgradeRuntime.getActivity({ signal });
      if (activity.activeSessionCount > 0) {
        openCodeUpgradeOperation = {
          kind,
          phase: statusPhase,
          activeSessionCount: activity.activeSessionCount,
        };
        await wait(Math.min(5_000, deadline - Date.now()), signal);
        continue;
      }

      await wait(Math.min(2_000, deadline - Date.now()), signal);
      activity = await supervisedOpenCodeUpgradeRuntime.getActivity({ signal });
      if (activity.activeSessionCount === 0) return;
      openCodeUpgradeOperation = {
        kind,
        phase: statusPhase,
        activeSessionCount: activity.activeSessionCount,
      };
    }
  };

  const performOpenCodeUpgrade = async ({ target, capability, signal }) => {
    if (capability.manager === 'systemd') {
      await waitForSupervisedIdle(signal, 'upgrade');
    }

    openCodeUpgradeOperation = { kind: 'upgrade', phase: 'upgrading' };
    const response = await fetch(buildOpenCodeUrl('/global/upgrade', ''), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify(target ? { target } : {}),
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      return {
        status: response.status,
        body: {
          success: false,
          error: payload?.error || response.statusText || 'Failed to upgrade OpenCode',
        },
      };
    }
    clearInstalledVersionCache();

    try {
      if (capability.manager === 'systemd') {
        // A direct OpenCode client can start work while the binary upgrade runs.
        // Re-establish an authoritative quiet window before restarting it.
        await waitForSupervisedIdle(signal, 'upgrade', 'upgrading');
        openCodeUpgradeOperation = { kind: 'upgrade', phase: 'restarting' };
        await supervisedOpenCodeUpgradeRuntime.restart();
      } else {
        await refreshOpenCodeAfterConfigChange('OpenCode upgrade');
      }
    } catch (restartError) {
      return {
        status: 500,
        body: {
          success: false,
          upgraded: true,
          error: restartError instanceof Error
            ? `OpenCode upgraded, but restart failed: ${restartError.message}`
            : 'OpenCode upgraded, but restart failed',
        },
      };
    }

    return {
      status: 200,
      body: { ...(payload ?? { success: true }), restarted: true },
    };
  };

  const performOpenCodeRestart = async ({ signal }) => {
    await waitForSupervisedIdle(signal, 'restart');
    openCodeUpgradeOperation = { kind: 'restart', phase: 'restarting' };
    await supervisedOpenCodeUpgradeRuntime.restart();
    clearInstalledVersionCache();
    return { status: 200, body: { success: true, restarted: true } };
  };

  const startOpenCodeOperation = ({ kind, target, capability, perform }) => {
    const abortController = new AbortController();
    openCodeUpgradeAbortController = abortController;
    const upgradeOperation = perform({
      target,
      capability,
      signal: abortController.signal,
    });
    openCodeUpgradePromise = upgradeOperation;
    void upgradeOperation.then((result) => {
      if (result.status >= 200 && result.status < 300) {
        if (capability.manager !== 'systemd') {
          openCodeUpgradeOperation = { phase: 'idle' };
          return;
        }
        openCodeUpgradeOperation = {
          kind,
          phase: 'updated',
          ...(kind === 'upgrade' ? { version: result.body?.version ?? null } : {}),
          completedAt: Date.now(),
        };
        return;
      }
      openCodeUpgradeOperation = {
        kind,
        phase: 'failed',
        error: result.body?.error ?? `OpenCode ${kind} failed`,
      };
    }).catch((error) => {
      if (error?.name === 'AbortError') {
        openCodeUpgradeOperation = { phase: 'idle' };
        return;
      }
      openCodeUpgradeOperation = {
        kind,
        phase: 'failed',
        error: error instanceof Error ? error.message : `OpenCode ${kind} failed`,
      };
    }).finally(() => {
      if (capability.manager === 'systemd') {
        openCodeTurnAdmissionBarrier.open();
      }
      if (openCodeUpgradePromise === upgradeOperation) {
        openCodeUpgradePromise = null;
        openCodeUpgradeAbortController = null;
      }
    });
    return upgradeOperation;
  };

  const startOpenCodeUpgrade = ({ target, capability }) => startOpenCodeOperation({
    kind: 'upgrade',
    target,
    capability,
    perform: performOpenCodeUpgrade,
  });

  const startOpenCodeRestart = () => startOpenCodeOperation({
    kind: 'restart',
    target: undefined,
    capability: { manager: 'systemd' },
    perform: performOpenCodeRestart,
  });

  app.post('/api/opencode/upgrade', async (req, res) => {
    try {
      const capability = getOpenCodeUpgradeCapability();
      if (!capability.supported) {
        return res.status(409).json({
          success: false,
          code: capability.reason === 'bundled'
            ? 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER'
            : 'OPENCODE_UPGRADE_UNSUPPORTED',
          error: capability.reason === 'bundled'
            ? 'OpenCode is bundled with OpenChamber Desktop and updates with the app.'
            : 'This OpenCode runtime cannot be upgraded by OpenChamber.',
        });
      }
      if (openCodeUpgradePromise) {
        return res.status(409).json({
          success: false,
          code: 'OPENCODE_UPGRADE_IN_PROGRESS',
          error: 'An OpenCode upgrade is already in progress.',
        });
      }

      if (capability.manager === 'systemd' && (
        !openCodeTurnAdmissionBarrier
        || !supervisedOpenCodeUpgradeRuntime?.supported
      )) {
        return res.status(409).json({
          success: false,
          code: 'OPENCODE_UPGRADE_UNSUPPORTED',
          error: 'Supervised OpenCode upgrades are not configured.',
        });
      }

      const target = typeof req.body?.target === 'string' && req.body.target.trim().length > 0
        ? req.body.target.trim()
        : undefined;
      if (capability.manager === 'systemd') {
        openCodeTurnAdmissionBarrier.close();
        openCodeUpgradeOperation = { kind: 'upgrade', phase: 'queued', activeSessionCount: 0 };
        startOpenCodeUpgrade({ target, capability });
        return res.status(202).json({ success: true, queued: true });
      }

      const result = await startOpenCodeUpgrade({ target, capability });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('Failed to upgrade OpenCode:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upgrade OpenCode',
      });
    }
  });

  app.post('/api/opencode/restart', (_req, res) => {
    const capability = getOpenCodeUpgradeCapability();
    if (
      !capability.supported
      || capability.manager !== 'systemd'
      || !supervisedOpenCodeUpgradeRuntime?.supported
      || !openCodeTurnAdmissionBarrier
    ) {
      return res.status(409).json({
        success: false,
        code: 'OPENCODE_RESTART_UNSUPPORTED',
        error: 'Supervised OpenCode restart is not configured.',
      });
    }
    if (openCodeUpgradePromise) {
      return res.status(409).json({
        success: false,
        code: 'OPENCODE_OPERATION_IN_PROGRESS',
        error: 'An OpenCode upgrade or restart is already in progress.',
      });
    }

    openCodeTurnAdmissionBarrier.close();
    openCodeUpgradeOperation = { kind: 'restart', phase: 'queued', activeSessionCount: 0 };
    startOpenCodeRestart();
    return res.status(202).json({ success: true, queued: true });
  });

  app.post('/api/opencode/upgrade/cancel', (_req, res) => {
    if (openCodeUpgradeOperation.phase !== 'queued' || !openCodeUpgradeAbortController) {
      return res.status(409).json({
        success: false,
        code: 'OPENCODE_UPGRADE_NOT_CANCELLABLE',
        error: 'The OpenCode operation can only be cancelled while it is waiting for active turns.',
      });
    }
    openCodeUpgradeOperation = { phase: 'idle' };
    openCodeTurnAdmissionBarrier.open();
    openCodeUpgradeAbortController.abort();
    return res.json({ success: true });
  });

  app.get('/api/opencode/upgrade-status', async (_req, res) => {
    let installedVersionFields = {};
    try {
      const capability = getOpenCodeUpgradeCapability();
      installedVersionFields = await readInstalledVersionFields();
      if (
        openCodeUpgradeOperation.phase === 'updated'
        && Date.now() - openCodeUpgradeOperation.completedAt >= 5 * 60 * 1000
      ) {
        openCodeUpgradeOperation = { phase: 'idle' };
      }
      if (['queued', 'upgrading', 'restarting', 'failed'].includes(openCodeUpgradeOperation.phase)) {
        const current = await readOpenCodeCurrentVersion().catch(() => ({ ok: false, currentVersion: null }));
        return res.json({
          available: null,
          currentVersion: current.ok ? current.currentVersion : null,
          latestVersion: null,
          upgrade: capability,
          operation: openCodeUpgradeOperation,
          ...installedVersionFields,
        });
      }
      if (!capability.supported) {
        const current = await readOpenCodeCurrentVersion().catch(() => ({ ok: false, currentVersion: null }));
        return res.json({
          available: false,
          currentVersion: current.ok ? current.currentVersion : null,
          latestVersion: null,
          upgrade: capability,
          ...installedVersionFields,
          ...(openCodeUpgradeOperation.phase === 'idle' ? {} : { operation: openCodeUpgradeOperation }),
        });
      }

      const [healthResponse, latestVersion] = await Promise.all([
        fetch(buildOpenCodeUrl('/global/health', ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        }),
        fetchLatestOpenCodeVersion(),
      ]);
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          available: null,
          error: health?.error || healthResponse.statusText || 'Failed to read OpenCode version',
          ...installedVersionFields,
        });
      }
      const currentVersion = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
      if (!currentVersion || !latestVersion) {
        return res.json({
          available: null,
          currentVersion,
          latestVersion: latestVersion || null,
          upgrade: capability,
          ...installedVersionFields,
          ...(openCodeUpgradeOperation.phase === 'idle' ? {} : { operation: openCodeUpgradeOperation }),
        });
      }
      const available = compareVersions(latestVersion, currentVersion) > 0;
      return res.json({
        available,
        currentVersion,
        latestVersion,
        upgrade: capability,
        ...installedVersionFields,
        ...(openCodeUpgradeOperation.phase === 'idle' ? {} : { operation: openCodeUpgradeOperation }),
      });
    } catch (error) {
      return res.status(500).json({
        available: null,
        error: error instanceof Error ? error.message : 'Failed to check OpenCode upgrade status',
        ...installedVersionFields,
      });
    }
  });

  app.get('/api/opencode/health', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          healthy: false,
          error: health?.error || healthResponse.statusText || 'OpenCode health check failed',
        });
      }
      return res.json({ healthy: health?.healthy === true });
    } catch (error) {
      return res.status(503).json({
        healthy: false,
        error: error instanceof Error ? error.message : 'OpenCode health check failed',
      });
    }
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          version: null,
          error: health?.error || healthResponse.statusText || 'Failed to read OpenCode version',
        });
      }
      const version = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
      return res.json({ version });
    } catch (error) {
      return res.status(500).json({
        version: null,
        error: error instanceof Error ? error.message : 'Failed to read OpenCode version',
      });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const updated = await persistSettings(req.body ?? {});
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // The body parser is per-route on this server; without it req.body is
  // undefined here, the state read as absent, and the "parked" context was
  // silently never stored — the callback then always failed as unknown.
  app.post('/api/mcp/auth/pending', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(req.body?.state);
      if (!state) {
        return res.json({ success: true, context: null });
      }

      const name = normalizePendingString(req.body?.name);
      if (!name) {
        return res.status(400).json({ error: 'MCP server name is required' });
      }

      const entry = {
        name,
        directory: normalizePendingString(req.body?.directory),
        // Which surface started the flow. It belongs here rather than in the
        // redirect URI: that URI is written into the server's config once and
        // deliberately never rewritten, so anything encoded in it would be
        // frozen at whatever runtime authorised first.
        origin: normalizePendingString(req.body?.origin),
        expiresAt: Date.now() + PENDING_MCP_AUTH_TTL_MS,
      };
      pendingMcpAuthContextByState.set(state, entry);

      return res.json({
        success: true,
        context: {
          name: entry.name,
          directory: entry.directory,
          origin: entry.origin,
        },
      });
    } catch (error) {
      console.error('Failed to store pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to store pending MCP auth context' });
    }
  });

  app.get('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json(null);
      }

      const pendingMcpAuthContext = pendingMcpAuthContextByState.get(state) ?? null;
      if (!pendingMcpAuthContext) {
        return res.status(404).json({ error: 'No pending MCP auth context' });
      }

      return res.json(pendingMcpAuthContext);
    } catch (error) {
      console.error('Failed to read pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to read pending MCP auth context' });
    }
  });

  app.delete('/api/mcp/auth/pending', async (req, res) => {
    try {
      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json({ success: true });
      }

      pendingMcpAuthContextByState.delete(state);
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to clear pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear pending MCP auth context' });
    }
  });

  // Browser return leg of the MCP OAuth flow, completed entirely server-side.
  //
  // The provider redirects the SYSTEM browser here, and that browser has no
  // OpenChamber UI session — the SPA route this path used to land on sits
  // behind the client-side auth gate, so the user saw a login page instead of
  // a finished authorization. No session can be required on this path.
  //
  // Safe without auth because it acts only on a code+state pair whose `state`
  // matches a context parked by an authenticated start call: `state` is the
  // OAuth CSRF secret, generated per flow and known only to the initiating
  // client and the provider. Without a match the code is NOT forwarded, so an
  // unauthenticated caller cannot bind this server's MCP entry to a foreign
  // account by fabricating a callback. The endpoint reads nothing and mutates
  // nothing else.
  app.get('/mcp/oauth/callback', async (req, res) => {
    const queryValue = (key) => normalizePendingString(Array.isArray(req.query?.[key]) ? req.query[key][0] : req.query?.[key]);
    const state = queryValue('state');
    const code = queryValue('code');
    const providerError = queryValue('error');
    const providerErrorDescription = queryValue('error_description');

    pruneExpiredPendingMcpAuthContexts();
    const context = state ? pendingMcpAuthContextByState.get(state) ?? null : null;
    const startedFromDesktop = context?.origin === 'desktop';

    const finish = (status, { title, message }) => {
      if (state) pendingMcpAuthContextByState.delete(state);
      res.status(status).type('html').send(renderMcpOAuthCallbackPage({
        title,
        message,
        // Browsers only follow custom-protocol links from a user gesture in
        // some configurations, so the page both tries the jump and keeps a
        // visible link as the fallback.
        desktopReturn: startedFromDesktop,
      }));
    };

    if (providerError) {
      return finish(400, {
        title: 'Authorization Failed',
        message: providerErrorDescription || providerError,
      });
    }
    if (!code) {
      return finish(400, {
        title: 'Authorization Failed',
        message: 'The provider did not return an authorization code. Start authorization again from MCP Settings.',
      });
    }
    if (!context?.name) {
      return finish(400, {
        title: 'Authorization Failed',
        message: 'This authorization session has expired or is unknown to the running app. Return to OpenChamber and click Authorize again.',
      });
    }

    try {
      const callbackUrl = new URL(buildOpenCodeUrl(`/mcp/${encodeURIComponent(context.name)}/auth/callback`, ''));
      if (context.directory) callbackUrl.searchParams.set('directory', context.directory);
      const upstream = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (!upstream.ok) {
        const payload = await upstream.json().catch(() => null);
        return finish(502, {
          title: 'Authorization Failed',
          message: payload?.error || payload?.message || `OpenCode rejected the authorization code (${upstream.status}). Start authorization again from MCP Settings.`,
        });
      }
      return finish(200, {
        title: 'Authorization Complete',
        message: 'You can close this tab and return to OpenChamber.',
      });
    } catch (error) {
      return finish(502, {
        title: 'Authorization Failed',
        message: error?.message || 'Failed to complete MCP authorization.',
      });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = Boolean(auth);

      return res.json({
        providerId,
        sources: sources.sources,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.put('/api/provider', async (req, res) => {
    try {
      const providerID = typeof req.body?.providerID === 'string'
        ? req.body.providerID.trim()
        : (typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '');
      const config = req.body?.config;
      const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'user';

      if (!providerID) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({ error: 'Provider config is required' });
      }
      if (scope !== 'user' && scope !== 'project' && scope !== 'custom') {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error || 'Working directory is required' });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      const { getProviderAuth } = await getAuthLibrary();
      const hasStoredAuth = Boolean(getProviderAuth(providerID));
      const upsertResult = upsertProviderConfig(providerID, config, directory, scope, { hasStoredAuth });

      return res.json({
        ...buildDeferredRestartResponse(
          `Provider ${providerID} saved. Restart OpenCode to apply.`,
        ),
        providerId: upsertResult.providerId,
        path: upsertResult.path,
        config: upsertResult.config,
      });
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      console.error('Failed to upsert provider config:', error);
      return res.status(status).json({ error: error.message || 'Failed to save provider config' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        const { removeProviderAuth } = await getAuthLibrary();
        removed = removeProviderAuth(providerId);
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const { removeProviderAuth } = await getAuthLibrary();
        const authRemoved = removeProviderAuth(providerId);
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = authRemoved || userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        return res.json({
          success: true,
          removed,
          ...buildDeferredRestartResponse('Provider disconnected successfully. Restart OpenCode to apply.'),
        });
      }

      return res.json({
        success: true,
        removed,
        requiresReload: false,
        message: 'Provider was not connected',
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      if (req.body?.create === true) {
        await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        await fs.promises.access(AGENTS_MD_PATH);
      } catch {
        return res.json({ content: '', exists: false });
      }
      const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
      return res.json({ content, exists: true });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      return res.json(buildDeferredRestartResponse(
        'AGENTS.md saved. Restart OpenCode to apply.',
      ));
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
