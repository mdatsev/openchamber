import { create } from 'zustand';

import type {
  PrimeAbortRequest,
  PrimeCreationRequest,
  PrimeCreationResponse,
  PrimeLiveSnapshot,
  PrimeModel,
  PrimeMutationFence,
  PrimeMutationResponse,
  PrimePromptRequest,
  PrimeSetModelRequest,
  PrimeSetThinkingLevelRequest,
  PrimeThinkingLevel,
  RuntimeAPIs,
} from '@/lib/api/types';
import { serializeChatIdentity, type ChatIdentity } from '@/lib/chat-identity';
import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import {
  catchUpPrimeLiveSession,
  getPrimeLiveKey,
  usePrimeLiveStore,
} from '@/stores/usePrimeLiveStore';

export type PrimeComposerMutationAction = 'prompt' | 'abort' | 'set_model' | 'set_thinking_level';

type PrimeDraftConfiguration = Readonly<{
  sourceSessionId: string;
  sourceGeneration: string;
  sourceRevision: number;
  sourceObservedAt: number;
  models: readonly PrimeModel[];
  thinkingLevels: readonly PrimeThinkingLevel[];
  sourceCurrentModel: PrimeModel;
  selectedModel: PrimeModel | null;
  selectedThinkingLevel: PrimeThinkingLevel | null;
}>;

export type PrimeComposerSnapshot = Readonly<{
  draft: string;
  draftConfiguration: PrimeDraftConfiguration | null;
  pendingAction: PrimeComposerMutationAction | 'create' | null;
  retryAction: PrimeComposerMutationAction | null;
  issueCode: string | null;
}>;

type PrimeComposerStore = {
  byKey: ReadonlyMap<string, PrimeComposerSnapshot>;
};

type PromptEnvelope = { action: 'prompt'; request: PrimePromptRequest; draft: string };
type AbortEnvelope = { action: 'abort'; request: PrimeAbortRequest };
type ModelEnvelope = { action: 'set_model'; request: PrimeSetModelRequest };
type ThinkingEnvelope = { action: 'set_thinking_level'; request: PrimeSetThinkingLevelRequest };
type MutationEnvelope = PromptEnvelope | AbortEnvelope | ModelEnvelope | ThinkingEnvelope;

const CACHE_LIMIT = 24;
const IN_FLIGHT_LIMIT = 8;
const RETRY_LIMIT = 64;
const MAX_PROMPT_BYTES = 256 * 1024;
const SAFE_PROMPT_CODE_UNITS = Math.floor(MAX_PROMPT_BYTES / 3);
const EMPTY_SNAPSHOT: PrimeComposerSnapshot = {
  draft: '',
  draftConfiguration: null,
  pendingAction: null,
  retryAction: null,
  issueCode: null,
};
const inFlightByKey = new Map<string, Promise<boolean>>();
const creationInFlightByKey = new Map<string, Promise<PrimeCreationResponse | null>>();
const retryByKeyAndAction = new Map<string, MutationEnvelope>();

export const getPrimeComposerKey = (identity: ChatIdentity): string => serializeChatIdentity(identity);
export const getPrimeDraftComposerKey = (identity: ChatDraftIdentity): string => (
  `draft:${getChatDraftIdentityKey(identity)}`
);
export const usePrimeComposerStore = create<PrimeComposerStore>()(() => ({ byKey: new Map() }));

export const selectPrimeComposerSnapshot = (
  state: PrimeComposerStore,
  identity: ChatIdentity,
): PrimeComposerSnapshot => state.byKey.get(getPrimeComposerKey(identity)) ?? EMPTY_SNAPSHOT;

export const selectPrimeDraftComposerSnapshot = (
  state: PrimeComposerStore,
  identity: ChatDraftIdentity,
): PrimeComposerSnapshot => state.byKey.get(getPrimeDraftComposerKey(identity)) ?? EMPTY_SNAPSHOT;

export const selectPrimeDraftCreationPending = (
  state: PrimeComposerStore,
  runtimeKey: string,
): boolean => {
  const prefix = `draft:[${JSON.stringify(runtimeKey)},"prime",`;
  for (const [key, snapshot] of state.byKey) {
    if (key.startsWith(prefix) && snapshot.pendingAction === 'create') return true;
  }
  return false;
};

