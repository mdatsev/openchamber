# Incident: OpenCode ID time prefix rolled over in August 2026

- **Type:** record
- **Purpose:** Record the fixed-width OpenCode ID rollover, its compatibility impact, and remaining OpenChamber risks.
- **When to read:** When newly created messages, parts, sessions, questions, or permissions sort before older entities or disappear from synchronized state.

## Resolution (TL;DR)

OpenCode encodes `Date.now() * 0x1000 + counter` into six bytes, leaving 36 effective timestamp bits. The lexical time prefix rolled from `ffffffffffff` to `000000000000` at `2026-08-14T11:19:55.136Z` and repeats every 795.36 days. OpenCode 1.18.15 and newer removed the most dangerous message-order assumptions, but the generator still wraps and OpenChamber retains rollover-sensitive session and part ordering paths.

## Status

open

## Timeline + investigation

1. The ID body contains 12 hexadecimal time/counter characters followed by 14 Base62 random characters. The random suffix makes full-ID collision during rollover impractical; the incident is a chronology failure, not realistic identifier exhaustion.
2. The six-byte field stores the low 48 bits of a millisecond timestamp shifted left by 12 bits. Its timestamp portion is therefore `Date.now() mod 2^36`, producing rollovers every `68,719,476,736` milliseconds. The previous epoch began at `2024-06-10T02:35:18.400Z`; the next begins at `2028-10-17T20:04:31.872Z`.
3. OpenCode issue [#42570](https://github.com/anomalyco/opencode/issues/42570) confirmed that 1.18.12 could persist a post-rollover user message and then exit its agent loop at step zero because it compared the new low message ID with a pre-rollover high assistant ID.
4. Upstream commit [`db581e47`](https://github.com/anomalyco/opencode/commit/db581e47a3a6f4900a6289ad7fddec60fec44e1c) selects latest messages by creation time and detects a completed turn through the assistant's `parentID`. Commit [`a54a693`](https://github.com/anomalyco/opencode/commit/a54a693af242108b0b5c9db6ae498c10b2d8843b) uses transcript positions for fork and revert boundaries. These fixes shipped in OpenCode 1.18.15 and remain in 1.18.18.
5. Upstream still orders legacy message parts lexically by ID. A single response that produced parts on both sides of the rollover can replay tool calls and text out of order, affect compaction or partial revert boundaries, and render incorrectly. TUI redo and pending permission/question priority also retain narrower lexical-ID assumptions.
6. OpenChamber generates matching optimistic IDs in `packages/ui/src/sync/session-actions.ts` and `packages/ui/src/lib/opencode/client.ts`. Its message ordering normally uses `time.created`, and revert/fork behavior now uses transcript positions.
7. OpenChamber still keeps directory session arrays in lexical ID order and trims index zero as the oldest entity. In a directory at its session limit, a new post-rollover session can be inserted at index zero and immediately removed from directory-scoped state. Moving a post-rollover session can also append it out of lexical order and invalidate later binary searches, allowing stale, missed, or duplicate session records.
8. OpenChamber and upstream still order parts lexically. The part-order impact is localized to a message active across the exact rollover instant; the session-array impact persists while pre- and post-rollover session IDs coexist.
9. Updating the running OpenCode server is required; updating only `@opencode-ai/sdk` does not change server loop behavior. Rewriting persisted IDs is unnecessary for the fixed message loop and is risky because IDs are referenced by parent, part, event, revert, and other records.

Evidence sources: OpenCode `packages/opencode/src/id/id.ts`, OpenCode PRs [#40990](https://github.com/anomalyco/opencode/pull/40990), [#40991](https://github.com/anomalyco/opencode/pull/40991), [#41001](https://github.com/anomalyco/opencode/pull/41001), and [#41006](https://github.com/anomalyco/opencode/pull/41006), OpenCode issue [#42570](https://github.com/anomalyco/opencode/issues/42570), and the current OpenChamber sync implementation.
