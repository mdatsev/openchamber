# Upstream v1.18.4 fork requirement impact

- **Type:** record
- **Purpose:** Preserve the pre-merge requirement comparison, conflict resolutions, and validation for integrating upstream v1.18.4 into the custom fork.
- **When to read:** Before revisiting the v1.18.4 merge, changing its conflict resolutions, or integrating another upstream release.
- **Related:** ../fork-requirements.md, upstream-v1.18.2-fork-requirement-impact.md

## Compared revisions

The comparison used the common upstream base `da4a61ad` (v1.18.2), the custom pre-merge parent `b5eae247`, and upstream `f0c23d3d` (v1.18.4). Upstream added 42 non-merge commits and changed 344 files. A pre-merge `git merge-tree --write-tree custom v1.18.4` predicted 30 unresolved paths, concentrated in context-panel composition, settings catalogs, message chronology, and server route wiring.

No incoming feature fully replaced an active fork requirement. The merge therefore keeps every entry in `docs/fork-requirements.md` active.

## Requirement comparison

| Requirement | Incoming impact and resolution |
|---|---|
| FC-001 | Upstream package and SDK versions were adopted. Source-run notification-only update classification, disabled package installation, and `SOURCE_RUN_UPDATE_UNSUPPORTED` enforcement remain authoritative. |
| FC-002 | Electron 43.3, its rebuild tooling, browser-panel lifecycle, and close-to-tray correction were adopted. The separate `openchamber-custom-source` identity, `OpenChamber Dev` profile, cached bundled launcher, fixed port, and file logging remain intact. |
| FC-003 | Upstream embedded-chat changes conflicted in `App.tsx`, but the custom browser, window, and mini-chat titles remain intact. |
| FC-004 | Walkthrough search was unaffected. Upstream's dead-export cleanup was accepted without removing full-diff indexing, Unicode-safe offsets, highlighting, or navigation. |
| FC-005 | Upstream embedded-chat prompting bootstrap and creation-time transcript ordering were adopted. Descendant question scope, blocker recovery, question-over-busy precedence, and sidebar indicators remain intact. |
| FC-006 | Upstream's fuller creation-time chronology model replaced the fork's independent ID-rollover implementation. Interruption classification, blocker-authoritative inactive snapshots, local `Interrupted` finalization, and stale-refresh protection remain intact. |
| FC-007 | Upstream's bounded Work Status subagent list is complementary. Background subagents remain nested under the Task that spawned them, and upstream part chronology prevents lexical-ID ordering from changing that projection. |
| FC-008 | Upstream's lean context panel, browser surface, active-only chat iframe, prompting bootstrap, and per-mode tab limits were adopted. Disposable side-chat runtime capture, repeated-command focus/send, close confirmation, serialized abort/delete/promotion, recovery, hidden navigation, and promotion remain intact. Disposable tabs are neither evicted nor persisted as ordinary tabs. |
| FC-009 | The uncommitted-file revert confirmation path was untouched. Session revert conflicts were resolved independently through positional message boundaries. |
| FC-010 | Authenticated filesystem stat/text/raw reads remain unrestricted outside the workspace; mutation and static serving remain bounded. Upstream local-file links, downloads, and image previews were adopted. The new Markdown gallery grants only workspace images and assistant-referenced files under OpenCode's temporary root, so arbitrary outside-workspace images remain available through the file viewer but not this new gallery surface. |
| FC-011 | Session inbox startup, authenticated routes, server-issued unread tokens, revisions, synchronized pins, mark-unread, and directory-scoped viewed calls were retained while adopting project-ownership selection and mobile reconnect fixes. |
| FC-012 | Mobile connection resilience was adopted while preserving mobile worktree discovery, the move dialog, dirty-change choices, branch/directory naming, and rollback behavior. |
| FC-013 | Upstream browser-tool and image output presentation were adopted. Lazy `ToolPartDiffPreview`, bounded word highlighting, whole-line fallback, and skipped-line disclosure remain intact. |
| FC-014 | Upstream authoritative project/worktree selection was adopted. The custom comparison modes, committed and uncommitted layers, ancestry model, sidebar indicators, and compact rows remain intact. The Git API test now uses upstream's dynamic module mock while retaining `getWorktreeComparison`. |
| FC-015 | Upstream OpenChamber Tools settings were added without replacing the custom OpenCode update settings. Supervised systemd upgrade admission, active-turn drain, cancellation, restart/rebind, and status reporting remain intact. |
| FC-016 | Upstream browser/dev-tunnel services, exception handling, mobile reconnect hardening, and cross-process scheduled-task occurrence claims were adopted. The one-external-OpenCode/one-active-surface topology, ports, rollback, and custom-only managed restart remain intact. |
| FC-017 | Upstream mobile connection and ownership changes were adopted. Mobile Recent still uses the shared indicator projection rather than a reduced mobile-only model. |
| FC-018 | Resource-control scripts and systemd units were untouched. The web package retains its 4 GiB V8 build heap while adopting the larger upstream browser bundle and dependency versions. |
| FC-019 | The dedicated Custom Fork page, separate persisted preference store, and current-worktree inheritance policy remain intact. Upstream OpenChamber Tools stay in General settings and the search registry contains both upstream and fork entries. |

