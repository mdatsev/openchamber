import { z } from 'zod';
import type { PrimeAPI, PrimeEvent, PrimeSessionIdentity, PrimeSessionSummary } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { subscribeOpenchamberEvents } from '@openchamber/ui/lib/openchamberEvents';
import { getRuntimeKey } from '@openchamber/ui/lib/runtime-switch';

const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  directory: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activity: z.enum(['working', 'idle']).default('idle'),
  interactive: z.boolean().default(false),
  parentID: z.string().nullable(),
  depth: z.number().int().nonnegative(),
});

const sessionsResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    sessions: z.array(sessionSummarySchema),
    skippedFileCount: z.number().int().nonnegative(),
    failedSessionIDs: z.tuple([]),
  }),
  z.object({
    status: z.literal('partial'),
    sessions: z.array(sessionSummarySchema),
    skippedFileCount: z.number().int().positive(),
    failedSessionIDs: z.array(z.string()),
  }),
  z.object({
    status: z.literal('not-configured'),
    sessions: z.tuple([]),
    skippedFileCount: z.number().int().nonnegative(),
    failedSessionIDs: z.tuple([]),
  }),
]);

const transcriptSchema = z.object({
  session: sessionSummarySchema,
  sourceVersion: z.number().int().positive(),
  totalEntryCount: z.number().int().nonnegative(),
  branchEntryCount: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string(),
    branchEntryID: z.string().nullable(),
    role: z.enum(['user', 'assistant', 'reasoning', 'tool', 'system']),
    text: z.string(),
    timestamp: z.string().nullable(),
    label: z.string().nullable(),
    isError: z.boolean(),
    providerID: z.string().nullable(),
    modelID: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    usage: z.object({
      inputTokens: z.number().nonnegative().nullable(),
      outputTokens: z.number().nonnegative().nullable(),
      cacheReadTokens: z.number().nonnegative().nullable(),
      cacheWriteTokens: z.number().nonnegative().nullable(),
      totalTokens: z.number().nonnegative(),
      cost: z.number().nonnegative().nullable(),
    }).nullable(),
    stopReason: z.string().nullable(),
    streaming: z.boolean(),
    toolCallID: z.string().nullable(),
    toolInput: z.string().nullable(),
    toolOutput: z.string().nullable(),
    toolStatus: z.enum(['pending', 'running', 'completed', 'error']).nullable(),
  })),
});

const runtimeStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['starting', 'ready', 'not-configured', 'unavailable', 'incompatible', 'unsupported']),
  interactive: z.boolean(),
  authentication: z.enum(['authenticated', 'unauthenticated', 'unknown']).default('unknown'),
  binarySource: z.enum(['settings', 'environment', 'path']).nullable(),
  version: z.string().nullable(),
  message: z.string().nullable(),
});

const createSessionSchema = z.object({
  schemaVersion: z.literal(1),
  session: sessionSummarySchema,
});

const acceptedSchema = z.object({
  schemaVersion: z.literal(1),
  accepted: z.literal(true),
});

const branchSessionSchema = z.object({
  schemaVersion: z.literal(1),
  session: sessionSummarySchema,
  selectedText: z.string().nullable(),
  cancelled: z.boolean(),
});

const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  reasoning: z.boolean(),
  contextWindow: z.number().nonnegative().nullable(),
  maxTokens: z.number().nonnegative().nullable(),
});

const sessionControlsSchema = z.object({
  schemaVersion: z.literal(1),
  model: modelSchema.nullable(),
  thinkingLevel: thinkingLevelSchema,
  availableThinkingLevels: z.array(thinkingLevelSchema),
  models: z.array(modelSchema),
  commands: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    argumentHint: z.string().nullable(),
    source: z.enum(['extension', 'prompt', 'skill']),
  })),
});

const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  ambiguous: z.boolean().optional(),
  session: sessionSummarySchema.optional(),
});

type RawPrimeSessionSummary = z.infer<typeof sessionSummarySchema>;

const withIdentity = (session: RawPrimeSessionSummary, runtimeKey: string): PrimeSessionSummary => ({
  ...session,
  identity: { runtimeKey, harness: 'prime', sessionID: session.id },
});

const assertCurrentRuntime = (runtimeKey: string) => {
  if (getRuntimeKey() === runtimeKey) return;
  throw Object.assign(new Error('Prime Agent request belongs to a different runtime'), { code: 'stale-runtime' });
};

const assertIdentityOwner = (identity: PrimeSessionIdentity) => {
  if (identity.harness !== 'prime' || !identity.sessionID) {
    throw Object.assign(new Error('Prime Agent session identity is invalid'), { code: 'invalid-session-identity' });
  }
  assertCurrentRuntime(identity.runtimeKey);
};

const sessionRoute = (identity: PrimeSessionIdentity, action: string) => (
  `/api/prime/sessions/${encodeURIComponent(identity.sessionID)}/${action}`
);

const throwResponseError = async (response: Response, fallback: string, runtimeKey: string): Promise<never> => {
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
  const error = parsed.success
    ? Object.assign(new Error(parsed.data.error), {
      code: parsed.data.code,
      ambiguous: parsed.data.ambiguous === true,
      session: parsed.data.session ? withIdentity(parsed.data.session, runtimeKey) : undefined,
    })
    : new Error(fallback);
  assertCurrentRuntime(runtimeKey);
  throw error;
};

type PrimeRequestOptions<T> = {
  method?: 'POST';
  body?: unknown;
  schema?: z.ZodType<T>;
  assertCurrent?: () => void;
};

