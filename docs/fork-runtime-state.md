# Fork Runtime State

- **Type:** reference
- **Purpose:** Storage boundaries between the official packaged application and the source-run custom fork.
- **When to read:** Before changing Electron profile identity, browser persistence, source launch behavior, or running packaged and source applications simultaneously.
- **Related:** intent.md, fork-requirements.md, ../packages/electron/README.md

## Shared State

| State | Default location | Shared between packaged and source |
|---|---|---|
| OpenCode sessions, messages, and projects | `~/.local/share/opencode/opencode.db` | Yes |
| OpenCode authentication and configuration | `~/.local/share/opencode/`, `~/.config/opencode/` | Yes |
| OpenChamber settings and projects | `~/.config/openchamber/` | Yes |
| Session folders | `~/.config/openchamber/sessions-directories.json` | Yes, with browser mirrors |
| Session unread and pin metadata | `~/.config/openchamber/session-inbox.json` | Yes, with browser pin mirrors |
| Electron browser profile | `~/.config/OpenChamber`, `~/.config/OpenChamber Dev`, or `~/.config/OpenChamber Dev HMR` | No |

The bundled source runtime deliberately keeps the `OpenChamber Dev` Electron profile. This isolates Chromium local storage, cookies, window state, service workers, and embedded-browser data while leaving sessions and canonical server settings shared. The installed custom launcher uses content-hash-cached built UI assets without HMR and pins its loopback server to port `46405`; the explicit override does not replace the packaged application's persisted port preference. The separately installed macOS HMR launcher uses `OpenChamber Dev HMR`, allowing both source launchers to run and be pinned independently. Although its copied Electron application bundle makes Electron's raw `app.isPackaged` value true, the development environment marker keeps it on source-run HMR and notification-only update behavior. Terminal development continues to use `OpenChamber Dev` with `bun run electron:dev`.

## Browser-Local State

Browser storage is scoped by both Electron profile and page origin. Packaged and bundled-UI source runs use `openchamber-ui://app`; HMR source runs use `http://127.0.0.1:<port>`. The separate packaged/source Electron profiles still isolate those applications even when their page origin matches. A changed HMR port creates another browser-storage namespace.

Important durable key families include:

| Keys or prefixes | Contents |
|---|---|
| `ui-store` | Layout, selected settings surface, rendering preferences, notification options, shortcuts, and model UI preferences; many values also synchronize to server settings. |
| `custom-fork-settings` | Browser-local preferences for behavior implemented only by this custom fork. |
| `themeMode`, `lightThemeId`, `darkThemeId`, theme mirror keys | Theme selection and derived splash colors. |
| `projects*`, `activeProjectId*`, `lastDirectory`, `pinnedDirectories` | Browser mirrors of projects and directories plus local ordering. |
| `oc.sessions.folders.v2:*` | Runtime-scoped mirror of server-backed session folders. |
| `oc.sessions.pinned.v2`, `oc.sessions.pinned.server-migration.v1` | Runtime-scoped mirror and one-time migration state for server-backed session pins. |
| `openchamber.chatDrafts.v2`, `openchamber-inline-comment-drafts` | Browser-only chat and review drafts. |
| `message-queue-store` | Unsent queued messages and attachments. |
| `openchamber-session-todos`, `auto-review-store` | Todo fallbacks and auto-review checkpoints. |
| `context-store` | Per-session model, agent, variant, edit mode, and context snapshots. |
| `session-display-mode`, `oc.sessions.*` sidebar keys | Session grouping, expansion, ordering, collapse, and remembered active-session UI. |
| `files-view-tabs-store`, `openchamber:files:*`, `openchamber:plan:*` | Open file tabs, tree expansion, autosave, and viewer modes. |
| `config-store` and selection stores | Cached provider/config data and selected agents, commands, skills, plugins, MCP entries, and Git identities. |
| Voice and TTS keys including `openaiApiKey`, `openaiCompatibleApiKey`, `sttApiKey` | Browser-only voice preferences and credentials. These credentials are not copied to server settings. |
| `openchamber.i18n.v1` | Locale preference. |
| `openchamber.update-install-id` and update-dismissal keys | Update telemetry identity and dismissed prompts. |
| `oc.dir.v2.*`, Git/PR/worktree cache keys | Rebuildable runtime caches and recent session metadata, not authoritative messages. |