const retryKey = (identity: ChatIdentity, action: PrimeComposerMutationAction): string => (
  `${serializeChatIdentity(identity)}:${action}`
);

const rememberRetry = (key: string, envelope: MutationEnvelope) => {
  retryByKeyAndAction.delete(key);
  retryByKeyAndAction.set(key, envelope);
  while (retryByKeyAndAction.size > RETRY_LIMIT) {
    const oldest = retryByKeyAndAction.keys().next().value as string | undefined;
    if (!oldest) break;
    retryByKeyAndAction.delete(oldest);
  }
};

const updateSnapshotByKey = (
  key: string,
  update: (previous: PrimeComposerSnapshot) => PrimeComposerSnapshot,
) => {
  usePrimeComposerStore.setState((state) => {
    const previous = state.byKey.get(key) ?? EMPTY_SNAPSHOT;
    const next = update(previous);
    if (next === previous) return state;
    const byKey = new Map(state.byKey);
    byKey.delete(key);
    byKey.set(key, next);
    if (byKey.size > CACHE_LIMIT) {
      for (const candidateKey of byKey.keys()) {
        if (byKey.size <= CACHE_LIMIT) break;
        if (!inFlightByKey.has(candidateKey) && !creationInFlightByKey.has(candidateKey)) {
          byKey.delete(candidateKey);
        }
      }
    }
    return { byKey };
  });
};

const updateSnapshot = (
  identity: ChatIdentity,
  update: (previous: PrimeComposerSnapshot) => PrimeComposerSnapshot,
) => updateSnapshotByKey(getPrimeComposerKey(identity), update);

const boundPromptDraft = (draft: string): { value: string; truncated: boolean } => {
  if (draft.length <= SAFE_PROMPT_CODE_UNITS) return { value: draft, truncated: false };
  const bytes = new TextEncoder().encode(draft);
  if (bytes.byteLength <= MAX_PROMPT_BYTES) return { value: draft, truncated: false };
  let end = MAX_PROMPT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
  };
};

export const setPrimeComposerDraft = (identity: ChatIdentity, draft: string) => {
  if (identity.harness !== 'prime') return;
  const bounded = boundPromptDraft(draft);
  updateSnapshot(identity, (previous) => ({
    ...previous,
    draft: bounded.value,
    retryAction: previous.retryAction === 'prompt' && bounded.value !== previous.draft
      ? null
      : previous.retryAction,
    issueCode: bounded.truncated ? 'prime_prompt_too_large' : null,
  }));
};

export const setPrimeDraftComposerDraft = (identity: ChatDraftIdentity, draft: string) => {
  if (identity.harness !== 'prime' || identity.sessionId !== null) return;
  const bounded = boundPromptDraft(draft);
  updateSnapshotByKey(getPrimeDraftComposerKey(identity), (previous) => ({
    ...previous,
    draft: bounded.value,
    retryAction: null,
    issueCode: bounded.truncated
      ? 'prime_prompt_too_large'
      : bounded.value === previous.draft
        ? previous.issueCode
        : null,
  }));
};

const samePrimeModel = (left: Pick<PrimeModel, 'provider' | 'id'>, right: Pick<PrimeModel, 'provider' | 'id'>) => (
  left.provider === right.provider && left.id === right.id
);

const clonePrimeModel = (model: PrimeModel): PrimeModel => ({
  ...model,
  input: [...model.input],
});