const requestPrime = async <T = void>(
  route: string,
  runtimeKey: string,
  fallback: string,
  signal: AbortSignal | undefined,
  {
    method,
    body,
    schema,
    assertCurrent = () => assertCurrentRuntime(runtimeKey),
  }: PrimeRequestOptions<T> = {},
): Promise<T> => {
  const response = await runtimeFetch(route, {
    ...(method ? { method } : {}),
    headers: body === undefined
      ? { Accept: 'application/json' }
      : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) await throwResponseError(response, fallback, runtimeKey);
  const payload = schema ? await response.json() : undefined;
  assertCurrent();
  return schema ? schema.parse(payload) : undefined as T;
};

const requestPrimeSession = <T = void>(
  identity: PrimeSessionIdentity,
  action: string,
  fallback: string,
  signal: AbortSignal | undefined,
  options: Omit<PrimeRequestOptions<T>, 'assertCurrent'> = {},
) => {
  assertIdentityOwner(identity);
  return requestPrime(sessionRoute(identity, action), identity.runtimeKey, fallback, signal, {
    ...options,
    assertCurrent: () => assertIdentityOwner(identity),
  });
};

export const createWebPrimeAPI = (): PrimeAPI => ({
  async getStatus(signal) {
    const runtimeKey = getRuntimeKey();
    return await requestPrime(
      '/api/prime/status', runtimeKey, 'Failed to read Prime Agent status', signal, { schema: runtimeStatusSchema },
    );
  },

  async reconnect(signal) {
    const runtimeKey = getRuntimeKey();
    return await requestPrime(
      '/api/prime/reconnect', runtimeKey, 'Failed to reconnect Prime Agent', signal,
      { method: 'POST', schema: runtimeStatusSchema },
    );
  },

  async listSessions(signal) {
    const runtimeKey = getRuntimeKey();
    const result = await requestPrime(
      '/api/prime/sessions', runtimeKey, 'Failed to list Prime Agent sessions', signal, { schema: sessionsResultSchema },
    );
    if (result.status === 'ready' || result.status === 'partial') {
      return { ...result, sessions: result.sessions.map((session) => withIdentity(session, runtimeKey)) };
    }
    return result;
  },

  async getTranscript(identity, signal) {
    const transcript = await requestPrimeSession(
      identity, 'transcript', 'Failed to read Prime Agent transcript', signal, { schema: transcriptSchema },
    );
    return { ...transcript, session: withIdentity(transcript.session, identity.runtimeKey) };
  },

  async attachSession(identity, signal) {
    const result = await requestPrimeSession(
      identity, 'attach', 'Failed to attach Prime Agent session', signal,
      { method: 'POST', schema: createSessionSchema },
    );
    return withIdentity(result.session, identity.runtimeKey);
  },

  async getSessionControls(identity, signal) {
    return await requestPrimeSession(
      identity, 'controls', 'Failed to read Prime Agent controls', signal,
      { method: 'POST', schema: sessionControlsSchema },
    );
  },

  async getDraftControls(input, signal) {
    assertCurrentRuntime(input.runtimeKey);
    return await requestPrime(
      '/api/prime/controls', input.runtimeKey, 'Failed to read Prime Agent controls', signal, {
        method: 'POST',
        body: { directory: input.directory },
        schema: sessionControlsSchema,
      },
    );
  },

  async setSessionModel(input, signal) {
    await requestPrimeSession(
      input.identity, 'model', 'Failed to change the Prime Agent model', signal, {
        method: 'POST',
        body: { provider: input.provider, modelID: input.modelID },
        schema: acceptedSchema,
      },
    );
  },

  async setSessionThinkingLevel(input, signal) {
    await requestPrimeSession(
      input.identity, 'thinking-level', 'Failed to change the Prime Agent thinking level', signal, {
        method: 'POST',
        body: { level: input.level },
        schema: acceptedSchema,
      },
    );
  },

  async createSession(input, signal) {
    assertCurrentRuntime(input.runtimeKey);
    const result = await requestPrime(
      '/api/prime/sessions', input.runtimeKey, 'Failed to create Prime Agent session', signal, {
        method: 'POST',
        body: {
          directory: input.directory,
          prompt: input.prompt,
          provider: input.provider,
          modelID: input.modelID,
          thinkingLevel: input.thinkingLevel,
        },
        schema: createSessionSchema,
      },
    );
    return withIdentity(result.session, input.runtimeKey);
  },

  async sendPrompt(input, signal) {
    await requestPrimeSession(
      input.identity, 'prompts', 'Failed to send Prime Agent prompt', signal, {
        method: 'POST',
        body: { prompt: input.prompt },
      },
    );
  },

  async forkSession(input, signal) {
    const result = await requestPrimeSession(
      input.identity, 'fork', 'Failed to fork Prime Agent session', signal, {
        method: 'POST',
        body: { entryID: input.entryID },
        schema: branchSessionSchema,
      },
    );
    return {
      ...result,
      session: withIdentity(result.session, input.identity.runtimeKey),
    };
  },

  async abortSession(identity, signal) {
    await requestPrimeSession(
      identity, 'abort', 'Failed to abort Prime Agent session', signal, { method: 'POST' },
    );
  },

  subscribe(listener) {
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'prime-runtime-changed') {
        listener({ type: 'runtime-changed', status: event.status } satisfies PrimeEvent);
      } else if (event.type === 'prime-session-changed') {
        listener({
          type: 'session-changed',
          sessionID: event.sessionID,
          activity: event.activity,
          catalogChanged: event.catalogChanged,
        } satisfies PrimeEvent);
      } else if (event.type === 'event-stream-ready') {
        listener({ type: 'stream-ready' } satisfies PrimeEvent);
      }
    });
    return { close: unsubscribe };
  },
});