## Conflict resolutions

1. `message-ordering.ts` follows upstream creation time with ID only as a deterministic tie-breaker. Parts retain authoritative array order. Missing revert markers preserve the transcript instead of clearing it.
2. `optimistic.ts` keeps the fork's self-healing re-sort when an existing message array contains all incoming IDs but is not chronological.
3. `App.tsx`, `ChatView.tsx`, `ContextPanel.tsx`, and `useUIStore.ts` compose upstream active-only embedded chats and browser tabs with the fork's complete disposable side-chat lifecycle.
4. `server/index.js` starts both the session inbox and upstream browser/dev-tunnel services. `core-routes.js` removes obsolete preview credential helpers while retaining authenticated managed restart and capability reporting.
5. Settings catalogs retain translated `settings.fork.*` entries and adopt translated `settings.openchamber.tools.*` entries. Four obsolete German updater keys left by a clean textual merge were removed to restore locale parity.
6. The custom `mirrorSessionIntoLiveStores` export remains public because side-chat promotion uses it after removing disposable metadata.
7. Post-merge review corrected two integration regressions. The v14 preview migration now preserves the converted active tab instead of selecting the first surviving tab. Draft and side-chat sends retain captured runtime authority across creation, goal metadata, optimistic confirmation, linked metadata, and failure recovery; a stable draft ID plus user-change revision distinguishes automatic pending-worktree normalization from a replaced or retargeted draft.

## Validation

1. `bun install --frozen-lockfile` completed and repaired the Electron 43.3 runtime.
2. `bun run type-check` passed across all workspaces after restoring the side-chat promotion export.
3. `bun run lint` passed across all workspaces.
4. `bun run build` passed, including web, mobile assets, and VS Code webview output.
5. UI isolated tests passed for 264 of 265 files. The sole failure is the unchanged `useConfigStore.test.ts` mock: it replaces `runtime-fetch` with only `runtimeFetch`, while the unchanged custom side-chat runtime imports `sanitizeHeadersForBrowser`. This is a pre-existing test-isolation defect in files unchanged by this integration.
6. VS Code tests passed 24 of 24 files. Electron tests passed 15 of 15 files.
7. The combined web run passed 1,280 tests with two skips and one order-sensitive relay timeout. All seven relay test files, including the timed-out host-client integration, passed individually as required by the relay workflow.
8. `bun run dead-code` completed with its non-blocking existing unused-file/export/type report. No new merge-resolution source file was reported unused.
9. After post-merge review fixes, five focused UI files passed 117 tests, including the existing runtime-switch optimistic rollback and draft lifecycle cases. Workspace-wide `bun run type-check`, `bun run lint`, and `bun run build` passed again. The isolated UI suite repeated the same 264-of-265 result described above.

## Remaining concerns

1. The full test command remains red because of the unchanged UI mock described above, even though every other UI file passed.
2. The web suite's combined-process relay order sensitivity remains; isolated relay runs are green.
3. Arbitrary assistant-referenced images outside both the workspace and OpenCode temporary root are not eligible for the new gallery grant, although authenticated direct file viewing remains unrestricted.
4. The inherited desktop dev-tunnel path still needs lifecycle hardening. `devTunnel.ts` clears UI maps on a runtime switch but does not close shell listeners or reject an old `desktop_dev_tunnel_open` completion that arrives afterward. The server client also rejects non-HTTP(S) runtime base schemes, and its reuse key omits request headers so a reused listener retains the first connection's captured authentication headers.

## Follow-up, 2026-08-24

The FC-008 comparison and conflict resolutions above record the v1.18.4 integration and are no longer current requirements. The user approved retiring FC-008 and restoring upstream v1.20 `/btw` as the authoritative behavior. Sessions that still carry the old custom marker surface as ordinary sessions. They are not deleted or migrated.
