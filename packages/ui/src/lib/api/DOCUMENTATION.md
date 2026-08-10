# Runtime API contracts

- **Type:** reference
- **Purpose:** Shared renderer/runtime capability contracts and parity rules.
- **When to read:** Before adding a `RuntimeAPIs` capability or consuming the passive Prime API.

## Passive Prime

`RuntimeAPIs.prime` is required in every runtime. Web, Electron, hosted web, and
Capacitor use the web implementation, which sends authenticated requests through
`runtimeFetch` and resolves the active runtime at call time. VS Code installs an
explicit stable `501`/`prime_unsupported` implementation; it never falls through
to the generic OpenCode proxy, including for creation.

`PrimeAPI.create` is the one-shot new-root boundary. Its default request is
exactly `{ workingDirectory, message }`. A locally customized draft may instead
add the exact public source fence and selection
`{ sourceSessionId, generation, revision, provider, modelId, thinkingLevel? }`.
Immediately before that configured POST, the client passively GETs the retained
source snapshot and revalidates the selected catalog entries. A newly issued
activation generation may supply the creation fence only when that fresh snapshot
still belongs to the exact source session and authoritatively republishes the
selected model and thinking level; stale cached selections never supply a fence.
A preflight transport or activation failure is reported as a source-refresh
failure before any create request, not as missing configuration or an uncertain
creation. Thinking may be supplied only for the source snapshot's current model;
a different model deliberately uses Prime's default thinking. Responses accept only
`{ schemaVersion: 1, sessionId, accepted: true }`. Clients never retry creation
automatically. `prime_creation_uncertain` means the root may already exist, so
the captured draft remains available and the user must check the session list
before deciding whether to try again. Configuration authority failure occurs
before create and retains the draft without being mislabeled uncertain. Working
directories and source/config selection remain adapter-private creation state;
none is added to `ChatIdentity` or the neutral catalog graph.

The typed status, catalog, transcript-page, and context responses mirror server
schema version 1. Route paths and opaque transcript cursors remain inside runtime
and controller adapters. The neutral catalog stores only durable public identity,
title, ancestry, timestamps, availability, and residency. Prime working
directories are used transiently by the adapter to resolve a root owner and are
not published through `SessionCatalogEntry`, graph, navigation, or presentation
contracts.

Catalog, transcript, context, and snapshot GETs are passive. They never launch,
attach, reopen, activate, or acquire an alias. `activate` is a separate explicit
capability reached by a direct user selection, an accepted user-submitted root
creation, the retained transcript's explicit Enable/Reconnect action, or the
Prime draft's explicit Load options action. That action first refreshes the passive
catalog and ranks a source without activation; only its direct continuation calls
`activate` for the exact chosen session and never changes visible selection.
`deactivate` releases a previously activated live session. Deep-link hydration,
source ranking, GET refreshes, reconnect effects, and passive store loads must
never call either mutation. Protocol v7/schema 13 exposes model catalogs only for
an active session ID, so the UI cannot fabricate a pre-session option catalog.

`openEvents` uses authenticated `runtimeFetch`, not native `EventSource`. It
validates the exact schema-versioned `snapshot`, `event`, `freshness`, and
`closed` envelopes, rejects session mismatches and malformed UTF-8, ignores
comment heartbeats, bounds frame/buffer sizes, and always cancels/releases its
reader. Stream authority is generation/revision contiguous; a disconnect, gap,
or stale freshness requires a complete accepted snapshot before freshness can
be restored.
