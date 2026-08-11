# Incident: OpenCode duplicated responses for nonmonotonic message IDs

- **Type:** record
- **Purpose:** Record why one OpenChamber user prompt could produce two persisted assistant responses without a second user send.
- **When to read:** When assistant responses repeat or a second assistant turn starts immediately after the first turn completes.

## Resolution (TL;DR)

OpenChamber generated optimistic user message IDs from the browser clock and sent those IDs to OpenCode. When that clock was slightly ahead of the server clock, OpenCode 1.18.10 could sort the user ID after its completed assistant ID, mistake the turn for unanswered work, and immediately run the model again. OpenCode fixed the loop in `db581e47`; use OpenCode 1.18.15 or newer rather than trying to deduplicate the rendered messages.

## Status

workaround

## Timeline + investigation

- Session `ses_00efa7e23ffegXrnzJRMr7Rk1W` contained multiple assistant pairs with no user message between them. The second assistant inference started 7-10 ms after the first completed, and both assistants referenced the same parent user message.
- The affected OpenCode server reported version 1.18.10. Its logs recorded separate processing steps and separate assistant message IDs, which rules out a frontend-only rendering duplicate.
- `packages/ui/src/sync/session-actions.ts` generates optimistic ascending IDs with `Date.now()`. `packages/ui/src/lib/opencode/client.ts` passes that ID to `session.promptAsync` as the authoritative user `messageID`.
- For the affected turns, the browser-generated user IDs encoded timestamps 156-318 ms later than the server creation time. The first completed assistant ID therefore sorted before its parent user ID even though the assistant was chronologically newer.
- OpenCode 1.18.10 exited its inference loop only when `lastUser.id < lastAssistant.id`. That condition failed for these cross-clock IDs, so the same prompt loop generated another assistant response.
- Upstream commit [`db581e47`](https://github.com/anomalyco/opencode/commit/db581e47a3a6f4900a6289ad7fddec60fec44e1c) changes the exit condition to verify `lastAssistant.parentID === lastUser.id`. Its regression test is `loop exits for a completed parent turn with nonmonotonic message IDs`.
- The `/grill-me` skill did not send a second prompt. It made the defect conspicuous because each unintended inference produced another interview question. Queue draining, Session Goal, context continuation, provider retry, and scheduled dispatch were ruled out because those paths have different timing or create another user message.
- Upstream commit [`a54a693`](https://github.com/anomalyco/opencode/commit/a54a693af242108b0b5c9db6ae498c10b2d8843b) fixes related chronological-boundary assumptions in revert and fork behavior. OpenChamber still has a similar local optimistic-revert assumption in `packages/ui/src/sync/session-actions.ts`, where it compares message IDs instead of chronological array boundaries.
- At investigation time, npm published OpenCode 1.18.16 and the repository pinned `@opencode-ai/sdk` 1.18.12. Updating the SDK alone does not fix an externally managed OpenCode server; the running server or bundled CLI must contain the upstream loop fix.

Evidence sources: `~/.local/share/opencode/log/opencode.log`, the persisted session message history, `packages/ui/src/sync/session-actions.ts`, `packages/ui/src/lib/opencode/client.ts`, and upstream OpenCode commits `db581e47` and `a54a693`.
