# Upstream PR candidate audit, 2026-08-27

- **Type:** record
- **Purpose:** Assess each active custom-fork requirement as a potential upstream contribution using current code, public demand, scope, and maintenance evidence.
- **When to read:** Before proposing an active fork requirement to `openchamber/openchamber` or deciding that upstream has replaced it.
- **Related:** ../fork-requirements.md, ../intent.md, upstream-v1.20.0-fork-requirement-impact.md

## Basis and method

This audit compared `custom` at `2f67eff3480668d136cbc99602fd7ccbc0c6f170` with fetched `upstream/main` at `926ae48b603135633f0e3c6aec057cf978c6388c`, dated 2026-08-26. GitHub issue and pull-request status was checked on 2026-08-27. FC-008 is omitted because it was retired after upstream v1.20 `/btw` became authoritative.

Demand grades distinguish exact requests from adjacent complaints:

1. **Strong:** multiple independent reports, duplicates, reactions, or an active accepted direction.
2. **Moderate:** at least one direct request plus independent adjacent evidence.
3. **Weak:** no direct request, or only one lightly supported request or precedent.
4. **None found:** completed searches found no independent public request. This does not prove no request exists outside GitHub.

The recommendation evaluates the smallest plausible upstream change. It does not assume the current fork implementation is the correct design.

## Summary

| ID | Current upstream status | Demand | Narrow upstream change | Recommendation |
|---|---|---|---|---|
| FC-001 | Fork-specific updater exposure | None found | Packaged-runtime authorization hardening only | Keep fork-only as written |
| FC-002 | Fork installation workflow | None found | No demonstrated generic need | Keep fork-only |
| FC-003 | Generic instance distinction solved | None for fork branding | None | Already solved generically |
| FC-004 | Real walkthrough-search gap | Weak adjacent | Yes, after shortcut/design agreement | Discuss first |
| FC-005 | Basic question visibility solved; precedence gap remains | Strong general, moderate residual | Yes | Pursue narrowed residual |
| FC-006 | Core interruption recovery solved; navigation marker absent | Strong core, moderate residual | Yes | Core solved; discuss marker |
| FC-007 | Background Task omission in Task-local summary | Weak exact, strong adjacent | Yes | Seek UX support first |
| FC-009 | Real file-revert confirmation gap | Weak exact, accepted precedent | Yes | Pursue after covering every entry point |
| FC-010 | Deliberate scoped-grant boundary | Low exact, moderate adjacent | Opt-in readable roots, not unrestricted access | Do not upstream bypass |
| FC-011 | Real cross-client inbox gap | Moderate | Yes, in stages | Discuss and align with active PR |
| FC-012 | Shared move engine exists; mobile action absent | Low exact, moderate adjacent | Yes | Pursue |
| FC-013 | Intraline highlighting disabled upstream | None found | Minimal native renderer option | Do not upstream current design |
| FC-014 | Real worktree comparison/status gap | Moderate | Summary-first subset only | Discuss before implementation |
| FC-015 | Real updater bug in upstream and custom | Strong for bug, weak for fork supervisor | Yes | Highest-priority narrow fix |
| FC-016 | Fork deployment topology | Low adjacent | Security fix belongs in fork | Keep fork-only |
| FC-017 | Mobile has activity/unread but lacks broader parity | Moderate | Local-state indicators first | Pursue after overlapping PRs settle |
| FC-018 | Real command-resource gap, primarily in OpenCode | Limited direct OpenCode demand | Not as one portable PR | Discuss with OpenCode |
| FC-019 | Fork setting is bypassed by newer Chat semantics | None exact | General destination policy only after product decision | Do not upstream as framed |
| FC-020 | Restore exists; restore-before-send absent | Strong for restore, none exact for send | Yes | Pursue narrow send gate |
| FC-021 | Android composer symptom fixed; broader viewport gaps remain | Strong general, moderate residual | Yes, split by behavior | Pursue residual pieces |
| FC-022 | Upstream recovery is partial; fork still loses switched-chat attachments | Strong | Yes, staged by state owner | Pursue after correcting ownership |
| FC-023 | CodeMirror still blocks OS dictation | Moderate general, weak exact mobile scenario | Yes, with explicit trade-off | Discuss with device evidence |

## Feature assessments

### FC-001: Disable upstream updates