export const initializePrimeDraftConfiguration = (
  identity: ChatDraftIdentity,
  snapshot: PrimeLiveSnapshot,
) => {
  if (identity.harness !== 'prime'
    || identity.sessionId !== null
    || snapshot.freshness.state !== 'fresh') return;
  const currentModel = snapshot.configuration.currentModel;
  const authoritativeModel = currentModel && snapshot.configuration.models.find((model) => (
    samePrimeModel(model, currentModel)
  ));
  if (!authoritativeModel) return;
  const models = snapshot.configuration.models.map(clonePrimeModel);
  const initialModel = models.find((model) => samePrimeModel(model, authoritativeModel));
  if (!initialModel) return;
  updateSnapshotByKey(getPrimeDraftComposerKey(identity), (previous) => {
    const existing = previous.draftConfiguration;
    if (existing?.selectedModel
      || (existing && existing.sourceObservedAt >= snapshot.freshness.observedAt)) return previous;
    return {
      ...previous,
      draftConfiguration: {
        sourceSessionId: snapshot.sessionId,
        sourceGeneration: snapshot.generation,
        sourceRevision: snapshot.revision,
        sourceObservedAt: snapshot.freshness.observedAt,
        models,
        thinkingLevels: [...snapshot.configuration.thinking.available],
        sourceCurrentModel: initialModel,
        selectedModel: null,
        selectedThinkingLevel: null,
      },
    };
  });
};

export const setPrimeDraftModel = (identity: ChatDraftIdentity, model: PrimeModel | null) => {
  if (identity.harness !== 'prime' || identity.sessionId !== null) return;
  updateSnapshotByKey(getPrimeDraftComposerKey(identity), (previous) => {
    const configuration = previous.draftConfiguration;
    if (!configuration || previous.pendingAction) return previous;
    if (model === null) {
      if (configuration.selectedModel === null && configuration.selectedThinkingLevel === null) return previous;
      return {
        ...previous,
        draftConfiguration: {
          ...configuration,
          selectedModel: null,
          selectedThinkingLevel: null,
        },
        issueCode: null,
      };
    }
    const selectedModel = configuration.models.find((candidate) => samePrimeModel(candidate, model));
    if (!selectedModel || (configuration.selectedModel
      && samePrimeModel(configuration.selectedModel, selectedModel))) return previous;
    return {
      ...previous,
      draftConfiguration: {
        ...configuration,
        selectedModel,
        selectedThinkingLevel: null,
      },
      issueCode: null,
    };
  });
};

export const setPrimeDraftThinkingLevel = (
  identity: ChatDraftIdentity,
  level: PrimeThinkingLevel | null,
) => {
  if (identity.harness !== 'prime' || identity.sessionId !== null) return;
  updateSnapshotByKey(getPrimeDraftComposerKey(identity), (previous) => {
    const configuration = previous.draftConfiguration;
    if (!configuration
      || previous.pendingAction
      || !configuration.selectedModel
      || !samePrimeModel(configuration.selectedModel, configuration.sourceCurrentModel)
      || (level !== null && !configuration.thinkingLevels.includes(level))
      || configuration.selectedThinkingLevel === level) return previous;
    return {
      ...previous,
      draftConfiguration: { ...configuration, selectedThinkingLevel: level },
      issueCode: null,
    };
  });
};

const issueCode = (error: unknown): string => (
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'prime_mutation_request_failed'
);

const errorStatus = (error: unknown): number | null => (
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null
);

const resultIsUncertain = (error: unknown): boolean => {
  const code = issueCode(error);
  const status = errorStatus(error);
  return code === 'prime_mutation_uncertain'
    || code === 'prime_invalid_response'
    || code === 'prime_response_session_mismatch'
    || status === null
    || status >= 500;
};

const creationIssueCode = (error: unknown): string => {
  const code = issueCode(error);
  return code === 'prime_creation_uncertain'
    || code === 'prime_invalid_response'
    || code === 'prime_response_session_mismatch'
    || code === 'prime_mutation_request_failed'
    || code === 'prime_request_failed'
    ? 'prime_creation_uncertain'
    : code;
};

const creationConfigurationUnavailable = (): Error & { code: string } => Object.assign(
  new Error('prime_creation_configuration_unavailable'),
  { code: 'prime_creation_configuration_unavailable' },
);

const creationSourceRefreshFailed = (): Error & { code: string } => Object.assign(
  new Error('prime_creation_source_refresh_failed'),
  { code: 'prime_creation_source_refresh_failed' },
);

