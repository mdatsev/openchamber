import { PrimeServiceError } from './errors.js';

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_DRAIN_TIMEOUT_MS = 5_000;

const sendError = (res, error) => {
  res.setHeader('Cache-Control', 'no-store');
  let known = error instanceof PrimeServiceError ? error : null;
  if (!known && error?.type === 'entity.too.large') {
    known = new PrimeServiceError(413, 'prime_request_too_large', 'Prime request body is too large');
  } else if (!known && error?.status && error.status >= 400 && error.status < 500) {
    known = new PrimeServiceError(400, 'prime_invalid_request', 'Invalid Prime request body');
  }
  return res.status(known ? known.statusCode : 500).json({
    schemaVersion: 1,
    error: {
      code: known ? known.code : 'prime_internal_error',
      message: known ? known.message : 'Prime request failed',
    },
  });
};

const asyncRoute = (handler) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return await handler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
};

const writeSseEvent = (res, eventName, payload) => res.write(
  `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
);

export const registerPrimeRoutes = (app, { primeService, isRequestOriginAllowed, jsonParser }) => {
  const statusPath = '/api/prime/status';
  const catalogPath = '/api/prime/catalog';
  const createPath = '/api/prime/sessions';
  const transcriptPath = '/api/prime/sessions/:sessionId/transcript';
  const contextPath = '/api/prime/sessions/:sessionId/context';
  const activatePath = '/api/prime/sessions/:sessionId/activate';
  const deactivatePath = '/api/prime/sessions/:sessionId/deactivate';
  const snapshotPath = '/api/prime/sessions/:sessionId/snapshot';
  const eventsPath = '/api/prime/sessions/:sessionId/events';
  const promptPath = '/api/prime/sessions/:sessionId/prompt';
  const abortPath = '/api/prime/sessions/:sessionId/abort';
  const modelPath = '/api/prime/sessions/:sessionId/model';
  const thinkingPath = '/api/prime/sessions/:sessionId/thinking-level';

  app.get(statusPath, asyncRoute(async (_req, res) => res.json(await primeService.getStatus())));
  app.get(catalogPath, asyncRoute(async (_req, res) => res.json(await primeService.getCatalog())));
  app.get(transcriptPath, asyncRoute(async (req, res) => res.json(await primeService.getTranscript(
    req.params.sessionId,
    {
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      byteLimit: req.query?.byteLimit,
    },
  ))));
  app.get(contextPath, asyncRoute(async (req, res) => res.json(
    await primeService.getContext(req.params.sessionId),
  )));

  const requireMutationOrigin = async (req) => {
    if (typeof isRequestOriginAllowed !== 'function' || !await isRequestOriginAllowed(req)) {
      throw new PrimeServiceError(403, 'prime_origin_not_allowed', 'Request origin is not allowed');
    }
  };
  app.post(activatePath, asyncRoute(async (req, res) => {
    await requireMutationOrigin(req);
    return res.json(await primeService.activate(req.params.sessionId));
  }));
  app.post(deactivatePath, asyncRoute(async (req, res) => {
    await requireMutationOrigin(req);
    return res.json(await primeService.deactivate(req.params.sessionId));
  }));
  const boundedJson = jsonParser || ((_req, _res, next) => next());
  const parseMutationJson = (req, res, next) => boundedJson(req, res, (error) => {
    if (!error) return next();
    return sendError(res, error?.type === 'entity.too.large'
      ? new PrimeServiceError(413, 'prime_request_too_large', 'Prime request body is too large')
      : new PrimeServiceError(400, 'prime_invalid_request', 'Invalid Prime request body'));
  });
  app.post(createPath, parseMutationJson, asyncRoute(async (req, res) => {
    await requireMutationOrigin(req);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new PrimeServiceError(400, 'prime_invalid_request', 'Invalid Prime request body');
    }
    return res.json(await primeService.createRoot(req.body));
  }));
  const registerMutation = (routePath, mutate) => app.post(
    routePath,
    parseMutationJson,
    asyncRoute(async (req, res) => {
      await requireMutationOrigin(req);
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new PrimeServiceError(400, 'prime_invalid_request', 'Invalid Prime request body');
      }
      return res.json(await mutate(req.params.sessionId, req.body));
    }),
  );
  registerMutation(promptPath, primeService.prompt);
  registerMutation(abortPath, primeService.abort);
  registerMutation(modelPath, primeService.setModel);
  registerMutation(thinkingPath, primeService.setThinkingLevel);
  app.get(snapshotPath, asyncRoute(async (req, res) => res.json(
    primeService.getLiveSnapshot(req.params.sessionId),
  )));
  app.get(eventsPath, asyncRoute(async (req, res) => {
    let closed = false;
    let backpressured = false;
    let resyncPending = false;
    let closePending = null;
    let unsubscribe = () => {};
    let heartbeat = null;
    let drainTimeout = null;
    let onDrain = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (drainTimeout) clearTimeout(drainTimeout);
      if (onDrain) res.off('drain', onDrain);
      unsubscribe();
    };
    const closeStream = () => {
      cleanup();
      res.end();
    };
    const writeBounded = (write) => {
      if (closed || backpressured) return false;
      try {
        if (write()) return true;
      } catch {
        closeStream();
        return false;
      }
      backpressured = true;
      onDrain = () => {
        if (drainTimeout) clearTimeout(drainTimeout);
        drainTimeout = null;
        onDrain = null;
        backpressured = false;
        if (closePending) {
          const event = closePending;
          closePending = null;
          if (writeBounded(() => writeSseEvent(res, 'closed', event))) closeStream();
          return;
        }
        if (!resyncPending) return;
        resyncPending = false;
        try {
          const snapshot = primeService.getLiveSnapshot(req.params.sessionId);
          writeBounded(() => writeSseEvent(res, 'snapshot', { type: 'snapshot', snapshot }));
        } catch {
          closeStream();
        }
      };
      res.once('drain', onDrain);
      drainTimeout = setTimeout(closeStream, SSE_DRAIN_TIMEOUT_MS);
      drainTimeout.unref?.();
      return true;
    };
    const subscription = primeService.openEventSubscription(req.params.sessionId, (event) => {
      if (event.type === 'closed') {
        if (backpressured) {
          closePending = event;
          return;
        }
        if (writeBounded(() => writeSseEvent(res, 'closed', event))) closeStream();
        return;
      }
      if (backpressured) {
        resyncPending = true;
        return;
      }
      writeBounded(() => writeSseEvent(res, event.type, event));
    });
    unsubscribe = subscription.unsubscribe;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (!writeBounded(() => writeSseEvent(
      res,
      'snapshot',
      { type: 'snapshot', snapshot: subscription.initial },
    ))) return;
    heartbeat = setInterval(
      () => writeBounded(() => res.write(`: heartbeat${String.fromCharCode(10, 10)}`)),
      SSE_HEARTBEAT_INTERVAL_MS,
    );
    heartbeat.unref?.();
    req.once('close', cleanup);
    res.once('close', cleanup);
  }));

  const methodNotAllowed = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({
      schemaVersion: 1,
      error: { code: 'prime_method_not_allowed', message: 'Method not allowed' },
    });
  };
  app.all(statusPath, methodNotAllowed);
  app.all(catalogPath, methodNotAllowed);
  app.all(createPath, methodNotAllowed);
  app.all(transcriptPath, methodNotAllowed);
  app.all(contextPath, methodNotAllowed);
  app.all(activatePath, methodNotAllowed);
  app.all(deactivatePath, methodNotAllowed);
  app.all(snapshotPath, methodNotAllowed);
  app.all(eventsPath, methodNotAllowed);
  app.all(promptPath, methodNotAllowed);
  app.all(abortPath, methodNotAllowed);
  app.all(modelPath, methodNotAllowed);
  app.all(thinkingPath, methodNotAllowed);

  // This terminator must remain after every explicit Prime route and before the
  // generic OpenCode /api proxy so Prime typos never fall through upstream.
  app.use('/api/prime', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({
      schemaVersion: 1,
      error: { code: 'prime_route_not_found', message: 'Prime route not found' },
    });
  });
};
