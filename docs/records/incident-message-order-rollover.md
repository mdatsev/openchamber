# Incident: OpenCode message ID rollover reordered conversations

- **Type:** record
- **Purpose:** Record the authoritative ordering invariant for OpenCode messages after a long-lived session crossed an ID rollover.
- **When to read:** When changing shared-UI message materialization, pagination, optimistic merges, events, or revert boundaries.
- **Related:** ../fork-requirements.md, incident-opencode-duplicate-responses-from-nonmonotonic-message-ids.md

## Resolution (TL;DR)

OpenChamber orders each session's messages by `info.time.created`, with message ID only as a deterministic tie-breaker. OpenCode message IDs are opaque identities: they can roll over lexicographically during one session, so they must not establish chronology or a revert boundary.

## Status

fixed

## Timeline + investigation

- The exported computer-deal watcher session `ses_005474677ffeeBm5s8Hw9G9ZZP` crossed from `msg_ffff...` to `msg_0001...` while authoritative creation times continued increasing.
- The shared sync layer previously sorted and searched message arrays by ID. After rollover, new Discord turns therefore materialized above older turns even though their creation times were later.
- The fix centralizes chronological comparison in `packages/ui/src/sync/message-ordering.ts` and uses its lower-bound insertion for materialization, loader pages, optimistic insertion, and message events. Existing matching IDs still reconcile by identity.
- Revert visibility, undo/redo, optimistic revert cleanup, rollback, and the reverted-message dock use the chronological message-array position of the authoritative revert marker. A missing marker never implies an ID-based range.
- Part and session collections continue sorting by their IDs where that order is identity-only and does not represent message chronology.

Evidence: exported OpenCode session `ses_005474677ffeeBm5s8Hw9G9ZZP`, user report, and `packages/ui/src/sync/*` ordering paths.