const creationRequestForDraft = async (
  workingDirectory: string,
  message: string,
  configuration: PrimeDraftConfiguration | null,
  apis: RuntimeAPIs,
): Promise<PrimeCreationRequest> => {
  const base = { workingDirectory, message };
  const selectedModel = configuration?.selectedModel;
  if (!configuration || !selectedModel) return base;

  let snapshot: PrimeLiveSnapshot;
  try {
    snapshot = await apis.prime.getSnapshot(configuration.sourceSessionId);
  } catch {
    throw creationSourceRefreshFailed();
  }
  if (snapshot.sessionId !== configuration.sourceSessionId
    || snapshot.freshness.state !== 'fresh'
    || !snapshot.configuration.models.some((model) => (
      samePrimeModel(model, selectedModel)
    ))) {
    throw creationConfigurationUnavailable();
  }

  const thinkingLevel = configuration.selectedThinkingLevel ?? undefined;
  if (thinkingLevel !== undefined) {
    const currentModel = snapshot.configuration.currentModel;
    if (!currentModel
      || !samePrimeModel(currentModel, selectedModel)
      || !snapshot.configuration.thinking.available.includes(thinkingLevel)) {
      throw creationConfigurationUnavailable();
    }
  }

  return {
    ...base,
    sourceSessionId: snapshot.sessionId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    provider: selectedModel.provider,
    modelId: selectedModel.id,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
};

export const createPrimeSessionFromDraft = (
  identity: ChatDraftIdentity,
  apis: RuntimeAPIs,
  message?: string,
  options?: { resolveWorkingDirectory: () => Promise<string | null> },
): Promise<PrimeCreationResponse | null> => {
  if (identity.harness !== 'prime' || identity.sessionId !== null) {
    return Promise.resolve(null);
  }
  const key = getPrimeDraftComposerKey(identity);
  const existing = creationInFlightByKey.get(key);
  if (existing) return existing;
  if (inFlightByKey.size + creationInFlightByKey.size >= IN_FLIGHT_LIMIT) {
    updateSnapshotByKey(key, (previous) => ({
      ...previous,
      retryAction: null,
      issueCode: 'prime_mutation_client_limit',
    }));
    return Promise.resolve(null);
  }
  const capturedComposer = selectPrimeDraftComposerSnapshot(
    usePrimeComposerStore.getState(),
    identity,
  );
  const capturedDraft = message ?? capturedComposer.draft;
  const capturedConfiguration = capturedComposer.draftConfiguration;
  if (!capturedDraft.trim()
    || new TextEncoder().encode(capturedDraft).byteLength > MAX_PROMPT_BYTES) {
    updateSnapshotByKey(key, (previous) => ({
      ...previous,
      retryAction: null,
      issueCode: 'prime_prompt_not_allowed',
    }));
    return Promise.resolve(null);
  }
  updateSnapshotByKey(key, (previous) => ({
    ...previous,
    pendingAction: 'create',
    retryAction: null,
    issueCode: null,
  }));
  const request = (async () => {
    try {
      const workingDirectory = options
        ? await options.resolveWorkingDirectory()
        : identity.directory;
      if (!workingDirectory) {
        throw Object.assign(new Error('prime_creation_target_unavailable'), {
          code: 'prime_creation_target_unavailable',
        });
      }
      const creationRequest = await creationRequestForDraft(
        workingDirectory,
        capturedDraft,
        capturedConfiguration,
        apis,
      );
      const response = await apis.prime.create(creationRequest);
      if (response.accepted !== true || !response.sessionId) {
        throw Object.assign(new Error('prime_invalid_response'), { code: 'prime_invalid_response' });
      }
      updateSnapshotByKey(key, (previous) => ({
        ...previous,
        draft: previous.draft === capturedDraft ? '' : previous.draft,
        draftConfiguration: null,
        issueCode: null,
      }));
      return response;
    } catch (error) {
      updateSnapshotByKey(key, (previous) => ({
        ...previous,
        retryAction: null,
        issueCode: creationIssueCode(error),
      }));
      return null;
    } finally {
      updateSnapshotByKey(key, (previous) => ({ ...previous, pendingAction: null }));
    }
  })();
  creationInFlightByKey.set(key, request);
  void request.finally(() => {
    if (creationInFlightByKey.get(key) === request) creationInFlightByKey.delete(key);
  });
  return request;
};

const currentLiveSnapshot = (identity: ChatIdentity): PrimeLiveSnapshot | null => {
  const live = usePrimeLiveStore.getState().byKey.get(getPrimeLiveKey(identity));
  return live?.desiredActive && live.availability === 'live' ? live.snapshot : null;
};

const requireAuthority = (identity: ChatIdentity): { snapshot: PrimeLiveSnapshot; fence: PrimeMutationFence } => {
  const snapshot = currentLiveSnapshot(identity);
  if (!snapshot
    || snapshot.freshness.state !== 'fresh'
    || snapshot.capabilities.mutations !== true) {
    throw Object.assign(new Error('prime_mutation_unavailable'), { code: 'prime_mutation_unavailable' });
  }
  return {
    snapshot,
    fence: {
      generation: snapshot.generation,
      revision: snapshot.revision,
      turnToken: snapshot.turn.token,
      idempotencyKey: `openchamber:${crypto.randomUUID()}`,
    },
  };
};

const executeEnvelope = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
  envelope: MutationEnvelope,
): Promise<PrimeMutationResponse> => {
  if (envelope.action === 'prompt') return apis.prime.prompt(identity.sessionId, envelope.request);
  if (envelope.action === 'abort') return apis.prime.abort(identity.sessionId, envelope.request);
  if (envelope.action === 'set_model') return apis.prime.setModel(identity.sessionId, envelope.request);
  return apis.prime.setThinkingLevel(identity.sessionId, envelope.request);
};

