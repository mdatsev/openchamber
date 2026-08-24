# Upstream v1.20.0 fork requirement impact

- **Type:** record
- **Purpose:** Preserve the requirement comparison, conflict resolutions, and validation for integrating upstream v1.20.0 into the custom fork.
- **When to read:** Before revisiting the v1.20.0 merge, changing its conflict resolutions, or integrating another upstream release.
- **Related:** ../fork-requirements.md, upstream-v1.18.4-fork-requirement-impact.md

## Compared revisions

The comparison used the previously integrated stable release `f0c23d3d` (v1.18.4), the custom pre-merge parent `91bddec2`, and upstream `52ee8786` (v1.20.0). Upstream changed 534 files between the two release tags. The merge produced 32 textual conflicts, concentrated in disposable side chats, sidebar and session synchronization, worktree diffs, settings catalogs, and server route registration.

No upstream feature fully replaced an active fork requirement. Every entry in `docs/fork-requirements.md` therefore remains active.

## Requirement comparison

| Requirement | Incoming impact and resolution |
|---|---|
| FC-001 | Upstream dependencies, SDK 1.18.21, and release metadata were adopted. Source-run update installation remains disabled and notification-only. |
| FC-002 | Upstream Electron security, SSH, and Windows atomic-replacement fixes were adopted. The fork application identity, isolated source profile, bundled launcher, fixed port, and file logging remain intact. |
| FC-003 | Upstream title formatting was adopted around the fork's custom browser and OS-window title. |
| FC-004 | Walkthrough search remained intact while adopting adjacent walkthrough rendering changes. |
| FC-005 | Upstream reconnect settlement and global polling were adopted. Authoritative questions from hidden descendants still replace busy state on their visible parent. |
| FC-006 | Upstream completed-turn reconciliation was combined with the fork's blocker-authorized interrupted-turn classification and sidebar marker. |
| FC-007 | Upstream inactive embedded-subagent history is complementary. Background subagents remain nested under the Task that spawned them. |
| FC-008 | Upstream `/btw` overlaps but does not replace the fork: it lacks `/side`, repeated-command focus/send, promotion, and the fork's cleanup and recovery guarantees. The fork controller remains authoritative for both commands; compatible upstream full-context forking and UI improvements were adopted without running both metadata models. |
| FC-009 | Dirty-file revert confirmation was unaffected. |
| FC-010 | Upstream symlink and expiring Desktop grant fixes were adopted. Authenticated reads remain unrestricted outside the workspace while writes, uploads, deletion, and static serving remain bounded. |
| FC-011 | Upstream global session discovery and polling were adopted without replacing server-authoritative unread, pin, and mark-unread state. |
| FC-012 | Adjacent worktree safety changes were adopted. The mobile move action, dirty-change transfer, naming, and rollback remain intact. |
| FC-013 | Upstream diff presentation changes were adopted around the fork's bounded word-level highlighting and skipped-line disclosure. |
| FC-014 | Upstream branch-range diff scope was added as a separate capability. The fork's linked-worktree `uncommitted`, `committed`, and `combined` modes, layers, compact rows, dirty indicators, and ahead indicators remain authoritative. |
| FC-015 | Upstream managed-process restart recovery was adopted as fallback behavior. The fork's persistent external OpenCode update status and supervised no-active-agent upgrade remain intact. |
| FC-016 | Upstream proxy reuse, restart recovery, and SSH changes were adopted without taking ownership from the external systemd OpenCode service or replacing official/custom surface switching. |
| FC-017 | Upstream mobile session discovery changes were adopted. Mobile Recent still consumes the shared full indicator projection. |
| FC-018 | Upstream agent-tool changes were adopted around the fork's cgroup launcher, aggregate supervisor, deterministic victim policy, and explicit OOM diagnoses. The web build retains its 4 GiB heap allowance. |
| FC-019 | Upstream managed projectless chats were combined with the fork's current-worktree inheritance preference. The dedicated Custom Fork settings page and search entries remain intact. |
| FC-020 | Upstream session discovery and project-knowledge dispatch were adopted. Archived sessions are still restored and confirmed before prompt, slash-command, or shell dispatch. |

## Conflict resolutions

1. The fork disposable side-chat controller owns `/side` and `/btw`; upstream's separate BTW creation path is not exposed alongside it. Existing upstream BTW metadata remains routable for interoperability.
2. Draft creation combines upstream projectless-session behavior with fork runtime, draft identity, and user-retarget guards. Snapshot-only legacy callers still select the server-materialized session.
3. Session synchronization combines upstream global polling, managed-restart settlement, knowledge, and goals with fork descendant-blocker authority, interruption markers, inbox state, disposable direct indexing, and archived restore-before-send.
4. Upstream branch-base comparison uses an internal `branch-range` capability so the persisted fork `branch` scope keeps its existing linked-worktree meaning.
5. Server route registration includes upstream project context, agent memory, session knowledge, provider, and app-link capabilities alongside fork side-chat, managed-runtime, and supervised-upgrade routes.
6. Locale catalogs retain the fork meaning that `/btw` is an alias for `/side`; automatic duplicate `/btw` and branch-scope keys were removed from every locale.
7. VS Code permission auto-accept lazily captures side-chat runtime authority, preserving production routing while allowing isolated store tests to mock `runtime-fetch` narrowly.

## Validation

1. `bun run type-check:ui`, `bun run type-check:web`, `bun run type-check:mobile`, `bun run vscode:type-check`, and `bun run type-check:electron` passed.
2. `bun run lint` passed across all workspaces.
3. `bun run test` passed: 294 UI files, 25 VS Code files, 17 Electron files, one scripts file, and 162 web files containing 1,638 passing tests plus two skips.
4. `bun run build:web` and the full `bun run build` passed, producing web, service-worker, mobile-asset, and VS Code webview output.
5. `bun run dead-code` completed with the non-blocking existing unused export/type report. It also reports upstream's new `oxlint.config.ts` as unused because configuration files are not imported by application code.
6. `tool-use docs-list --check` and `git diff --cached --check` passed.

## Remaining concerns

1. The new anti-slop check could not run because `oxlint` 1.78.0 is not installed in the current dependency tree. Installing dependencies was outside this synchronization run's machine authorization.
2. Native desktop startup, systemd runtime switching/upgrades, cgroup OOM selection, mobile interaction flows, and the complete disposable side-chat lifecycle were not exercised manually. Their static checks and automated tests passed, but those platform and lifecycle contracts still require runtime validation before release deployment.
