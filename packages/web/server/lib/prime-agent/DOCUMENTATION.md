# Prime Agent Integration

## Purpose

This module owns OpenChamber's Prime Agent adapter. It combines saved-session
catalog and transcript access with an optional interactive daemon connection.
Prime sessions remain outside OpenCode SDK types, sync reducers, stores, and
mutation paths.

## Daemon contract

`runtime.js` speaks Prime Agent's bounded JSONL daemon protocol directly. The
current accepted identity is protocol `7`, schema revision `13`, schema ID
`protocol-7-schema-13-816309b1cd50`. A socket is ready only after a matching
`daemon_hello`; an open socket alone is not authority.

The executable is resolved in this order:

1. `primeAgentBinary` in OpenChamber settings
2. `PRIME_AGENT_BINARY`
3. `prime-agent` through `PATH`

OpenChamber launches `prime-agent --mode daemon --daemon-socket <path>` when no
compatible daemon is already listening. One OpenChamber client can attach to
multiple resident Prime roots concurrently. Closing OpenChamber detaches its
client but does not abort resident work or shut down the shared daemon.
Concurrent transcript/control requests for the same root and canonical path
share one attachment operation; the daemon never receives competing attaches
for that identity. Later requests reuse the current-generation authoritative
attachment until a close, reconnect, event gap, path change, or active-ID
rotation revokes it.

Prime child agents remain Prime-owned sessions. Their durable `sessionId` and
`parentSessionId` form the browser-visible hierarchy; rotating daemon
`activeSessionId` values are routing aliases only. Catalog responses include a
child only when its complete parent chain reaches a saved root whose daemon
path equals OpenChamber's canonical root path. Child filesystem paths and RLM
node IDs are never exposed. Completed children may be **inactive** (their worker
has been released and no active routing alias exists) while their transcript is
still durable and discoverable; this differs from **idle**, which means a
resident worker is attached but has no turn in progress. Selecting an inactive
child reopens its server-authorized artifact as a resident Prime session, then
attaches and waits for its complete chunked snapshot before transcript or
context refresh. Its own events stream independently without injecting it into
OpenCode session state. Root and child authorization comes from the validated catalog
and complete live ancestry rather than requiring a full transcript parse;
actions that target a stored branch entry perform their own full revalidation.

Live attachment authority is scoped to the current daemon socket generation.
Cached messages survive a disconnect for continuity, but they are not served as
live data until the root has attached successfully on the new generation. The
runtime remembers at most 100 recently attached roots and reattaches them after
a compatible reconnect. Root-to-active aliases are one-to-one: active-ID
rotation removes the previous alias, collisions and root mismatches fail closed,
and a returned session file must match the server-owned saved path. This check
also applies before a newly created root receives its initial prompt; rejected
noncanonical roots are killed best-effort. A catalog refresh that observes a
new active ID for an attached saved root revokes the old attachment and schedules
a fresh authoritative snapshot.

Prime events carry `{ generation, sequence }` cursors. Duplicate events and
events from retired generations are ignored. A gap inside the current
generation revokes live authority and requests a full attachment snapshot.
Chunked snapshots are assembled by snapshot ID with contiguous indexes and
verified chunk/message totals. Slim attach responses never install their empty
placeholder over a pending stream; only a complete snapshot becomes live
authority, while disconnect, failure, or an incomplete stream revokes it.

Create, prompt, abort, model selection, thinking-level selection, and session
fork are mutations. Every daemon mutation response is acknowledged with `ack_result`,
including a late response after the browser-facing request timed out. A
disconnect or timeout after dispatch is reported as ambiguous and is never
automatically replayed; a late successful response publishes reconciliation for
the affected attached root. If session creation succeeded before the initial
prompt became ambiguous, the error carries that session identity so the UI can
open it rather than create a duplicate. A fork keeps the daemon's private active
routing alias but creates a new durable root identity. Only an action-scoped
pending fork may perform that rekey. Prime can initially defer an empty branch
to a noncanonical filename, so the runtime records that replacement without
exposing it. Other source mutations are fenced while that private alias belongs
to the pending fork. The runtime exports to an unpredictable same-directory
temporary file, verifies its regular-file header identity, copies it to the
canonical path with no-replace semantics, switches the same private worker to
that canonical file, and only then moves attachment and cache ownership
atomically. Export and switch are part of the same mutation state machine and
any post-fork interruption remains ambiguous; late replacement or mutation
results continue reconciliation and refresh the catalog. Unsolicited
root-identity replacement fails closed.

