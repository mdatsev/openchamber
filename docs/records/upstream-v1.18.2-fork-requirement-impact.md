# Upstream v1.18.2 Fork Requirement Impact

- **Type:** record
- **Purpose:** Preserve the independent comparison of the pre-merge custom fork requirements with upstream v1.18.2.
- **When to read:** When reviewing or correcting the v1.18.2 integration, or when revisiting an affected fork requirement.

## Scope

This assessment compares the common upstream base `ce519219` (v1.18.1), the custom pre-merge parent `40176801`, and incoming upstream `da4a61ad` (v1.18.2). The integration commit's resulting tree, diff, and conflict resolutions were intentionally not inspected. Its metadata was used only to identify the two parents.

The evaluated requirements are FC-001 through FC-019 in `40176801:docs/fork-requirements.md`.

## Result

Upstream v1.18.2 does not fully supersede any fork requirement. It provides useful implementation foundations that should replace older mechanisms inside several fork features, but retaining either side wholesale would lose required behavior.

| Requirement | Impact | Independent recommendation |
|---|---|---|
| FC-001 | Direct and semantic conflict | Keep source-run notification-only classification and server-side install refusal. Adopt upstream's official foreground-service updater only outside that boundary. |
| FC-002 | Adjacent | Keep separate app identity, profile, cached bundled launcher, fixed port, and logs; consume upstream's optimized web build. |
| FC-003 | Adjacent | Keep custom window and browser titles; upstream instance URLs are not equivalent branding. |
| FC-004 | Adjacent | Keep diff search, but use upstream's authoritative branch resolution and lazy walkthrough ownership. Measure large-diff search after integration. |
| FC-005 | Strong partial overlap and direct conflicts | Adopt upstream question recovery and reply routing; keep full hidden-descendant scope and question-over-busy precedence. |
| FC-006 | Partial overlap and direct conflicts | Keep the general authoritative interruption classifier; use upstream interrupted-tool finalization as a consequence, after blocker recovery. |
| FC-007 | Partial alternative and direct renderer conflict | Keep background Task nesting. Upstream Work Status lists subagents separately and is not equivalent. |
| FC-008 | Direct conflict | Keep disposable side-chat lifecycle and promotion while rebasing onto lazy ContextPanel ownership, captured sends, and authoritative directory resolution. |
| FC-009 | No material impact | Keep the single-file confirmation unchanged. |
| FC-010 | Adjacent | Keep unrestricted authenticated read policy while adopting upstream symlink handling and typed OS-permission failures. |
| FC-011 | Direct UI conflict | Keep server-backed inbox authority; upstream unread and pins remain client-local. Harden reconnect and missed-completion recovery. |
| FC-012 | Direct conflict | Keep same-session mobile move and dirty-change choices; build on upstream bootstrap waiting, post-checkout hooks, and long-path handling. |
| FC-013 | Direct ownership conflict | Move bounded word highlighting and skipped-line disclosure into upstream's lazy `ToolPartDiffPreview`, not the eager `ToolPart`. |
| FC-014 | Strong partial overlap and direct conflicts | Keep the complete comparison and sidebar goals, but replace the partially integrated commit calculation and compose upstream branch/worktree primitives. |
| FC-015 | Direct conflict | Keep persistent update status while preserving deferred configuration restart. Do not offer a redundant second restart after a successful upgrade. |
| FC-016 | Partial overlap and direct route conflict | Keep the one-external-OpenCode, one-active-surface topology; combine upstream service update, URL reporting, and rebind improvements. |
| FC-017 | Partial overlap and direct conflicts | Keep the parity requirement, but replace per-surface conditionals with one shared indicator model used by Desktop and Mobile Recent. |
| FC-018 | Adjacent | Keep cgroup containment; upstream has no equivalent. Treat explicit OOM reporting as incomplete until systemd OOM state is surfaced and runtime-tested. |
| FC-019 | Direct conflict | Keep the dedicated settings page and worktree-inheritance policy; integrate through upstream's relocated Settings metadata and footer composition. |

## Highest-Risk Interactions

1. Upstream PR #2542 (`e0255cac`) can install and restart a foreground systemd service. Losing FC-001's source-checkout refusal could mutate the wrong installation in the FC-016 topology.
2. Upstream PRs #2682, #2663, and #2699 add question recovery and interrupted-tool cleanup, but do not replace FC-005's descendant-scoped attention or FC-006's general unfinished-turn classification. Recover blocking requests before finalizing interruption.
3. Upstream PR #2742 (`fdcf5c27`) makes rich tool diffs lazy. Keeping the fork's old `ToolPart` wholesale would regress startup work; keeping upstream wholesale would remove FC-013.
4. Upstream's default-branch and worktree fixes improve FC-014 but do not define the same comparison baseline. The requirement compares against the primary worktree's checked-out branch, not a repository default branch.
5. Upstream PR #2585 (`6626d642`) defers configuration restarts. FC-015's upgrade route already restarts managed OpenCode, so a second reload action is redundant and can interrupt another turn.
6. Upstream still treats unread and pins as local UI state. FC-011's server record and revision/token protocol must remain authoritative anywhere upstream adds activity duration or unread presentation.

