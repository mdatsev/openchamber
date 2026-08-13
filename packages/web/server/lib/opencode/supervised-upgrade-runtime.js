import { execFile } from 'node:child_process';

const REQUEST_TIMEOUT_MS = 15_000;
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9_.:@-]+\.service$/;
const TURN_START_PATH_PATTERN = /^\/(?:api\/)?session\/[^/]+\/(?:message|prompt|prompt_async|command|shell|summarize|init|fork|compact)\/?$/;

const createAdmissionError = () => {
  const error = new Error('OpenCode is draining for an upgrade and is not accepting new turns.');
  error.statusCode = 409;
  error.code = 'OPENCODE_UPGRADE_DRAINING';
  return error;
};

const createAbortError = () => {
  const error = new Error('OpenCode upgrade was cancelled');
  error.name = 'AbortError';
  return error;
};

export const createOpenCodeTurnAdmissionBarrier = () => {
  let closed = false;
  let activeAdmissionCount = 0;
  const drainWaiters = new Set();
  const openWaiters = new Set();

  const notifyDrained = () => {
    if (activeAdmissionCount !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  const acquire = () => {
    if (closed) throw createAdmissionError();
    activeAdmissionCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeAdmissionCount = Math.max(0, activeAdmissionCount - 1);
      notifyDrained();
    };
  };

  const waitForDrained = ({ signal, timeoutMs }) => {
    if (activeAdmissionCount === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout = null;
      const cleanup = () => {
        drainWaiters.delete(onDrained);
        signal?.removeEventListener('abort', onAbort);
        if (timeout) clearTimeout(timeout);
      };
      const onDrained = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(createAbortError());
      };
      drainWaiters.add(onDrained);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for admitted OpenCode turn requests to drain'));
      }, timeoutMs);
      timeout.unref?.();
      if (signal?.aborted) onAbort();
    });
  };

  const waitUntilOpen = async () => {
    while (closed) {
      await new Promise((resolve) => openWaiters.add(resolve));
    }
  };

  const runWhenOpen = async (callback) => {
    while (true) {
      await waitUntilOpen();
      let release;
      try {
        release = acquire();
      } catch (error) {
        if (error?.code === 'OPENCODE_UPGRADE_DRAINING') continue;
        throw error;
      }
      try {
        return await callback();
      } finally {
        release();
      }
    }
  };

  const rejectNewTurn = () => {
    if (closed) throw createAdmissionError();
  };

  const middleware = (req, res, next) => {
    if (req.method !== 'POST' || !TURN_START_PATH_PATTERN.test(req.path)) return next();

    let release;
    try {
      release = acquire();
    } catch (error) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    const finish = () => {
      res.off('finish', finish);
      res.off('close', finish);
      release();
    };
    res.once('finish', finish);
    res.once('close', finish);
    return next();
  };

  return {
    acquire,
    close: () => {
      closed = true;
    },
    open: () => {
      closed = false;
      for (const resolve of openWaiters) resolve();
      openWaiters.clear();
    },
    isClosed: () => closed,
    middleware,
    rejectNewTurn,
    runWhenOpen,
    waitForDrained,
  };
};

export const createSupervisedOpenCodeUpgradeRuntime = ({
  unitName,
  platform = process.platform,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  execFileImpl = execFile,
  waitForReady = async () => {},
  onRestartStarting = () => {},
  onRestartReady = () => {},
  onRestartFailed = () => {},
}) => {
  const normalizedUnitName = typeof unitName === 'string' ? unitName.trim() : '';
  const supported = platform === 'linux' && SYSTEMD_UNIT_PATTERN.test(normalizedUnitName);

  const fetchJson = async (pathname, signal) => {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(buildOpenCodeUrl(pathname, ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload === null) {
      throw new Error(`OpenCode activity check failed for ${pathname} (${response.status})`);
    }
    return payload;
  };

  const getActivity = async ({ signal } = {}) => {
    if (!supported) {
      throw new Error('Supervised OpenCode upgrades are not configured');
    }

    const activePayload = await fetchJson('/api/session/active', signal);
    if (!activePayload || typeof activePayload !== 'object' || Array.isArray(activePayload)) {
      throw new Error('OpenCode active-session response is invalid');
    }
    const activeData = activePayload.data;
    if (!activeData || typeof activeData !== 'object' || Array.isArray(activeData)) {
      throw new Error('OpenCode active-session response has no data map');
    }
    return { activeSessionCount: Object.keys(activeData).length };
  };

  const restart = async () => {
    if (!supported) {
      throw new Error('Supervised OpenCode upgrades are not configured');
    }

    onRestartStarting();
    try {
      await new Promise((resolve, reject) => {
        execFileImpl(
          'systemctl',
          ['--user', 'restart', normalizedUnitName],
          { windowsHide: true },
          (error, _stdout, stderr) => {
            if (!error) {
              resolve();
              return;
            }
            const detail = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : '';
            reject(new Error(`Failed to restart ${normalizedUnitName}${detail}`));
          },
        );
      });
    } catch (error) {
      onRestartFailed(error);
      throw error;
    }

    try {
      await waitForReady(30_000);
      onRestartReady();
    } catch (error) {
      onRestartFailed(error);
      throw error;
    }
  };

  return {
    supported,
    unitName: supported ? normalizedUnitName : null,
    getActivity,
    restart,
  };
};
