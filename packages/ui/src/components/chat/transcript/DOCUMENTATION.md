# Transcript boundary

## Ownership

This directory owns the SDK-neutral transcript contract used by the shared chat presentation. `types.ts` defines messages and parts with neutral `kind` discriminants. Transcript renderers, turn projection, retry overlays, streaming-tail projection, and the prompt navigator consume these models rather than OpenCode SDK records.

`openCodeTranscriptAdapter.ts` is the OpenCode boundary. It reads immutable OpenCode message records and projects them once into transcript models. OpenCode-only compatibility rules belong there, including synthetic-part filtering, compaction roles, shell and Task bridges, tool-state payloads, provider errors, summaries, and prompt previews. It must not fabricate SDK `Message` or `Part` values as intermediate display objects.

`openCodeTypes.ts` is the narrow raw-record type used at that boundary. `text.ts` contains presentation-safe text aggregation.

## Invariants

- Presentation modules do not import `@opencode-ai/sdk` or inspect SDK `type`, `info`, `parentID`, or `sessionID` fields.
- Normalize OpenCode data before turn projection and rendering; do not recreate SDK-shaped objects after adaptation.
- Preserve raw records. Bridge enrichment creates updated transcript values only.
- Live parts are adapted into the active transcript message before entering `MessageList`.
- Prompt navigation receives precomputed `{ turnId, preview }` entries and never raw parts.
- Keep virtualization, grouping, streaming phases, animation, tool rendering, and transcript actions behaviorally unchanged when extending the contract.


## Passive transcript controller

`MessageList` provides one neutral `TranscriptMessageActions` capability to
`ChatMessage`. Revert, fork, and context-pin controls exist only when the active
adapter supplies those callbacks; the OpenCode composition root owns its current
handlers. Passive Prime supplies none, so rendering a Prime transcript cannot
enter OpenCode mutation stores. Copying and local tool expansion remain shared
presentation behavior.

The passive Prime controller converts server blocks mechanically into
`TranscriptMessage`/`TranscriptPart`, keeps opaque paging cursors private, and
uses the same `ChatViewport`, `MessageList`, turn projection, virtualization,
prompt navigation, and timeline UI as OpenCode. Its presentation `sessionId` is
the full runtime+harness identity key rather than the durable Prime UUID, which
prevents cross-harness lookups in OpenCode model/context stores. Initial,
earlier-page, context, partial, truncated, and failure state are recorded
separately; a failed refresh or page never erases prior complete records. The
bounded cache keeps the twelve most recently touched passive transcripts.

The shared Context tab projects Prime session totals without SDK fabrication.
Passive values remain limited to exact bounded JSONL derivation; explicit live
authority adds whitelisted input/output/cache totals, monetary cost, current
window limit, and percent from Prime session stats. An assistant `message_end`
triggers a coalesced stats refresh and full authoritative snapshot so the open
tab updates without reselecting the session. Its Raw Messages list is derived
only from already-sanitized neutral transcript records and omits message,
session, parent, call, worker, and path identities from expandable JSON.

A selected passive Prime view stays read-only and publishes no mutation
capability until the user explicitly enables live controls. The retained
transcript always keeps a visible Enable/Reconnect control; activation failure
or a graceful `closed` event returns to that stable read-only state without
removing retained messages or automatically POSTing another activation. Live
mutation eligibility still fails closed immediately during any resynchronization,
but the composer delays its reconnecting notice by 500 ms so an expected
subsecond in-band catch-up does not visibly flicker; a sustained outage remains
explicit.

The retained-transcript warning is reserved for transcript availability failure
or transcript issue codes other than `prime_transcript_truncated` and
`prime_transcript_messages_omitted`. Context availability/issues never feed it,
normal `hasOlder` pagination never feeds it, and bounded omissions already
represented by inline placeholders do not get a duplicate global warning.

## Prime chronology and tool projection

Prime assistant records are linked to the most recent preceding user over the
complete retained list. If the bounded recent page starts in the middle of a
long turn, the adapter inserts one empty `synthetic`/`userMessageMarker` neutral
anchor so leading assistant activity renders immediately; zero visible parts
keep it out of the UI. Every prepend strips synthetic anchors, relinks the full
list, and either binds to the newly revealed real user or creates a new anchor
only for any still-orphaned leading activity.

Prime tool-result records remain hidden as standalone messages. The adapter
pairs each result by normalized name and in-turn order with the preceding
unmatched tool call, then writes output/error and authoritative end time into
that shared `TranscriptToolPart`. Pairing is recomputed after prepend and live
tail overlay and never crosses a user-turn boundary, preserving
thinking → input → output/error → later activity → final-answer chronology.

The public input contract exposes only a valid bounded `ipython` `{code}`;
invalid/oversized input is marked omitted, and every other tool remains
name-only. A paired result may carry only the bounded, presentation-safe IPython
metadata projected by the server: duration, capped relative/basename-only diff
paths, display-only snippet patches, counts, path openability, and an omission
count. The raw edit skill does not provide complete file-line context, so these
patches are never offered as applicable file diffs. Raw daemon details, source
fragments, and absolute paths never enter the browser contract.
`ToolPart` handles `ipython` generically: shared `IPython` metadata, a bounded
meaningful-effect preview while collapsed, nonblank line counts and duration,
Python syntax highlighting by default, a `Bash` row label, setup-skipping command
preview, and Bash highlighting when the first content line is `%%bash`, grouped
per-file `+A -R` summaries, and
expanded shared diff views. Exact redundant edit confirmations are suppressed
only when all diffs were safely projected; non-openable basename-only files have
no file action. No Prime-specific renderer exists.

Prime live snapshots use the same viewport, list, messages, tools, timeline,
and full `ChatIdentity` keys. Durable passive branch history, its opaque older
cursor, and its completeness remain authoritative during activation. The live
adapter content-matches the last durable record and overlays only the subsequent
completed tail plus the active streaming record; compacted model context never
replaces durable history or claims that older pages are complete. Older passive
pages may still prepend while live, after which the tail is re-anchored and
pairing is recomputed.

An explicitly activated root mounts the shared
Prime composer controller; fresh idle authority enables send only with text,
working authority exposes stop, and stale freshness keeps the composer visible
with an explicit reconnecting status while mutation controls remain disabled.
A passive Prime deep link always wins the OpenCode no-session auto-draft race:
identity selection closes an existing draft, and `ChatContainer` closes any
automatic fallback that was opened from an earlier render before routing became
visible. This correction changes presentation only and never activates Prime.