## HTTP and event contract

The browser-facing API is OpenChamber-owned and versioned independently from
Prime's internal daemon frames:

- `GET /api/prime/status`
- `POST /api/prime/reconnect`
- `GET /api/prime/sessions`
- `POST /api/prime/controls`
- `GET /api/prime/sessions/:sessionId/transcript`
- `POST /api/prime/sessions/:sessionId/attach`
- `POST /api/prime/sessions`
- `POST /api/prime/sessions/:sessionId/prompts`
- `POST /api/prime/sessions/:sessionId/controls`
- `POST /api/prime/sessions/:sessionId/model`
- `POST /api/prime/sessions/:sessionId/thinking-level`
- `POST /api/prime/sessions/:sessionId/fork`
- `POST /api/prime/sessions/:sessionId/abort`

Mutation routes, including explicit attachment, enforce the normal
request-origin gate, bounded text prompts, session ID ownership, and canonical
directory validation. Transcript GET is side-effect free: opening interactive
state uses the attachment POST before refreshing the transcript. Create and
prompt bodies use a route-scoped 5 MB JSON parser so server-wide parser policy
cannot silently discard them. Runtime status exposes only the redacted
`authenticated`, `unauthenticated`, or `unknown` state; it never returns provider
credentials. Runtime and session changes are broadcast through the shared OpenChamber event stream as
`openchamber:prime-runtime-changed` and `openchamber:prime-session-changed`.
The client throttles transcript refreshes during streaming and refreshes
immediately when a session becomes idle. Event-stream readiness is also a
reconciliation edge: clients refetch status, catalog, and the selected
transcript to repair events missed while disconnected.

Stored active-branch user items expose a separate opaque `branchEntryID`; the UI
never parses rendered item IDs or matches prompt text. Fork requests accept only
that entry ID, revalidate that it is still a user entry on the authorized saved
root's active branch, and invoke Prime's native editable fork (`position: before`).
The source transcript remains unchanged; the UI opens the returned new composite
identity and seeds the selected user text into its composer. Live-only rows
without an authoritative saved entry omit the action, as do daemon-unavailable,
currently working, and child-session rows. Prime has no equivalent
to OpenCode's reversible session revert and workspace-diff rollback, so the
shared Revert action is intentionally not wired to a misleading mutation.

Client session ownership is the composite `{ runtimeKey, harness, sessionID }`.
Prime API reads and mutations require that identity, reject runtime mismatch
before dispatch, and reject post-request results after a runtime switch. UI
mutation completions also verify the still-selected composite identity before
clearing prompts or publishing activity, so equal IDs in another runtime or a
newly selected Prime session cannot be retargeted by stale work.

Session controls come from Prime's authoritative `get_connection_state`,
`get_available_models`, and `get_commands` daemon commands. Browser responses
retain only model identity/capability fields and command name, description,
argument hint, and source kind; provider URLs, headers, credentials, and command
source paths are not exposed. Model and thinking mutations return acceptance
after the daemon confirms the mutation, then the client reconciles controls
separately so a later read failure cannot turn an applied mutation into a false
failure. The composer merges discovered commands with Prime's daemon-supported
session commands `/compact`, `/refine`, `/goal`, and `/autonomous`; selecting one
in autocomplete inserts ordinary prompt text, so execution remains Prime-owned.
New-session model and thinking controls come from a bounded, short-lived
in-memory Prime session scoped to the selected directory. That probe is killed
after reading controls and writes no transcript. The chosen provider, model,
and thinking level are passed in the real session's initial runtime config
before its first prompt, so the first turn cannot race a later control mutation.

## Storage fallback

OpenChamber resolves the Prime session directory in this order:

1. `PRIME_AGENT_SESSION_DIR`
2. `PRIME_AGENT_CODING_AGENT_SESSION_DIR`
3. `<PRIME_AGENT_CODING_AGENT_DIR>/sessions`
4. `~/.prime/agent/sessions`

