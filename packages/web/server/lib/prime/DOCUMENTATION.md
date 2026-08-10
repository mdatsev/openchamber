# Prime Service

- **Type:** reference
- **Purpose:** Contracts, security boundaries, and lifecycle invariants for the web server's passive Prime history, one-shot root creation, live activation, and fenced existing-session mutations.
- **When to read:** Before changing `/api/prime/**`, Prime session discovery or creation, activation, daemon transport, live snapshots/events, or transcript/context projection.

## Ownership and activation boundary

`service.js` owns the web/Electron Prime API. It resolves the configured session
root once when the service is created: `PRIME_AGENT_SESSION_DIR`, then the
legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, then `~/.prime/agent/sessions`.

The Phase 2 GETs remain passive. Status, catalog, transcript, and context reads
never connect to the Prime daemon, launch it, attach/reopen a worker, or acquire
an active-session alias. Protocol version 7 and schema revision 13 in status
only describe supported persisted formats.

Only authenticated, origin-checked explicit POST routes cross the live-runtime
boundary. Root creation is one-shot and activation rebuilds the bounded catalog, resolves the public lower-case
UUIDv7 to a freshly secured entity, and reopens that exact canonical file before
consulting Prime. Clients never submit a file path or daemon active-session ID. Activation also
requires the durable header's working directory to be normalized, absolute, and
currently a directory; it never substitutes the OpenChamber server cwd.
A daemon session is reusable only when both its durable session ID and canonical
private session file match the newly validated entity and the supervisor supplies
a real active alias. A contradictory stale supervisor descriptor (for example,
`ready` without a connected worker/active alias) fails stably; OpenChamber does
not guess the durable ID as an alias or blindly create a duplicate.

## Passive routes

All responses use `schemaVersion: 1`; errors use
`{ schemaVersion: 1, error: { code, message } }` with fixed public messages.

- `GET /api/prime/status` reports passive service/catalog availability. `ready`
  means the fixed session root is safely readable, not that a daemon is running.
- `GET /api/prime/catalog` returns durable public session IDs, complete durable
  ancestry, passive `working | idle | inactive` residency when a live worker
  recovery record makes it knowable, and isolated bounded issue codes. Its
  authenticated transport record retains the validated absolute
  `workingDirectory` solely so the Web/UI Prime adapter can build its private
  identity-to-directory ownership map; the adapter must strip it before shared
  session catalogs, controller state, revision inputs, search, or presentation.
- `GET /api/prime/sessions/:sessionId/transcript` returns recent display records
  only from the current append-only Prime branch. The reverse scan starts at the
  latest durable leaf and follows exact `parentId` ancestry, excluding abandoned
  siblings. The default and maximum page is 200 records or 2 MiB. `olderCursor`
  is opaque, authenticated by the server process, bound to the file revision,
  and carries the next expected ancestor so paging cannot drift branches.
  Oversized messages become explicit omission blocks; a scan limit truncates
  the page rather than returning a transcript-wide 413.
- `GET /api/prime/sessions/:sessionId/context` returns only token, cache,
  monetary-cost, and current-window values exactly derivable from a bounded
  complete JSONL read. Unknown values are omitted and oversized sessions return
  `truncated: true`. An explicitly activated live snapshot may additionally
  carry the same whitelisted session totals from Prime's authoritative
  `get_session_stats` response; private paths and identities are discarded.

These GETs retain no daemon connection and have no activation side effects.

## Live routes

- `POST /api/prime/sessions` is the OpenChamber-server one-shot root-creation
  edge. Its bounded exact default body contains only an existing absolute
  `workingDirectory` and a nonblank prompt of at most 256 KiB UTF-8. A configured
  request must additionally carry the complete public source fence and model pair
  `{ sourceSessionId, generation, revision, provider, modelId }`, plus an optional
  `thinkingLevel`; partial or unknown fields are rejected. Immediately before the
  daemon request write, the manager requires that source runtime to remain
  desired-active, attached, unblocked, fresh, same-generation, and at least the
  supplied revision. The exact model must remain in its cached authoritative
  catalog. Thinking must remain available and may be supplied only when that model
  is the source snapshot's current model; a different model receives no thinking
  override. Authority/catalog failure is a fixed known 409 before create.
  The manager resolves the directory and fixed session root, sends one root
  `create` with only the validated `provider`/`model`/`thinking` config additions,
  validates the returned public UUIDv7/private alias/direct canonical session
  path, then sends the prompt exactly once on the same connection. Transport or
  protocol uncertainty at either command returns `prime_creation_uncertain` and
  is never retried or cleaned up; clients must refresh the catalog before choosing
  another explicit attempt. Prompt success is published only after secure header
  identity, cwd, and containment validation. Creation is not automatically
  activated, and catalog refresh discovers the durable root.