const runMutation = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
  envelope: MutationEnvelope,
): Promise<boolean> => {
  const key = getPrimeComposerKey(identity);
  const existing = inFlightByKey.get(key);
  if (existing) return existing;
  if (inFlightByKey.size >= IN_FLIGHT_LIMIT) {
    updateSnapshot(identity, (previous) => ({
      ...previous,
      retryAction: null,
      issueCode: 'prime_mutation_client_limit',
    }));
    return Promise.resolve(false);
  }
  const envelopeRetryKey = retryKey(identity, envelope.action);
  updateSnapshot(identity, (previous) => ({
    ...previous,
    pendingAction: envelope.action,
    retryAction: null,
    issueCode: null,
  }));
  const request = (async () => {
    try {
      const response = await executeEnvelope(identity, apis, envelope);
      if (!response.accepted || response.sessionId !== identity.sessionId) {
        throw Object.assign(new Error('prime_invalid_response'), { code: 'prime_invalid_response' });
      }
      retryByKeyAndAction.delete(envelopeRetryKey);
      if (envelope.action === 'prompt') {
        updateSnapshot(identity, (previous) => ({
          ...previous,
          draft: previous.draft === envelope.draft ? '' : previous.draft,
          issueCode: null,
        }));
      }
      await catchUpPrimeLiveSession(identity);
      return true;
    } catch (error) {
      const uncertain = resultIsUncertain(error);
      if (uncertain) rememberRetry(envelopeRetryKey, envelope);
      else retryByKeyAndAction.delete(envelopeRetryKey);
      updateSnapshot(identity, (previous) => ({
        ...previous,
        retryAction: uncertain ? envelope.action : null,
        issueCode: issueCode(error),
      }));
      return false;
    } finally {
      updateSnapshot(identity, (previous) => ({ ...previous, pendingAction: null }));
    }
  })();
  inFlightByKey.set(key, request);
  void request.finally(() => {
    if (inFlightByKey.get(key) === request) inFlightByKey.delete(key);
  });
  return request;
};

const promptEnvelope = (identity: ChatIdentity, draft: string): PromptEnvelope => {
  const saved = retryByKeyAndAction.get(retryKey(identity, 'prompt'));
  if (saved?.action === 'prompt' && saved.draft === draft) return saved;
  retryByKeyAndAction.delete(retryKey(identity, 'prompt'));
  const { snapshot, fence } = requireAuthority(identity);
  if (snapshot.status.activity !== 'idle'
    || !snapshot.capabilities.actions.canSend
    || !draft.trim()
    || new TextEncoder().encode(draft).byteLength > MAX_PROMPT_BYTES) {
    throw Object.assign(new Error('prime_prompt_not_allowed'), { code: 'prime_prompt_not_allowed' });
  }
  return { action: 'prompt', request: { ...fence, message: draft }, draft };
};