Only regular top-level `.jsonl` files whose header identifies a root session are
listed. An explicit `rlmDepth: 0` is a root even when it records a parent fork;
legacy headers without `rlmDepth` are roots only when `parentSession` is absent.
Browser requests use the session ID and never supply a filesystem path.
Transcript reads enforce the same root constraint and reject symlinks, path
traversal, files larger than 16 MB, malformed records, and unsupported session
versions.

Catalog discovery reads bounded file windows and isolates malformed files so
one bad session does not hide unrelated valid sessions. Metadata is cached per
file identity, overlapping scans share one load, and the final catalog is reused
for at most 10 seconds while the session directory identity is unchanged.
Catalog titles are best-effort: discovery uses the first and last 64 KiB of each
changed file, while opening a transcript resolves metadata from the complete
bounded file. Partial results name selected session IDs whose current metadata
could not be read but whose cached metadata remains eligible. Clients retain
previous metadata only for those IDs; deleted sessions and entries outside the
5,000-session catalog cap are removed. A missing session directory is
`not-configured`; an existing empty directory is authoritative `ready` with no
sessions.

Live daemon summaries augment only saved catalog entries whose daemon-reported
session file equals the canonical configured path. A live-list failure fails the
catalog refresh instead of publishing stored entries as authoritative idle
state; clients retain their prior runtime-scoped catalog and expose Retry.
Authorized live descendants are appended beneath those roots using durable
parent IDs. Completed descendants can disappear from Prime's resident daemon
list, so discovery also reads bounded `rlm-subagents.jsonl` registries beneath
each authorized root artifact directory. Every artifact path, session header,
depth, and complete parent chain is revalidated server-side; deleted, escaped,
missing, malformed, and cyclic rows are omitted. This recursive catalog is what
keeps children of children visible without waking every historical worker, and
artifact paths never cross the browser API boundary.

Transcript reads reconstruct the current Prime branch from entry parent IDs,
including sessions with multiple root branches. Stored responses are bounded to
50,000 source records, 16 MB of source data, 8 MB of rendered text, and 5,000
rendered items. An attached session larger than that remains usable through an
explicit bounded recent live view: the server selects at most 4 MB of recent
message source while retaining full total/branch counts, and omits an individual
oversized message rather than turning the whole session into Unavailable. Live
daemon snapshots take precedence while attached; saved transcripts within the
bounds remain readable when the daemon is unavailable, and a failed refresh
does not erase an already rendered transcript. Stored history is merged with
bounded live snapshots when the fallback is available; identity and near-timestamp
deduplication prevent the same turn from appearing twice.
Failure to read an optional stored fallback never suppresses an already
authoritative live snapshot.

Live snapshots also retain Prime's cumulative assistant content, exact active
content index, and bounded tool execution state. Reasoning and tool-call IDs,
input, output, running/completed/error state, and streamed progress are
normalized into browser DTOs while signatures, arbitrary details, images, and
paths stay server-side. Saved and live custom messages retain their bounded
custom-type label, so records such as `agent_message` have identical
presentation regardless of transcript source. `agent_end.messages` contains
only that run's messages; it merges into the attached transcript and is never
treated as a full-session replacement. The UI refreshes only the selected
working session at the bounded live interval, reuses the shared OpenCode
reasoning/tool presentation, and keeps completed details unmounted until the
user expands them.

Rendered transcript items retain the authoritative model/provider and thinking
level in effect for their source entry. Assistant items also expose Prime's
reported token usage, total cost, and stop reason. Unknown timestamps and
metadata remain `null`; the adapter does not synthesize time, context-window
limits, or usage percentages. When one assistant source entry expands into
multiple rendered text/reasoning/tool items, turn-level usage and stop metadata
attach to one rendered item so aggregate consumers do not double-count them.

## Runtime parity

Web, Electron, hosted mobile, and Capacitor clients use the same server routes.
Native iOS controls Prime through its connected OpenChamber server; it never
launches Prime locally. VS Code returns a stable explicit unsupported result
because its extension host does not use the OpenChamber web server.