## Predicted Textual Conflicts

An independent `git merge-tree --write-tree 40176801 da4a61ad` reported 26 unresolved paths: 13 functional files, 3 owning documentation files, and 10 locale catalogs. The functional conflicts cover Mobile Recent and the mobile session sheet, tool rendering, ContextPanel, session sidebar composition, Settings composition, global status, session actions, synchronization context, Desktop bridge types, and system information routes.

Cleanly merged files still contain material semantic interactions, notably FC-001, FC-004, FC-010, FC-014, FC-016, and FC-018. Textual conflict resolution alone cannot establish requirement equivalence.

## Pre-existing Requirement Gaps

1. FC-014's partial-integration fallback can diff from the merge base and re-include earlier commits that `git cherry` classified as patch-equivalent. Root dirty state is shown at the project header rather than every root session row requested by the requirement.
2. FC-017's Mobile Recent implementation omits worktree comparison, pin, persistent error, and the new upstream activity-duration state, so it does not yet meet its explicit future-parity contract.
3. FC-018 propagates command failure status but does not inspect authoritative systemd OOM state or guarantee an explicit OOM message to the agent.

## User Direction After Assessment

On 2026-08-13, the user clarified the following requirements without requesting their immediate implementation:

1. The systemd-managed external OpenCode service must be upgradeable from the fork. Another agent was already implementing this capability.
2. Worktree comparison must let the user choose uncommitted changes, committed changes, or their combined view. Cherry-pick integration is not supported for now.
3. Aggregate command-memory handling needs further design. When an aggregate limit requires selecting a victim, the preferred direction is to kill the most memory-intensive command tree if systemd and cgroup authority make that reliable.
4. FC-007 means nesting the background subagent in the spawning Task summary only; it does not require hiding the child session from navigation.
5. FC-008 intentionally supports web and Desktop only for now. Repeating `/side <prompt>` or `/btw <prompt>` for an existing disposable chat should focus that chat and send the new prompt to it.

## Actual Merge Review

The resulting tree of merge `1d6e7178` was reviewed after the independent assessment. Most requirements were preserved and the merge correctly composed upstream ownership for lazy tool diffs, ContextPanel views, worktree bootstrap, Settings metadata, filesystem failures, service URL reporting, and session activity duration.

Four concrete integration defects remained:

1. Merge-authored terminal-tool checks in `packages/ui/src/hooks/useSessionActivity.ts` and `packages/ui/src/sync/sync-context.tsx` suppress FC-006 whenever an unfinished assistant turn already contains any ordinarily completed or failed tool. An agent that completes a tool and then dies while composing the response is therefore presented as idle instead of interrupted.
2. Upstream's reconnect order was adopted without adapting it to FC-005 and FC-006. The authoritative idle snapshot can finalize a running question tool as interrupted before pending questions and permissions are recovered, after which final-status preservation can retain the false error beside the recovered question.
3. FC-015's Settings updater was retained without adapting its success state to upstream's deferred-restart model. The upgrade endpoint already restarts managed OpenCode, but Settings still presents an obsolete Reload action and leaves any pending restart record stale; following the UI can cause one or two additional restarts.
4. Upstream's `openchamber-routes.test.js` mock was merged without the fork's new `isSourceCheckout` export. All three tests fail before exercising either source-run protection or the upstream systemd update path.

The following gaps were confirmed but were not caused by this merge: large side-chat forks can outlive the fixed route timeout and leave ordinary orphans; case-folded walkthrough search offsets can be wrong for Unicode characters whose lowercase representation changes UTF-16 length; durable inbox state can miss completions while OpenChamber is not observing external OpenCode; Mobile Recent does not yet share all Desktop indicators; and cgroup OOM failures are not explicitly identified to the agent.

## Reconciliation Follow-up

Commit `d7b901fe` corrected all four concrete integration defects above. It also addressed the side-chat timeout orphan, Unicode folded-search offset, Mobile Recent indicator parity, and explicit cgroup/OOM reporting gaps. The durable inbox missed-completion concern remains separate from this integration.

## Evidence

Primary evidence came from the three named Git snapshots, the upstream v1.18.2 commit range, the pre-merge fork requirement document, owning module documentation, and upstream PRs #2424, #2494, #2542, #2585, #2629, #2642, #2663, #2679, #2682, #2695, #2699, #2708, #2721, #2742, #2744, #2746, #2747, #2776, and #2791.

## Follow-up, 2026-08-24

The FC-008 recommendation above records the v1.18.2 assessment and is no longer current. The user approved retiring FC-008 and restoring upstream v1.20 `/btw` as the authoritative behavior. Sessions that still carry the old custom marker surface as ordinary sessions. They are not deleted or migrated.