export const submitPrimePrompt = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
): Promise<boolean> => {
  const draft = selectPrimeComposerSnapshot(usePrimeComposerStore.getState(), identity).draft;
  try {
    return runMutation(identity, apis, promptEnvelope(identity, draft));
  } catch (error) {
    updateSnapshot(identity, (previous) => ({ ...previous, retryAction: null, issueCode: issueCode(error) }));
    return Promise.resolve(false);
  }
};

const abortEnvelope = (identity: ChatIdentity): AbortEnvelope => {
  const saved = retryByKeyAndAction.get(retryKey(identity, 'abort'));
  if (saved?.action === 'abort') return saved;
  const { snapshot, fence } = requireAuthority(identity);
  if (snapshot.status.activity !== 'working'
    || !snapshot.turn.active
    || !snapshot.capabilities.actions.canAbort) {
    throw Object.assign(new Error('prime_abort_not_allowed'), { code: 'prime_abort_not_allowed' });
  }
  return { action: 'abort', request: fence };
};

export const abortPrimeTurn = (identity: ChatIdentity, apis: RuntimeAPIs): Promise<boolean> => {
  try {
    return runMutation(identity, apis, abortEnvelope(identity));
  } catch (error) {
    updateSnapshot(identity, (previous) => ({ ...previous, retryAction: null, issueCode: issueCode(error) }));
    return Promise.resolve(false);
  }
};

const modelEnvelope = (identity: ChatIdentity, model: Pick<PrimeModel, 'provider' | 'id'>): ModelEnvelope => {
  const saved = retryByKeyAndAction.get(retryKey(identity, 'set_model'));
  if (saved?.action === 'set_model'
    && saved.request.provider === model.provider
    && saved.request.modelId === model.id) return saved;
  retryByKeyAndAction.delete(retryKey(identity, 'set_model'));
  const { snapshot, fence } = requireAuthority(identity);
  if (snapshot.status.activity !== 'idle'
    || !snapshot.capabilities.actions.canChangeModel
    || !snapshot.configuration.models.some((candidate) => (
      candidate.provider === model.provider && candidate.id === model.id
    ))) {
    throw Object.assign(new Error('prime_model_not_allowed'), { code: 'prime_model_not_allowed' });
  }
  return {
    action: 'set_model',
    request: { ...fence, provider: model.provider, modelId: model.id },
  };
};

export const setPrimeModel = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
  model: Pick<PrimeModel, 'provider' | 'id'>,
): Promise<boolean> => {
  try {
    return runMutation(identity, apis, modelEnvelope(identity, model));
  } catch (error) {
    updateSnapshot(identity, (previous) => ({ ...previous, retryAction: null, issueCode: issueCode(error) }));
    return Promise.resolve(false);
  }
};

const thinkingEnvelope = (identity: ChatIdentity, level: PrimeThinkingLevel): ThinkingEnvelope => {
  const saved = retryByKeyAndAction.get(retryKey(identity, 'set_thinking_level'));
  if (saved?.action === 'set_thinking_level' && saved.request.level === level) return saved;
  retryByKeyAndAction.delete(retryKey(identity, 'set_thinking_level'));
  const { snapshot, fence } = requireAuthority(identity);
  if (snapshot.status.activity !== 'idle'
    || !snapshot.capabilities.actions.canChangeModel
    || !snapshot.configuration.thinking.available.includes(level)) {
    throw Object.assign(new Error('prime_thinking_level_not_allowed'), { code: 'prime_thinking_level_not_allowed' });
  }
  return { action: 'set_thinking_level', request: { ...fence, level } };
};

export const setPrimeThinkingLevel = (
  identity: ChatIdentity,
  apis: RuntimeAPIs,
  level: PrimeThinkingLevel,
): Promise<boolean> => {
  try {
    return runMutation(identity, apis, thinkingEnvelope(identity, level));
  } catch (error) {
    updateSnapshot(identity, (previous) => ({ ...previous, retryAction: null, issueCode: issueCode(error) }));
    return Promise.resolve(false);
  }
};
