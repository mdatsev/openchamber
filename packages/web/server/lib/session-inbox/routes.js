export const registerSessionInboxRoutes = (app, { runtime, jsonParser }) => {
  app.get('/api/session-inbox', async (_req, res) => {
    try {
      return res.json(await runtime.getSnapshot());
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Failed to load session inbox' });
    }
  });

  app.patch('/api/session-inbox/sessions/:sessionId', jsonParser, async (req, res) => {
    try {
      return res.json(await runtime.mutate(req.params.sessionId, req.body));
    } catch (error) {
      return res.status(error instanceof TypeError ? 400 : 500).json({
        error: error?.message ?? 'Failed to update session inbox',
      });
    }
  });
};