1. **Gap:** This is caused by the fork's copied packaged Electron runtime. Upstream correctly updates official packaged applications, but some updater gates use raw `app.isPackaged` even when `OPENCHAMBER_ELECTRON_DEV=1` marks the runtime as development. The fork therefore needs protection, but ordinary upstream users do not have the fork's manual-merge lifecycle.
2. **Demand:** None found for copied custom applications avoiding the official update feed. [Issue #1861](https://github.com/openchamber/openchamber/issues/1861) and [PR #2180](https://github.com/openchamber/openchamber/pull/2180) concern web/CLI updates, not this case.
3. **Narrow option:** A small upstream hardening change could define one authoritative packaged-runtime predicate and use it for every updater gate. Fork-specific notification and manual-merge copy should remain out.
4. **Verdict:** Keep FC-001 fork-only as written. A separate updater authorization hardening PR is technically reasonable but has no demonstrated community demand. Confidence: high.

### FC-002: Install the fork alongside the official application

1. **Gap:** This is a fork distribution requirement, not an upstream product omission. Upstream already separates ordinary development browser state; it does not promise installation of arbitrary source checkouts as separately identified applications.
2. **Demand:** None found. [Issue #349](https://github.com/openchamber/openchamber/issues/349) concerned multiple windows and servers, not side-by-side installed application identities.
3. **Narrow option:** No convincing generic PR exists without making upstream support a new source-checkout distribution workflow across macOS, Linux, and Windows.
4. **Verdict:** Keep fork-only. Confidence: high.

### FC-003: Distinguish fork instances

1. **Gap:** The generic problem is solved. Upstream window titles include project and remote-instance context through merged [PR #529](https://github.com/openchamber/openchamber/pull/529), which addressed [issue #349](https://github.com/openchamber/openchamber/issues/349).
2. **Demand:** No independent demand exists for the literal `OpenChamber CUSTOM` branding. Closed [PR #2873](https://github.com/openchamber/openchamber/pull/2873) was an accidental upstream submission of fork branding.
3. **Narrow option:** None needed. A build-time product-name abstraction would add maintenance without an upstream use case.
4. **Verdict:** Mark the general need solved upstream; retain the one-line fork label locally. Confidence: high.

### FC-004: Search the Changes Walkthrough

1. **Gap:** Real. Current upstream walkthrough code has no query, matching, highlighting, or result navigation.
2. **Demand:** No exact issue was found. [Issue #2401](https://github.com/openchamber/openchamber/issues/2401) and open [PR #2697](https://github.com/openchamber/openchamber/pull/2697) provide weak adjacent evidence for search in rendered content. Open [PR #3092](https://github.com/openchamber/openchamber/pull/3092) currently overlaps `WalkthroughView.tsx` without adding search.
3. **Narrow option:** Use the centralized shortcut registry from merged [PR #2532](https://github.com/openchamber/openchamber/pull/2532), define contextual `mod+f` ownership, and add search without transplanting the fork's capture-phase global listener or broad component changes.
4. **Risks:** Patch parsing, Unicode case folding, collapsed sections, split/unified views, keyboard accessibility, and large-walkthrough performance need focused evidence.
5. **Verdict:** Discuss first. The gap is certain, but demand and shortcut ownership are not. Confidence: medium-high.

### FC-005: Show when an agent needs input

1. **Gap:** Partially solved. Merged [PR #2682](https://github.com/openchamber/openchamber/pull/2682) closed [issue #2634](https://github.com/openchamber/openchamber/issues/2634) and added pending-question counts, including collapsed descendant scope. Upstream can still present a parent as busy while a hidden child is blocked, and not every activity consumer gives descendant blockers precedence.
2. **Demand:** Strong for pending-question visibility through [issue #2019](https://github.com/openchamber/openchamber/issues/2019) and [issue #2634](https://github.com/openchamber/openchamber/issues/2634). Demand is moderate for exact question-over-busy precedence and weaker for every hidden-descendant case.
3. **Narrow option:** Extend upstream's keyed blocker-scope selector and apply explicit question/permission-over-busy precedence in shared activity consumers. Do not port the fork's complete indicator architecture or rewrite raw OpenCode status.
4. **Risks:** Live question/permission stores must remain authoritative. Recovery failure must not become authoritative empty state. Runtime changes, replies, rejection, deletion, and archive must clear projections.
5. **Verdict:** Rewrite FC-005 as the residual precedence gap and pursue that focused PR. Confidence: high.

### FC-006: Show when an agent was interrupted

1. **Gap:** Core behavior is solved. Merged [PR #2699](https://github.com/openchamber/openchamber/pull/2699) addressed [issue #2577](https://github.com/openchamber/openchamber/issues/2577) by materializing settled unfinished turns as interrupted. Merged [PR #3002](https://github.com/openchamber/openchamber/pull/3002) addressed managed-restart interruption from [issue #2943](https://github.com/openchamber/openchamber/issues/2943). Upstream still lacks a durable sidebar or tray marker.
2. **Demand:** Strong for visible terminal interruption and avoiding stale busy state. [Issue #2019](https://github.com/openchamber/openchamber/issues/2019) also asks for stopped state. Demand is only moderate for a persistent navigation marker.
3. **Narrow option:** Project existing authoritative aborted/error state into a keyed navigation marker, clearing it on resumed activity, terminal replacement, deletion, and runtime change. Do not add another interruption finalizer or infer from arbitrary old history.
4. **Overlap:** Open [PR #2641](https://github.com/openchamber/openchamber/pull/2641) and [PR #2882](https://github.com/openchamber/openchamber/pull/2882) overlap stranded-turn recovery.
5. **Verdict:** Treat core FC-006 as upstream-solved. Discuss only the residual navigation marker. Confidence: high on status, medium on demand.

### FC-007: Show a background subagent under its spawning agent

1. **Gap:** Narrow and real. Upstream already renders child-session activity inside a Task summary, but deliberately excludes nested Task entries. The fork includes only Tasks explicitly marked `background`.
2. **Demand:** No exact independent request was found. [Issue #2230](https://github.com/openchamber/openchamber/issues/2230), [issue #2521](https://github.com/openchamber/openchamber/issues/2521), and merged [PR #2776](https://github.com/openchamber/openchamber/pull/2776) establish strong demand for subagent observability, but not Task-local nesting.
3. **Narrow option:** Change only the Task summary projection to include authoritative background Task entries, with tests for metadata/input variants and foreground exclusion. Avoid inferred parentage or recursive session UI.
4. **Overlap:** Open [PR #2861](https://github.com/openchamber/openchamber/pull/2861) and [PR #1664](https://github.com/openchamber/openchamber/pull/1664) overlap background activity and broader observability.
5. **Verdict:** Technically suitable and narrow, but create a concrete UX issue first because exact demand is weak. Confidence: high on code gap, low-to-medium on demand.

### FC-009: Prevent accidental file reverts

1. **Gap:** Real. Upstream individual-file revert entry points can execute immediately. The fork confirms from `ChangesPanel`, but another `DiffView` entry point still bypasses confirmation, so FC-009 is incomplete locally.
2. **Demand:** No exact independent request was found. Merged [PR #1390](https://github.com/openchamber/openchamber/pull/1390) establishes accepted precedent for confirmation before folder-level discard.
3. **Narrow option:** One shared file-revert confirmation flow used by every interactive file-level entry point. Keep the Git mutation API noninteractive and unchanged.
4. **Risks:** Bind confirmation to the displayed path and current Git state, block duplicate execution, report async failure, and preserve keyboard-safe cancel-first dialog behavior.
5. **Verdict:** Reasonable safety PR despite weak direct demand, but do not submit the incomplete fork implementation. Confidence: high on gap, medium on acceptance.

### FC-010: Allow viewing files outside the workspace

1. **Gap:** This is an intentional upstream security boundary, not an accidental omission. Upstream permits exact-path, expiring desktop grants for external reads. The fork bypasses grants for authenticated `stat`, `read`, and `raw` requests.
2. **Demand:** Low for unrestricted access. [PR #1984](https://github.com/openchamber/openchamber/pull/1984) addressed related workspace failures but was closed as an unsafe catch-all. [Issue #3031](https://github.com/openchamber/openchamber/issues/3031) and merged [PR #3078](https://github.com/openchamber/openchamber/pull/3078) support reliable grant renewal, not removal. [Issue #3019](https://github.com/openchamber/openchamber/issues/3019), [issue #2523](https://github.com/openchamber/openchamber/issues/2523), and [issue #605](https://github.com/openchamber/openchamber/issues/605) are adjacent path/symlink reports.
3. **Narrow option:** Discuss a server-owner opt-in allowlist of additional readable roots, retaining canonical paths, separate read scopes, and deny-by-default behavior.
4. **Risks:** The fork makes ordinary web credentials sufficient to read SSH material, service credentials, and any other process-readable file. That is a major threat-model change for remote or shared servers.
5. **Verdict:** Do not upstream the unrestricted bypass. Confidence: high.

### FC-011: Synchronize inbox state across clients

1. **Gap:** Real. Upstream pins and unread state remain client-local at the audited revision.
2. **Demand:** Moderate. Open [PR #2339](https://github.com/openchamber/openchamber/pull/2339) directly addresses cross-client read status. [Issue #858](https://github.com/openchamber/openchamber/issues/858) and open [PR #2029](https://github.com/openchamber/openchamber/pull/2029) request manual unread. [Issue #2918](https://github.com/openchamber/openchamber/issues/2918) directly identifies device-local pins as a mobile parity problem. [Issue #2052](https://github.com/openchamber/openchamber/issues/2052) is adjacent local pin-persistence evidence.
3. **Narrow option:** Align with #2339 and land cross-client read receipts first. Decide pin ownership separately. Preserve the fork's useful observed-token idea so a stale read acknowledgement cannot clear a newer completion.
4. **Risks:** The fork's combined protocol adds a versioned persistence file, migration, events, and whole-snapshot rewrites without focused tests, record validation, eviction, corruption recovery, or cross-process locking.
5. **Verdict:** Discuss and contribute incrementally; do not submit the 39-file fork subsystem wholesale. Confidence: high on gap, medium on design.

### FC-012: Move a mobile chat to a new worktree

1. **Gap:** Real but narrow. Upstream already owns the migration engine and desktop action; the default mobile sessions sheet does not expose it.
2. **Demand:** No exact issue was found. Open [PR #2998](https://github.com/openchamber/openchamber/pull/2998) expands move behavior but does not add the default mobile entry point. [Issue #2301](https://github.com/openchamber/openchamber/issues/2301), [issue #2935](https://github.com/openchamber/openchamber/issues/2935), and [issue #2293](https://github.com/openchamber/openchamber/issues/2293) provide moderate adjacent demand for mobile worktree/session actions. #2935 also documents swipe-versus-drawer gesture conflicts.
3. **Narrow option:** Add an explicit mobile overflow action that reuses upstream eligibility, dialog, and move coordinator unchanged. Avoid another swipe action.
4. **Risks:** Validate idle/root/Git eligibility, runtime switching, dirty-source choices, descendant movement, rollback, accessibility, and operation progress.
5. **Verdict:** Pursue. It is a small UI parity contribution with no new persisted or server contract. Confidence: high.

### FC-013: Highlight changed words in patch previews

1. **Gap:** Real. Upstream configures a 1,000-character line-diff cap but explicitly disables intraline highlighting.
2. **Demand:** None found for changed-word tool-preview highlighting or a long-line skip indicator. [Issue #3023](https://github.com/openchamber/openchamber/issues/3023), [issue #2820](https://github.com/openchamber/openchamber/issues/2820), and merged [PR #2742](https://github.com/openchamber/openchamber/pull/2742) show strong concern for diff reliability and performance, not this feature.
3. **Narrow option:** First test Pierre's native `word-alt` option with the existing cap. If disclosure is needed, use one stable notice above the preview rather than injecting markers into Pierre's shadow DOM.
4. **Risks:** The fork parses and rewrites patch metadata, scans shadow-DOM internals, duplicates integration, and has no aggregate patch-size bound or measured performance evidence.
5. **Verdict:** Do not upstream the current implementation. Discuss or prototype only after maintainer interest. Confidence: medium-high.

### FC-014: Worktree diff improvements

1. **Gap:** Real. Upstream has default-branch and arbitrary range diff, including merged [PR #2572](https://github.com/openchamber/openchamber/pull/2572), but lacks primary-worktree comparison, combined committed/uncommitted layers, checkout indicators, and compact checkout rows.
2. **Demand:** Moderate. [Issue #2535](https://github.com/openchamber/openchamber/issues/2535) has reactions and requests branch-to-branch comparison. Open [issue #3129](https://github.com/openchamber/openchamber/issues/3129) directly requests unpushed commits, full diff, and an ahead indicator. No request exactly matches the fork's complete linked-worktree model.
3. **Narrow option:** Start with a comparison summary endpoint containing base ref, ahead count, dirty state, and changed-file count. Reuse existing range-diff for details. Add one indicator separately.
4. **Risks:** Detached HEAD, squash/cherry-pick equivalence, directory authorization, mobile request fan-out, Git command cost, and VS Code capability differences all need explicit treatment. Open [PR #3166](https://github.com/openchamber/openchamber/pull/3166) overlaps worktree discovery performance.
5. **Verdict:** Keep the complete behavior in the fork. Discuss a summary-first upstream contract rather than porting FC-014 wholesale. Confidence: high.

### FC-015: Update OpenCode in Settings

1. **Gap:** Real and currently broken in both upstream and custom. The UI sends an empty body to OpenCode `/global/upgrade`, while current OpenCode requires `target`, causing HTTP 400 before the custom supervised restart path runs.
2. **Demand:** Strong for the correctness bug. Open [issue #3121](https://github.com/openchamber/openchamber/issues/3121) reproduces the exact failure and successful target-bearing control request. [Issue #2541](https://github.com/openchamber/openchamber/issues/2541), merged [PR #2542](https://github.com/openchamber/openchamber/pull/2542), merged [PR #2585](https://github.com/openchamber/openchamber/pull/2585), and [issue #1947](https://github.com/openchamber/openchamber/issues/1947) establish adjacent demand for safe updater/restart behavior. Exact demand for the fork's external-systemd supervisor is weak.
3. **Narrow option:** Resolve the latest semantic version, require or supply `target` server-side, forward `{ target }`, and preserve nested error messages. Keep lifecycle redesign out.
4. **Risks:** Validate real OpenCode upgrade success and failure, active-agent behavior, runtime switching, nested error payloads, and status after toast dismissal. The custom supervisor cannot protect direct clients that bypass OpenChamber.
5. **Verdict:** Highest-priority upstream candidate, scoped strictly to #3121. Fix the same bug in custom. Keep external-systemd supervision fork-only unless demand appears. Confidence: very high.

### FC-016: Switch between official and fork servers

1. **Gap:** This is a Linux systemd and Tailscale fork topology, not a general upstream runtime gap.
2. **Demand:** No exact request found. [Issue #2033](https://github.com/openchamber/openchamber/issues/2033) and open [PR #2485](https://github.com/openchamber/openchamber/pull/2485) concern remote managed-OpenCode restart, not switching official and custom OpenChamber deployments.
3. **Narrow option:** None upstream. The fork should retain its explicit unit names, ports, checkout, health checks, lock, and rollback.
4. **Security:** The current Tailnet switch controller accepts state-changing JSON without authentication, CSRF token, Origin validation, or Content-Type enforcement. A cross-origin request can trigger a switch even though CORS prevents reading the response.
5. **Verdict:** Keep fork-only and fix the controller's CSRF boundary locally before wider use. Confidence: high.

### FC-017: Show Desktop Recent indicators on Mobile

1. **Gap:** Partially solved. Upstream Mobile Recent already shows authoritative activity and unread state, but not the desktop question, permission, interruption, persistent-error, goal, Git, or PR indicators.
2. **Demand:** Moderate. [Issue #2565](https://github.com/openchamber/openchamber/issues/2565), [issue #2384](https://github.com/openchamber/openchamber/issues/2384), [issue #359](https://github.com/openchamber/openchamber/issues/359), and [issue #2918](https://github.com/openchamber/openchamber/issues/2918) request mobile/desktop status and pin parity. Open [PR #2828](https://github.com/openchamber/openchamber/pull/2828), [PR #2962](https://github.com/openchamber/openchamber/pull/2962), and [PR #2249](https://github.com/openchamber/openchamber/pull/2249) overlap these rows and states. There is no evidence for copying every present and future desktop indicator.
3. **Narrow option:** Share only local authoritative leading-state priority first: question, active, unread, pinned, and permission. Keep mobile rendering density separate. Exclude Git/PR and interruption initially.
4. **Risks:** Priority collisions, translations, large text, non-color accessibility, reduced motion, and per-row Git/network request cost require evidence.
5. **Verdict:** Pursue a local-state-only parity PR after overlapping mobile PRs settle. Keep expensive Git/PR indicators fork-only pending demand and profiling. Confidence: high.

### FC-018: Limit memory used by agent commands

1. **Gap:** Real, but primarily owned by OpenCode where command processes launch. OpenChamber upstream has no cgroup or cross-platform process-resource contract.
2. **Demand:** No direct OpenChamber request found. Open [OpenCode issue #37597](https://github.com/anomalyco/opencode/issues/37597) directly reports a Node test subprocess exhausting host memory and requests process-tree resource limits, including Windows. Recognition is real but limited.
3. **Narrow option:** Discuss separate OpenCode contracts for process-tree ownership, per-tool limits, bounded output/event persistence, platform enforcement, and kill diagnostics. A measured output-persistence safeguard may be independently PR-sized.
4. **Risks:** The fork implementation is Linux, cgroup v2, user-systemd, procfs, and shell specific. `SIGKILL` can leave command-side writes partial. Output caps can alter command behavior. Aggregate arbitration does not guarantee OpenCode survives.
5. **Verdict:** Do not submit the custom scripts as an OpenChamber PR. Discuss the problem with OpenCode and preserve the Linux containment locally. Confidence: high.

### FC-019: Keep fork-only preferences separate

1. **Gap:** The dedicated fork settings page is correctly fork-owned. The current-worktree preference is now bypassed for most normal web, desktop, and mobile New Chat paths because upstream intentionally defaults implicit New Chat to projectless managed Chat. The preference may still affect VS Code, creating inconsistent behavior.
2. **Demand:** No exact request found for choosing current worktree versus primary checkout. [Issue #1748](https://github.com/openchamber/openchamber/issues/1748), [issue #2376](https://github.com/openchamber/openchamber/issues/2376), and [issue #2293](https://github.com/openchamber/openchamber/issues/2293) establish adjacent worktree-routing pain, not this preference.
3. **Narrow option:** First decide whether managed Chat remains the default, which entry points the preference governs, whether explicit directory choices override it, and whether VS Code intentionally differs. A generalized upstream default-destination preference is possible only after that decision.
4. **Risks:** Wrong-directory routing can modify the wrong branch or environment. The setting has no test matrix and was silently invalidated by a newer upstream model.
5. **Verdict:** Do not upstream FC-019 as framed. Resolve product semantics and repair or retire the local behavior separately. Confidence: very high.

### FC-020: Resume archived sessions through messaging

1. **Gap:** Partial. Merged [PR #2616](https://github.com/openchamber/openchamber/pull/2616) addressed [issue #2346](https://github.com/openchamber/openchamber/issues/2346) and added restore plus archived search results. Upstream message routing still dispatches prompt, slash-command, or shell input without restoring first.
2. **Demand:** Strong for restore itself, but no direct request was found for restore-before-send. Open [OpenCode issue #24153](https://github.com/anomalyco/opencode/issues/24153) and [OpenCode PR #43919](https://github.com/anomalyco/opencode/pull/43919) address clean server-side unarchive semantics.
3. **Narrow option:** Add one shared pre-dispatch restore gate using existing OpenChamber restore infrastructure. Abort dispatch on restore failure and preserve the draft. Coordinate with OpenCode's server fix rather than duplicating it.
4. **Risks:** Test prompt, slash, shell, restore refusal, runtime change, already-active sessions, stale global state, and the race where another client rearchives between restore and send. Dedicated mobile currently cannot discover archived sessions and should be scoped separately.
5. **Verdict:** Pursue a narrow PR. It composes existing upstream capabilities and closes a data-preserving lifecycle hole. Confidence: high.

### FC-021: Keep hosted mobile above the keyboard

1. **Gap:** Partially solved. Upstream commits [e23ec3f0](https://github.com/openchamber/openchamber/commit/e23ec3f093a3fefa6d548bfc90a5dbb84f864601) and [18750a5f](https://github.com/openchamber/openchamber/commit/18750a5f2118a72fbc655a4e927f56a39b624a8a) fixed the reported Android composer symptom from [issue #3114](https://github.com/openchamber/openchamber/issues/3114). Broader hosted-browser fullscreen geometry and live transcript-space reservation remain different from the fork.
2. **Demand:** Strong for keyboard occlusion generally through #3114, closed [PR #3115](https://github.com/openchamber/openchamber/pull/3115), merged [PR #1303](https://github.com/openchamber/openchamber/pull/1303), merged [PR #1370](https://github.com/openchamber/openchamber/pull/1370), and open [issue #2287](https://github.com/openchamber/openchamber/issues/2287). Demand is moderate for each exact residual.
3. **Narrow option:** Split entrypoint viewport metadata, body-level visual-viewport sizing, and fixed-composer space reservation into separate changes. Trigger pinning from observed occlusion if possible rather than Android user-agent detection or unconditional iOS behavior.
4. **Risks:** Physical Firefox/Chrome Android, PWA, iOS Safari/PWA, fullscreen surfaces, long composer growth, orientation, floating keyboards, accessibility, and Capacitor non-regression need recordings. The fork's final Firefox fix was not physically reverified.
5. **Verdict:** Pursue residual pieces, not the complete fork diff. Confidence: high.

### FC-022: Preserve failed message submissions

1. **Gap:** Real and partial upstream recovery already exists for text, inline drafts, and some attachments. Confirmed mentions and queued messages remain incomplete, and global attachment ownership can overwrite or lose state after a chat switch.
2. **Demand:** Strong. Open high-priority data-loss [issue #1792](https://github.com/openchamber/openchamber/issues/1792), open [PR #1868](https://github.com/openchamber/openchamber/pull/1868), open [PR #3154](https://github.com/openchamber/openchamber/pull/3154), [issue #2072](https://github.com/openchamber/openchamber/issues/2072), open [PR #3082](https://github.com/openchamber/openchamber/pull/3082), and open [PR #3055](https://github.com/openchamber/openchamber/pull/3055) all establish active concern around loss, durable queues, and ambiguous sends.
3. **Fork defect:** The fork correctly captures target identity and merges text, mentions, queues, and inline drafts, but composer attachments remain global. If the user switches chats before failure, original-chat attachments have no per-chat draft owner and are dropped. FC-022 is therefore not fully satisfied locally.
4. **Narrow option:** Incrementally add mention snapshots, exact queue restoration, and command-failure recovery to current upstream. Handle per-chat attachment ownership as a separate contract. Preserve upstream ambiguous-send confirmation so recovery does not cause duplicate responses.
5. **Risks:** Test same/switched chat, new/existing session, runtime switch, hard/soft/413/ambiguous failures, every draft component, concurrent edits while pending, queue order/identity, reload, and late success acknowledgement.
6. **Verdict:** Strong upstream candidate after correcting attachment ownership and coordinating with active PRs. Confidence: very high.

### FC-023: Support native mobile dictation

1. **Gap:** Real. Merged [PR #2419](https://github.com/openchamber/openchamber/pull/2419) moved the composer to CodeMirror. Open [issue #3041](https://github.com/openchamber/openchamber/issues/3041) identifies the managed `contenteditable` prompt as the structural difference preventing OS Voice Access. Upstream still uses CodeMirror on mobile.
2. **Demand:** Moderate for OS dictation generally through #3041. Merged [PR #2691](https://github.com/openchamber/openchamber/pull/2691), open [PR #2510](https://github.com/openchamber/openchamber/pull/2510), and [issue #2518](https://github.com/openchamber/openchamber/issues/2518) show adjacent CodeMirror IME, autocorrection, and caret problems. No direct upstream report was found for the exact continuous Gboard-from-empty scenario.
3. **Narrow option:** A native textarea on mobile is the most reliable compatibility approach but intentionally gives up mobile syntax highlighting and creates two editor implementations. An optional native composer across runtimes would address desktop Voice Access too but adds settings and support cost.
4. **Risks:** The fork has no final device recording. Its native editor approximates caret coordinates, has different paste metadata, and loses selection/undo/composition state when recreated. Physical Gboard, Siri dictation, Android/iOS hosted and Capacitor, accessibility, IME, autocorrection, and external keyboard tests are required.
5. **Verdict:** Discuss the highlighting-versus-native-input trade-off first and attach physical-device evidence. Confidence: high on cause, medium on exact demand.

## Recommended contribution order

1. **FC-015 updater target bug:** smallest change, exact reproduction, strong demand, and broken in both upstream and custom.
2. **FC-022 failed-submission recovery:** strongest data-loss case, but first fix per-chat attachment ownership and coordinate with active queue/recovery PRs.
3. **FC-005 residual blocker precedence:** builds on merged upstream question infrastructure and has strong user support.
4. **FC-020 restore-before-send:** narrow composition of existing restore and routing behavior; exact demand is weak but failure behavior is clear.
5. **FC-012 mobile move action:** small parity change using the existing authoritative move engine; use an overflow action rather than swipe.
6. **FC-021 residual keyboard fixes:** split by viewport contract and provide physical browser/device evidence.
7. **FC-017 local-state mobile parity:** wait for overlapping mobile indicator and pin PRs.
8. **FC-009 file-revert confirmation:** good safety precedent, but first cover every destructive entry point.

FC-004, FC-007, FC-011, FC-014, and FC-023 warrant an upstream issue or design discussion before implementation. FC-001, FC-002, FC-003 branding, FC-010's unrestricted bypass, FC-013's current renderer integration, FC-016, FC-018 as an OpenChamber patch, and FC-019 as framed should not be proposed upstream.

## Validation limits

This was a source, history, and public-evidence audit. No product tests, builds, native device runs, cgroup exercises, updater runs, or visual comparisons were performed. GitHub searches cannot establish requests made only in Discord or other private channels. Open issue and pull-request status may change after the audit date.

## Follow-up, 2026-08-28

This follow-up checked upstream again at `16b2b72c26c6b25208b1d333db04f66ebde2d8d1`, dated 2026-08-28. It also separated direct demand from adjacent reports and evaluated precedent from similar merged, open, and closed pull requests. This section supersedes earlier recommendations where statuses or ratings differ.

Merge ratings describe the smallest plausible contribution, not the current fork diff:

1. **5/5:** already merged, or a very small correction with explicit maintainer direction and strong evidence.
2. **4/5:** likely after normal review if coordinated with active work.
3. **3/5:** plausible, but needs design agreement, stronger evidence, or careful scoping.
4. **2/5:** weak demand, overlapping work, or substantial contract and maintenance cost.
5. **1/5:** not an upstream OpenChamber concern or conflicts with an intentional boundary.

### Updated assessments

1. **FC-001, disable upstream updates: 1/5 as written.** This remains a fork-induced requirement. No direct public request was found. [Issue #1861](https://github.com/openchamber/openchamber/issues/1861) and closed [PR #2180](https://github.com/openchamber/openchamber/pull/2180) concern web and systemd updates, not copied packaged applications. Merged [PR #2525](https://github.com/openchamber/openchamber/pull/2525) and [PR #3204](https://github.com/openchamber/openchamber/pull/3204) show that maintainers accept narrow updater-ownership and error-reporting fixes. The only plausible upstream contribution is one authoritative predicate that prevents development-marked packaged runtimes from reaching updater setup or IPC. Fork notification and manual-merge policy should stay local.

2. **FC-002, install beside the official application: 1/5.** This is a fork distribution requirement rather than a missing upstream feature. No direct request was found. [Issue #349](https://github.com/openchamber/openchamber/issues/349) concerns multiple windows and servers, not separately branded installations. Merged AppImage [PR #2398](https://github.com/openchamber/openchamber/pull/2398) and open Debian/RPM [PR #2034](https://github.com/openchamber/openchamber/pull/2034) and [PR #2781](https://github.com/openchamber/openchamber/pull/2781) show interest in official distribution formats, not a generic fork-variant framework. Keep the application ID, profile, updater, artifact, and logging changes local.

3. **FC-003, distinguish fork instances: no PR needed.** The generic need was resolved by merged [PR #529](https://github.com/openchamber/openchamber/pull/529) for [issue #349](https://github.com/openchamber/openchamber/issues/349). No demand exists for literal fork branding. Closed [PR #2873](https://github.com/openchamber/openchamber/pull/2873) was an accidental fork rebrand submission. Retain the custom label locally and treat the upstream-relevant gap as solved.

4. **FC-004, search the Changes Walkthrough: 2/5.** The code gap is real, but no exact request was found. [Issue #2401](https://github.com/openchamber/openchamber/issues/2401) and open [PR #2697](https://github.com/openchamber/openchamber/pull/2697) are adjacent Markdown-search evidence with little engagement. Review on #2697 exposed shortcut ownership, Unicode, stale state, conflict, and missing runtime-evidence problems. Merged shortcut-registry [PR #2532](https://github.com/openchamber/openchamber/pull/2532) supplies the correct integration point. Open a UX issue first. A plausible PR would add only walkthrough-local search and contextual `Mod+F`, without global capture listeners or renderer DOM rewriting.

5. **FC-005, show when an agent needs input: 3/5 for the residual.** Basic pending-question visibility and descendant rollup were solved by merged [PR #2682](https://github.com/openchamber/openchamber/pull/2682), following [issue #2250](https://github.com/openchamber/openchamber/issues/2250) and [issue #2634](https://github.com/openchamber/openchamber/issues/2634). [Issue #2019](https://github.com/openchamber/openchamber/issues/2019) directly requests question-over-busy status, but has little engagement. The remaining upstream gap is presentation precedence, not question recovery. A narrow PR should derive one shared indicator state from existing live question, permission, and activity stores. Do not port the fork's complete status architecture or rewrite authoritative OpenCode status.

6. **FC-006, show interruption: 2/5 for a navigation marker; core solved.** Merged [PR #2699](https://github.com/openchamber/openchamber/pull/2699) fixed [issue #2577](https://github.com/openchamber/openchamber/issues/2577), and merged [PR #3002](https://github.com/openchamber/openchamber/pull/3002) fixed managed-restart interruption from [issue #2943](https://github.com/openchamber/openchamber/issues/2943). The only residual is a persistent sidebar or switcher marker, weakly requested in [issue #2019](https://github.com/openchamber/openchamber/issues/2019). [PR #2641](https://github.com/openchamber/openchamber/pull/2641) has closed in favor of open [PR #2882](https://github.com/openchamber/openchamber/pull/2882). Any contribution should project the existing authoritative `MessageAbortedError`; it should not add another interruption classifier.

7. **FC-007, nest background subagents under their Task: 2/5.** The exclusion of nested Task entries is a real, narrow code gap. No exact request was found. [Issue #2230](https://github.com/openchamber/openchamber/issues/2230), now-stale [issue #2521](https://github.com/openchamber/openchamber/issues/2521), merged Work Status [PR #2776](https://github.com/openchamber/openchamber/pull/2776), and open [PR #2861](https://github.com/openchamber/openchamber/pull/2861) establish adjacent interest in subagent observability. Broad [PR #1664](https://github.com/openchamber/openchamber/pull/1664) closed after repeated review and rebase rounds, with a recommendation to submit focused work. Seek UX support first, then change only the Task-summary projection for authoritatively marked background Tasks.

8. **FC-009, confirm file reverts: 3/5.** Upstream still has immediate file-level revert entry points on desktop, stacked diff, and mobile. No exact issue was found, but merged folder-discard [PR #1390](https://github.com/openchamber/openchamber/pull/1390) is strong acceptance precedent: review required confirmation and duplicate-execution protection before merge. A narrow PR should provide one shared interactive confirmation flow for every file-level entry point while leaving the noninteractive Git mutation API unchanged. The current fork implementation is not ready because it does not cover every path.

9. **FC-010, unrestricted external file reads: 1/5; bounded roots 2/5.** Exact-path external grants are an intentional security boundary. Closed [PR #1984](https://github.com/openchamber/openchamber/pull/1984) does not prove rejection of every bounded design; reviewers also objected to its 68-file scope and submission quality. Completed [issue #3031](https://github.com/openchamber/openchamber/issues/3031) and merged [PR #3078](https://github.com/openchamber/openchamber/pull/3078) improved grant renewal. Open [PR #2872](https://github.com/openchamber/openchamber/pull/2872), [issue #2523](https://github.com/openchamber/openchamber/issues/2523), and [issue #605](https://github.com/openchamber/openchamber/issues/605) support symlink and external-reference usability, not unrestricted reads. Do not upstream the bypass. An operator-configured list of canonical read-only roots may merit a security design issue.

10. **FC-011, synchronize inbox state: 2/5 combined; 3/5 in stages.** The gap is real, but read receipts, manual unread, durable unread, and pins are separate contracts. Cross-client read-status [PR #2339](https://github.com/openchamber/openchamber/pull/2339) closed unmerged on 2026-08-27. Manual unread [PR #2029](https://github.com/openchamber/openchamber/pull/2029) remains open but conflicted, while [issue #858](https://github.com/openchamber/openchamber/issues/858) closed as not planned. [Issue #2918](https://github.com/openchamber/openchamber/issues/2918) directly identifies device-local pins as a mobile problem; open [PR #2962](https://github.com/openchamber/openchamber/pull/2962) explicitly keeps cross-device sync out of scope. Start with a refreshed manual unread change or connected-client receipts over existing server attention routes. Durable pins require prior agreement on storage, migration, multi-process safety, deletion, and corruption behavior.

11. **FC-012, move a mobile session to a worktree: already merged, 5/5.** [PR #2998](https://github.com/openchamber/openchamber/pull/2998) merged on 2026-08-28. It uses the shared session menu, supports existing or new worktrees, handles dirty source choices, moves descendants, and defines rollback. Integrate and validate upstream, then retire FC-012 if it meets the fork requirement. Submit another PR only for a separately reproduced accessibility or runtime defect.

12. **FC-013, intraline tool-diff highlighting: 2/5 complete; 3/5 for bounded native rendering.** The rendering gap remains, but no direct request was found. [Issue #3023](https://github.com/openchamber/openchamber/issues/3023) and [issue #2820](https://github.com/openchamber/openchamber/issues/2820) concern diff correctness. Merged performance [PR #2742](https://github.com/openchamber/openchamber/pull/2742) raises the evidence bar for extra diff computation. A plausible PR would enable the renderer's native word mode only under measured line and patch budgets. The fork's exact 1,000-character policy, shadow-DOM inspection, and skipped-line indicator lack public demand and should not be assumed correct.

13. **FC-014, worktree comparison and indicators: 3/5 for an explicit combined view; 2/5 complete.** Upstream already reports tracked-branch ahead/behind and supports arbitrary range comparison through merged [PR #2572](https://github.com/openchamber/openchamber/pull/2572), which completed [issue #2535](https://github.com/openchamber/openchamber/issues/2535). Open [issue #3129](https://github.com/openchamber/openchamber/issues/3129) directly requests unpushed commits, a full combined diff, and ahead status. Open, review-blocked [PR #3166](https://github.com/openchamber/openchamber/pull/3166) reinforces the risk of background Git work for inactive projects. Start with an explicitly refreshed combined view or one repository-level summary. Define the base ref and detached, missing-upstream, stale-ref, rename, binary, and partial-failure behavior. Do not add per-row Git polling.

14. **FC-015, OpenCode update status and action: 4/5 for the target bug; 3/5 for Settings; 1/5 for the fork supervisor.** [Issue #3121](https://github.com/openchamber/openchamber/issues/3121) remains open and high priority. Independent Windows and macOS reports now confirm that a concrete semantic version works while `{}` and `"latest"` fail. Exact fix [PR #3190](https://github.com/openchamber/openchamber/pull/3190) is open and blocked pending review or branch state, so contribute there rather than opening a competitor. Merged [PR #2542](https://github.com/openchamber/openchamber/pull/2542), [PR #2585](https://github.com/openchamber/openchamber/pull/2585), and desktop updater-error [PR #3204](https://github.com/openchamber/openchamber/pull/3204) show strong maintainer acceptance of narrow updater correctness. A durable Settings entry can follow separately. External-systemd supervision remains fork topology.

15. **FC-016, switch official and fork servers: 1/5.** No exact request exists. [Issue #2033](https://github.com/openchamber/openchamber/issues/2033), [issue #3159](https://github.com/openchamber/openchamber/issues/3159), and [issue #1861](https://github.com/openchamber/openchamber/issues/1861) concern one deployment's remote lifecycle. Merged [PR #3038](https://github.com/openchamber/openchamber/pull/3038) improves externally configured OpenCode recovery but does not create a reason for upstream to model official/custom switching. Keep the systemd, reverse-proxy, health, lock, and rollback workflow local. Fix the local switch controller's authentication and CSRF boundary before wider use.

16. **FC-017, Desktop Recent indicators on Mobile: 3/5 for local state; 1/5 for automatic complete parity.** [Issue #2565](https://github.com/openchamber/openchamber/issues/2565), [issue #2384](https://github.com/openchamber/openchamber/issues/2384), [issue #2918](https://github.com/openchamber/openchamber/issues/2918), and completed [issue #359](https://github.com/openchamber/openchamber/issues/359) recognize mobile status and pin parity. Open [PR #2828](https://github.com/openchamber/openchamber/pull/2828), [PR #2962](https://github.com/openchamber/openchamber/pull/2962), and [PR #2249](https://github.com/openchamber/openchamber/pull/2249) overlap the rows and are currently conflicted. After they settle, share an authoritative row-state model for question, permission, busy/retry, unread, pin, interruption, and persistent error. Keep layout mobile-specific and exclude Git/PR fan-out until separately demanded and measured.

17. **FC-018, command memory limits: 1/5 in OpenChamber; 2/5 as a split OpenCode proposal.** The gap is real but owned mainly by OpenCode, which launches command trees. [OpenCode issue #37597](https://github.com/anomalyco/opencode/issues/37597) directly requests process-tree resource limits but has little engagement. [OpenCode issue #20695](https://github.com/anomalyco/opencode/issues/20695) has strong memory-pressure engagement but mostly concerns OpenCode's own memory, while [issue #20902](https://github.com/anomalyco/opencode/issues/20902) concerns process cleanup. OpenChamber merged renderer output cap [PR #2375](https://github.com/openchamber/openchamber/pull/2375), which solves a different failure mode. Discuss process ownership, structured resource failures, and Linux, Windows, and macOS enforcement in OpenCode. Do not submit the Linux systemd/cgroup scripts as an OpenChamber PR.

18. **FC-019, separate fork preferences: 1/5 as framed; 2/5 for a general destination policy.** The settings page is necessarily fork-owned. No exact request exists for inheriting the current worktree. [Issue #1748](https://github.com/openchamber/openchamber/issues/1748) closed as already fixed, [issue #2376](https://github.com/openchamber/openchamber/issues/2376) closed as stale, and [issue #2293](https://github.com/openchamber/openchamber/issues/2293) concerns adjacent worktree lifecycle. Merged [PR #1708](https://github.com/openchamber/openchamber/pull/1708), [PR #722](https://github.com/openchamber/openchamber/pull/722), and [PR #2928](https://github.com/openchamber/openchamber/pull/2928) show acceptance of explicit routing fixes. Upstream now intentionally defaults implicit New Chat to managed Chat, so first seek agreement on a general `managed-chat`, `current-directory`, or `project-root` destination policy. Do not upstream the fork page or a bypassed boolean.

19. **FC-020, restore archived sessions before send: 4/5.** Upstream has archived search and explicit restore from merged [PR #2616](https://github.com/openchamber/openchamber/pull/2616), which addressed [issue #2346](https://github.com/openchamber/openchamber/issues/2346), but message dispatch does not restore first. No exact request was found; [OpenCode issue #24153](https://github.com/anomalyco/opencode/issues/24153) and [PR #43919](https://github.com/anomalyco/opencode/pull/43919) provide strong adjacent demand for correct unarchive semantics. A narrow PR should add one shared pre-dispatch gate, preserve draft state until confirmed restore, and abort on restore failure or runtime change. Dedicated-mobile archived discovery is separate. The remaining cross-client rearchive race should be documented rather than claimed atomic.

20. **FC-021, hosted-mobile keyboard geometry: 3/5 for residual pieces.** The exact Android composer occlusion in [issue #3114](https://github.com/openchamber/openchamber/issues/3114) is fixed and physically verified in Firefox and Chrome. New [issue #3201](https://github.com/openchamber/openchamber/issues/3201) reports an iOS PWA fullscreen regression, with open conflicted and failing [PR #3202](https://github.com/openchamber/openchamber/pull/3202). Merged [PR #1303](https://github.com/openchamber/openchamber/pull/1303), [PR #1370](https://github.com/openchamber/openchamber/pull/1370), and open [issue #2287](https://github.com/openchamber/openchamber/issues/2287) show repeated demand and willingness to merge narrow viewport fixes. Do not compete with #3202. Split transcript-space reservation from fullscreen and viewport metadata, and provide final physical-device before/after recordings.

21. **FC-022, failed-submission recovery: 4/5 when coordinated; 2/5 as a competing broad PR.** Upstream commit [ae491bf5](https://github.com/openchamber/openchamber/commit/ae491bf5b5ef4ecd8d7320022c047959ea6e6c1a) now restores raw text, merges text typed while pending, and restores switched-chat text, closing [issue #1792](https://github.com/openchamber/openchamber/issues/1792). Mentions, queue entries, local commands, and per-chat attachment ownership remain incomplete. Open [PR #3154](https://github.com/openchamber/openchamber/pull/3154) is rebased with passing checks but blocked pending review; coordinate there rather than duplicating it. Open [PR #3082](https://github.com/openchamber/openchamber/pull/3082) and [PR #3055](https://github.com/openchamber/openchamber/pull/3055) cover adjacent durable and ambiguous-send behavior. The fork still loses original-chat attachments after a chat switch, so its implementation is not upstream-ready. Split acknowledgement ownership, per-chat attachments, mention snapshots, and command recovery. Preserve stable message identity or an explicit unknown-outcome state to avoid duplicate turns.

22. **FC-023, native mobile dictation: 2/5 to 3/5.** The structural CodeMirror gap remains. [Issue #3041](https://github.com/openchamber/openchamber/issues/3041) directly reports OS Voice Access failure, but no public report matches continuous Gboard dictation from an empty prompt. Merged [PR #2691](https://github.com/openchamber/openchamber/pull/2691), [PR #2510](https://github.com/openchamber/openchamber/pull/2510), and [PR #2610](https://github.com/openchamber/openchamber/pull/2610) show that maintainers prefer targeted CodeMirror compatibility fixes. A mobile native editor would add a permanent second editor implementation and needs design agreement. The fork's current version has incomplete caret, paste, selection, undo, and composition parity and lacks final device evidence. Open an issue with physical Gboard and iOS recordings before proposing a mobile-only native editor behind the existing composer contract.

### Revised contribution order

1. Coordinate on **FC-015** through existing [PR #3190](https://github.com/openchamber/openchamber/pull/3190).
2. Coordinate on the remaining **FC-022** recovery work through [PR #3154](https://github.com/openchamber/openchamber/pull/3154), then split per-chat attachments and mentions.
3. Propose the narrow **FC-020** restore-before-dispatch gate.
4. Propose residual **FC-005** blocker precedence using existing question infrastructure.
5. Propose complete-entry-point **FC-009** revert confirmation.
6. Pursue residual **FC-021** viewport fixes only after #3202 settles and with physical evidence.
7. Pursue local-state-only **FC-017** mobile parity after overlapping PRs settle.
8. Discuss a reduced **FC-014** combined-diff contract before implementation.

FC-012 should be integrated from upstream and retired after validation. FC-004, FC-007, FC-011, FC-013, and FC-023 need a product or design issue before code. FC-001, FC-002, FC-003 branding, FC-010's unrestricted bypass, FC-016, FC-018 as an OpenChamber patch, and FC-019 as framed should remain outside upstream PRs.
