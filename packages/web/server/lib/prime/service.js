import { buildPrimeCatalog } from './catalog.js';
import { PrimeServiceError } from './errors.js';
import { openBoundedDirectory, resolvePrimeStoragePaths, resolveRequiredDirectory } from './secure-files.js';
import { createPrimeTranscriptService } from './transcript.js';
import { createPrimeRuntimeManager } from './runtime-manager.js';
import { PRIME_DAEMON_PROTOCOL_VERSION, PRIME_DAEMON_SCHEMA_REVISION } from './daemon-protocol.js';

/** @typedef {{code:string, message?:string, sessionId?:string}} PrimeIssue */
/**
 * @typedef {object} PrimeCatalogSession
 * @property {string} sessionId Durable public Prime session ID.
 * @property {string} title
 * @property {string|null} parentSessionId Durable public parent ID; never an RLM node ID.
 * @property {string} rootSessionId Durable public root ID.
 * @property {string=} workingDirectory Validated absolute placement input for the private UI adapter.
 * @property {number=} createdAt
 * @property {number=} updatedAt
 * @property {'working'|'idle'|'inactive'} residency
 * @property {'ready'|'unavailable'} availability
 */
/**
 * @typedef {object} PrimeCatalogResponse
 * @property {1} schemaVersion
 * @property {string} revision
 * @property {boolean} complete
 * @property {PrimeCatalogSession[]} sessions
 * @property {PrimeIssue[]} issues
 */
/**
 * Neutral transcript blocks intentionally omit Prime transport aliases, tool-call
 * IDs, signatures, response IDs, artifact paths, and runtime process details.
 * @typedef {{type:string, text?:string, name?:string, input?:unknown, reason?:string, bytes?:number, bytesAtLeast?:number}} PrimeTranscriptBlock
 */
/**
 * @typedef {object} PrimeTranscriptMessage
 * @property {'message'} type
 * @property {string=} id
 * @property {'user'|'assistant'|'tool'|'system'|'custom'} role
 * @property {number=} timestamp
 * @property {{durationMs?:number, diffFiles?:Array<{path:string, patch:string, additions:number, deletions:number, openable:boolean}>, omittedDiffs?:number}=} toolPresentation
 * @property {PrimeTranscriptBlock[]} blocks
 */

/**
 * Creates the Prime service with fixed storage roots. Status, catalog,
 * transcript, and context methods remain filesystem-only; only explicit
 * creation or activation enters the daemon/runtime manager.
 */
export const createPrimeService = (options = {}) => {
  const storagePaths = resolvePrimeStoragePaths(options);
  const transcriptService = createPrimeTranscriptService(options);

  const getStatus = async () => {
    try {
      const sessionsRoot = await resolveRequiredDirectory(
        storagePaths.sessionsRoot,
        'prime_sessions_root_unavailable',
      );
      const directory = await openBoundedDirectory(sessionsRoot, sessionsRoot);
      await directory.close();
      return {
        schemaVersion: 1,
        supported: true,
        availability: 'ready',
        protocolVersion: PRIME_DAEMON_PROTOCOL_VERSION,
        schemaRevision: PRIME_DAEMON_SCHEMA_REVISION,
        issues: [],
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        supported: true,
        availability: 'unavailable',
        issues: [{ code: error?.code || 'prime_sessions_root_unavailable' }],
      };
    }
  };

  const getCatalogState = () => buildPrimeCatalog(storagePaths);
  const getCatalog = async () => (await getCatalogState()).response;

  const resolveEntity = async (sessionId) => {
    const catalog = await getCatalogState();
    const entity = catalog.entities.get(sessionId);
    if (entity) return entity;
    if (catalog.response.sessions.length === 0
      && catalog.response.issues.some((issue) => issue.code === 'prime_sessions_root_missing'
        || issue.code === 'prime_sessions_root_unavailable')) {
      throw new PrimeServiceError(503, 'prime_catalog_unavailable', 'Prime catalog is unavailable');
    }
    throw new PrimeServiceError(404, 'prime_session_not_found', 'Prime session was not found');
  };

  const runtimeManager = createPrimeRuntimeManager({
    resolveEntity,
    agentRoot: storagePaths.agentRoot,
    sessionsRoot: storagePaths.sessionsRoot,
    env: options.env,
    buildAugmentedPath: options.buildAugmentedPath,
    socketPath: options.socketPath,
  });

  const getTranscript = async (sessionId, query) => transcriptService.getTranscript(
    await resolveEntity(sessionId),
    query,
  );
  const getContext = async (sessionId) => transcriptService.getContext(await resolveEntity(sessionId));

  return {
    getStatus,
    getCatalog,
    getTranscript,
    getContext,
    createRoot: runtimeManager.createRoot,
    activate: runtimeManager.activate,
    deactivate: runtimeManager.deactivate,
    prompt: runtimeManager.prompt,
    abort: runtimeManager.abort,
    setModel: runtimeManager.setModel,
    setThinkingLevel: runtimeManager.setThinkingLevel,
    getLiveSnapshot: runtimeManager.getSnapshot,
    openEventSubscription: runtimeManager.openEventSubscription,
    dispose: runtimeManager.dispose,
  };
};
