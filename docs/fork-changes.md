# Fork Changes

- **Type:** reference
- **Purpose:** Active index of behavior, fixes, and implementation changes that distinguish `mdatsev/openchamber` from upstream OpenChamber.
- **When to read:** Before implementing fork-only behavior, reviewing the fork's divergence, or integrating an upstream release.
- **Related:** intent.md

## Active Changes

| ID | Change | Reason | Owning paths | Upstream status and removal trigger |
|---|---|---|---|---|
| `FC-001` | Source-run Desktop checks upstream releases for notification only and disables installation with instructions to merge the release into the custom branch. | Keep source-based fork installations informed without replacing them with official upstream binaries. | `packages/electron/main.mjs`, `packages/electron/preload.mjs`, `packages/ui/src/lib/desktop.ts`, `packages/ui/src/stores/useUpdateStore.ts`, `packages/ui/src/components/ui/UpdateDialog.tsx`, `packages/ui/src/lib/i18n/messages/`, `packages/electron/README.md` | Remove when upstream authoritatively distinguishes source runs from packaged installs and provides equivalent notification-only update behavior. |
| `FC-002` | Desktop and dynamic renderer window titles identify the fork as `OpenChamber CUSTOM`. | Distinguish source-run fork windows from the official packaged application. | `packages/electron/main.mjs`, `packages/ui/src/hooks/useWindowTitle.ts` | Remove if upstream provides equivalent configurable application-title branding; stop and ask if upstream changes window-title ownership or formatting. |
| `FC-003` | Source runs install as a distinct `OpenChamber CUSTOM` application on Linux and macOS, with silent non-HMR launchers that content-hash-cache bundled UI assets and write the current run log to a file. | Allow the official packaged application and source fork to be pinned separately while preventing source edits from reloading the launched app, avoiding unchanged rebuilds, and preserving startup failures and runtime logs without opening a terminal. | `package.json`, `scripts/install-custom.sh`, `packages/electron/main.mjs`, `packages/electron/scripts/build-web-assets.mjs`, `packages/electron/scripts/electron-dev.mjs`, `packages/electron/scripts/launch-custom-linux.sh`, `packages/electron/README.md`, `docs/fork-runtime-state.md` | Remove if upstream supports configurable development desktop identity and a logged cached non-HMR source launcher with equivalent behavior. |
| `FC-004` | The Changes Walkthrough provides source-backed diff search with `Ctrl+F`/`Cmd+F`, all-occurrence substring highlighting, and stronger active-match navigation across virtualized diff blocks. | Make walkthrough code searchable despite the diff renderer's shadow DOM and virtualization boundaries. | `packages/ui/src/components/views/walkthrough/`, `packages/ui/src/components/views/PierreDiffViewer.tsx`, `packages/ui/src/lib/i18n/messages/` | Remove when upstream provides equivalent walkthrough-scoped diff search and navigation. |
| `FC-005` | Pending agent questions display the sidebar unseen dot instead of a busy spinner in session rows, switchers, folders, groups, and collapsed project indicators. | Distinguish an agent waiting for user input from one that is actively working. | `packages/ui/src/sync/sync-context.tsx`, `packages/ui/src/components/session/`, `packages/ui/src/components/session/sidebar/` | Remove when upstream gives authoritative pending-question attention precedence over busy activity on the same surfaces. |

## Maintenance

- Record every fork-only source, configuration, build, or user-visible behavior change when it is introduced. Keep related edits that implement one capability in one entry.
- Keep entries concise and current. Record owning paths and an upstream issue or pull request when one is known.
- This is an active divergence index, not a changelog. Do not record upstream-only changes, routine synchronization merges, temporary work, generated output, or policy-only documentation.
- Remove an entry when its fork implementation has been removed. Git history preserves the previous record.
- Before integrating an upstream release, compare its changes with every active entry.
- When upstream provides the same fix or behavior, remove the fork implementation, use the upstream implementation, validate the affected behavior, and remove the entry.
- When upstream provides similar but different behavior, changes the same owning area, or leaves equivalence uncertain, stop the integration and ask the user how to proceed.
- Do not retain redundant fork code as a compatibility layer after an equivalent upstream implementation is adopted.