- `POST /api/prime/sessions/:sessionId/activate` is the Phase 3 activation edge.
  It connects to the official public supervisor, reuses the exact live canonical
  session when present, or sends Prime's `create` with the server-owned canonical
  file and runtime config. It then attaches with `attach_snapshot`,
  `event_sequence`, `slim_attach`, and `chunked_snapshot`. If that explicit attach
  receives the exact known `Session worker is not connected` rejection, activation
  may send one `retry_worker`, then must relist, revalidate the canonical entity and
  fresh private alias, and attach once. Automatic reconnect never performs this
  worker recovery, and transport-unknown failures are not retried.
- `POST /api/prime/sessions/:sessionId/deactivate` stops reconnect, detaches the
  OpenChamber client, closes its socket, retains only a bounded stale public
  snapshot, and closes event subscribers. It does not kill a resident Prime
  worker or a successfully launched public supervisor; those are Prime-owned
  durable resources by the official resident-worker contract.
- `GET /api/prime/sessions/:sessionId/snapshot` reads only the manager's cached
  public snapshot. It never activates or reconnects. A never-activated session
  returns `prime_runtime_not_activated`; a failed/disconnected runtime preserves
  its prior snapshot with explicit stale freshness rather than returning empty.
- `GET /api/prime/sessions/:sessionId/events` is authenticated SSE over the
  existing `/api/*` HTTP/relay path. It sends the current cached snapshot first,
  then bounded normalized events, freshness changes, and a terminal `closed`
  event on deactivation. A backpressured client retains no event queue: events
  coalesce to one authoritative cached snapshot after drain, and a client that
  stays blocked past the bounded drain timeout is closed.

At most eight sessions may be desired-active in one server process, and each
session accepts at most sixteen SSE subscribers. Inactive cached snapshots are
bounded to the sixteen most recently accessed sessions.

## Existing-session mutations

Four authenticated, same-origin Phase 4 routes operate only on an already
activated, fresh existing session:

- `POST /api/prime/sessions/:sessionId/prompt`
- `POST /api/prime/sessions/:sessionId/abort`
- `POST /api/prime/sessions/:sessionId/model`
- `POST /api/prime/sessions/:sessionId/thinking-level`

Every request must carry the exact current OpenChamber `generation`, `revision`,
and `turnToken`, plus a bounded server-process idempotency key. Prompt text is
capped at 256 KiB UTF-8, the whole JSON request at 300 KiB, model selectors at
160 characters, and thinking levels to the published enum. Unknown fields are
rejected, so clients cannot submit a Prime alias, path, worker identity, or
other private transport value. Prompt is admitted only while idle, abort only
for the exact active turn, and model/thinking changes only while idle and when
the selection is in the authoritative published catalog. Stale, disconnected,
reconnecting, mismatched, or capability-disabled state fails before dispatch.

Each runtime serializes dispatch and retains at most 64 mutation outcomes for
fifteen minutes. Reuse of a key with the identical action payload returns the same pending or completed public
result; reuse with a different action payload is a conflict. The corresponding Prime
daemon envelope uses a stable process-owned client ID and a random command ID
fixed to that HTTP entry. Browser prompts intentionally omit Prime's
`agentMessageId`: combining that field with literal prompt mode selects Prime's
inter-agent acceptance path and would skip normal human-prompt pre-turn work.
Prime journals mutating commands before dispatch:
completed results can be replayed and a pending result returns
`command_result_uncertain` without redispatch. OpenChamber acknowledges known
completed results, never blindly retries an uncertain result, revokes runtime
authority on transport/daemon uncertainty, and returns only fixed public errors.
A successful model change also revokes authority and forces the bounded full
reconnect/snapshot path because Prime may re-clamp both the current and available
thinking levels; the accepted response includes new authority only if that
snapshot and refreshed model catalog complete within the bounded wait.
The in-memory HTTP cache is deliberately process-scoped. A server restart also
reissues a new OpenChamber generation, so an old HTTP retry fails fencing rather
than being dispatched with a new daemon command.