`sessionStorage` contains terminal tab arrangement, PWA prompt state, and chunk-load recovery markers. OpenChamber application code does not use IndexedDB or the Cache API for its own data. Server-issued authentication cookies remain profile and origin specific.

The embedded browser uses partition `persist:openchamber-browser`; visited sites can store their own cookies, local storage, IndexedDB, service workers, and caches inside each Electron profile.

## Simultaneous Runtime Caveats

- Separate Electron profiles prevent browser-local write races.
- Shared `settings.json` writes are atomic, but write locks are process-local. Two applications editing the same setting concurrently can produce last-writer-wins behavior.
- Session-folder, session-inbox, magic-prompt, and Git-identity metadata can have similar cross-process write races.
- Both managed OpenCode servers use the same SQLite database. SQLite locking protects database integrity, but simultaneous mutation of the same session can cause lock delays or stale process-local views.
- Different OpenCode versions may interpret or migrate shared data differently.
- Both applications can emit notifications and consume CPU and memory for their own UI, server, and managed OpenCode process.

Running both applications for observation or separate work is acceptable. Avoid editing the same setting, metadata record, or session concurrently, and keep their OpenCode versions compatible.

## Switchable Linux Runtime

`scripts/openchamber-runtime/install.sh` installs an external `opencode.service`, mutually conflicting regular/custom OpenChamber services, and `~/.local/bin/openchamber-switch`. OpenCode remains active while `openchamber-switch regular` or `openchamber-switch custom` replaces the selected OpenChamber surface; failed target health validation restarts the previously active surface. The services retain their distinct ports (`8792` regular, `8795` custom) and continue sharing the canonical OpenChamber state above, but only one is enabled and active at a time.

The custom unit sets `OPENCHAMBER_MANAGED_RESTART=true` and uses `Restart=on-failure`. This exposes an authenticated managed-restart capability only while OpenChamber is connected to external OpenCode. **Custom Fork > Fork Settings** can request the restart; OpenChamber gracefully closes its own terminals, realtime transports, scheduled work, and server resources, then exits with status `75`. Systemd restarts only `openchamber-custom.service`; `opencode.service` and its active agents remain running, and the browser reloads after the new OpenChamber process reports a different `startedAt`. Manual and unsupported runtimes return a stable unsupported response instead of exiting.

The external OpenCode service selects an installed shell launcher that preserves the original command for OpenCode parsing and permission approval, then executes it in a transient `opencode-tools.slice` scope. The installer snapshots its current `PATH` into all three service definitions so OpenCode tools retain user-configured command directories; rerun it after changing the desired service `PATH`. Each command defaults to `MemoryMax=3G`, `MemorySwapMax=512M`, and `TasksMax=512`; the aggregate slice defaults to `MemoryMax=7G`, `MemorySwapMax=1G`, and `TasksMax=2048`. The OpenCode service itself uses `MemoryMax=9G`, `MemorySwapMax=2G`, `OOMPolicy=continue`, and `ManagedOOMPreference=avoid`. Lower `MemoryHigh` thresholds are intentionally omitted because an anonymous-memory allocation can remain throttled at the soft boundary indefinitely instead of reaching `MemoryMax` and returning an OOM failure. The OpenChamber surface units intentionally have no memory controls, so installing and reloading their replacement definitions cannot constrain an already-running legacy service before cutover. Override provider-specific environment variables in mode-0600 `~/.config/openchamber/opencode.env` rather than adding secrets to unit files.

The installer does not activate or restart services by default. This is intentional: replacing a managed OpenChamber while one of its OpenCode requests is active terminates that request. Install and verify first, start the external OpenCode service, then switch from a process outside the OpenChamber service being stopped. Set `OPENCHAMBER_CUSTOM_REPO` while installing when the selectable custom runtime should use another checkout.