Activation and every complete replacement snapshot query Prime's
`get_available_models` on the attached connection before publication. The
public snapshot contains at most 256 deduplicated `{provider,id}` model entries
plus bounded display/capability fields and identifies the authoritative current
model separately. Base URLs, auth, compatibility/cost objects, and provider
transport metadata remain private.

New-root create deliberately has no HTTP idempotency or automatic retry. Prime
can lose the correlation between an accepted create and its response across a
supervisor failure, so a transport/protocol failure is reported as uncertain and
the client must inspect the refreshed durable catalog before making another
explicit request. Existing-file activation's exact canonical `create`/reopen
command is distinct: it identifies an already validated durable file and retains
its existing narrow list reconciliation behavior.

## Daemon compatibility and launch

`daemon-protocol.js` implements the official public JSONL supervisor transport.
The first frame must be a compatible handshake with protocol 7, schema revision
13, schema ID `protocol-7-schema-13-816309b1cd50`, and the four required snapshot
capabilities. Command envelopes carry stable OpenChamber-owned client/request
IDs; no Prime alias is accepted from HTTP.

The runtime first connects the official default per-user socket. If it is absent,
explicit creation or activation may launch only an explicitly configured absolute
`PRIME_AGENT_CLI_PATH` or an official `pi`/legacy `prime-agent` executable found
through OpenChamber's augmented login PATH. Launch uses direct argv (`--mode
daemon --daemon-socket ...`), never shell interpolation. Startup, handshake,
requests, frames, snapshot bytes/messages, queued events, reconnect, and output
are bounded. A partial failed launch is terminated. A successful detached public
supervisor follows Prime's durable ownership contract and is not killed by
OpenChamber deactivation.

Every activated session owns an independent supervisor socket attachment. One
session's failure therefore cannot close sibling connections. Feature-route graceful shutdown disposes the retained service before HTTP
server close; a one-shot server `close` hook is the idempotent fallback for
other close/restart paths. Disposal disables reconnect, awaits in-flight
activation/recovery, detaches, and closes every OpenChamber-owned
socket/subscriber.

## Snapshot and event authority

Chunked `session_snapshot_begin/chunk/end` transfers are staged outside the
published cache. The manager accepts one stage at a time and validates:

- public durable session identity and private attachment identity;
- snapshot ID/purpose and attach-response agreement;
- source message count and bounded source bytes;
- exact monotonically ordered chunk indexes with no duplicate/missing chunk;
- end chunk count and message coverage; and
- matching source generation/sequence in the begin header, end frame, and attach
  response.

Only a successful end atomically publishes the normalized snapshot. Old and new
chunks are never mixed. Live events received without a complete baseline are
bounded and held aside. After publication, duplicate events are ignored. A
same-generation forward gap immediately revokes authority but keeps the daemon
socket open for protocol-v7's backpressure catch-up: the triggering event and
bounded suffix are retained, a catch-up must begin within five seconds, and only
a complete matching chunked snapshot can restore authority before the exact
contiguous tail is drained. Timeout, queue overflow, generation/identity change,
invalid framing, disconnect, or failed snapshot falls back to socket replacement
and bounded exponential reconnect. A drain that encounters another gap requeues
its entire unprocessed suffix rather than silently losing events.

Internal session events with no public projection still advance the private
source cursor but do not manufacture public revisions. Growing assistant
`message_update` payloads retain only the latest update in a 50 ms window;
observable lifecycle/status/tool edges flush it first, preserving public order
while preventing high-volume model and child-agent streams from repeatedly
backpressuring the daemon attachment.

Public `generation`, monotonic `revision`, `turn.token`, and freshness fields are
OpenChamber-issued fencing values; Prime's private generation, active-session
alias, worker identity, and socket never cross HTTP. Activity is derived from
snapshot/live-channel state and lifecycle edges, never persisted history. On
staleness it becomes `unknown`, and every future mutation capability fails
closed. After each authoritative assistant `message_end`, one coalesced
`get_session_stats` request refreshes the whitelisted context window and session
totals. A valid response increments the public revision and publishes a full
snapshot; a supplemental stats failure leaves the prior good values intact and
does not revoke otherwise-valid runtime authority.

## Public normalization

Live and cached payloads whitelist only durable session identity, normalized
transcript records/blocks, context usage, current/available model metadata,
thinking levels, tool names, activity, recap, and mutation fencing.
Model base URLs, API/provider transport signatures, headers, model cost/compatibility
objects, response IDs, thought/text signatures, tool-call IDs, arbitrary tool
arguments, paths, private aliases, PIDs, worker IDs, auth material, and raw
errors are omitted. The sole tool-input projection is `ipython` `{ code }`,
treated as transcript content and capped at 64 KiB UTF-8; invalid or oversized
code is explicitly omitted. A paired IPython result may additionally expose only
a 24-hour-capped duration and presentation-safe diff metadata: at most 64 raw
entries, 128 KiB of source per entry, 256 KiB of display patches in total,
512-character relative or basename-only display paths, per-file counts/path
openability, and an omission count. The skill payload contains arbitrary
replacement snippets rather than full file lines, so projected patches are
presentation-only and are never treated as applicable file patches. Paths inside
the catalog-validated working directory are relative/openable for file navigation;
outside paths are basename-only/non-openable. Raw `details`,
old/new fragments, and absolute paths are never copied. Exact edit-confirmation
output is suppressed only when every raw diff was projected; any remaining known
edit paths are rewritten to their safe display form under a bounded sanitization
budget. Non-display custom records and the legacy `<ipython_state>` wrapper are
omitted from passive, snapshot, streaming-record, and event projections. Other
tools remain name-only. Passive and live history use the same focused projector. History and
live-event projections have explicit record/block/text/byte bounds and omission
markers.

## Filesystem boundary

Root session candidates must be direct regular `.jsonl` files in the fixed
session root. Reads use `lstat`, `realpath` containment, no-follow open flags
where supported, inode/device comparison, and post-open `fstat`. The first
physical JSONL line is bounded and must be a Prime session header whose durable
ID is an exact lower-case UUIDv7 and exactly matches the filename.

RLM descendants are discovered only through the current append-only
`rlm-subagents.jsonl` registry layout under the derived `session-artifacts`
root. The latest valid record per child wins and `deleted` records are
tombstones. Registry paths are derived from already validated ancestry; raw
registry paths must exactly match those derived locations before a child is
opened. Node count, depth, directory entries, registry bytes, metadata ranges,
transcript work, line size, context bytes, and passive worker
descriptor/journal work and elapsed time are bounded. One malformed file,
line, registry record, or descendant produces a public issue/omission without
erasing unrelated valid sessions.

Responses never include session or registry file paths, artifact paths, daemon
sockets, PIDs, active-session aliases, RLM child/node IDs, authentication
material, or raw filesystem/runtime errors. Transcript message bodies remain
user-authorized conversation content, but provider response IDs, signatures,
tool-call IDs, and runtime details are stripped.

## Runtime parity

Web and Electron (which reuses the web server) own Phase 2, Phase 3, and Phase 4 backend behavior,
including the OpenChamber-only root-creation HTTP route. Root creation is not a
shared UI TypeScript contract. Shared Phase 2 reads use the required `PrimeAPI`;
hosted and Capacitor clients use the same `runtimeFetch` implementation when
connected to a server exposing these routes.
VS Code deliberately installs a stable `501`/`prime_unsupported` implementation;
Prime requests never fall through its generic OpenCode bridge.

The shared passive catalog and transcript controllers are runtime-keyed and
read-only. Prime working directories remain adapter-private during root owner
resolution, opaque transcript cursors remain controller-private, and selection
publishes a complete neutral chat identity without mutating OpenCode current
session or directory state.
