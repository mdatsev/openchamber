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

The custom service serves `packages/web/dist` from its configured source checkout as-is; installing or switching runtimes does not build those assets. Vite empties `dist` before building, so an interrupted or out-of-memory build can leave only copied public files. That partial directory passes the server's directory existence check and API health validation, but browser navigation fails with an `ENOENT` for `dist/index.html`. Verify that `packages/web/dist/index.html` and `packages/web/dist/assets/` exist after `bun run build:web` before switching to custom. On memory-constrained runs, both Node's V8 heap and the enclosing tool cgroup must be large enough; increasing `NODE_OPTIONS` alone cannot override an already-created cgroup's `MemoryMax`.

The custom unit sets `OPENCHAMBER_MANAGED_RESTART=true` and uses `Restart=on-failure`. This exposes an authenticated managed-restart capability only while OpenChamber is connected to external OpenCode. **Custom Fork > Fork Settings** can request the restart; OpenChamber gracefully closes its own terminals, realtime transports, scheduled work, and server resources, then exits with status `75`. Systemd restarts only `openchamber-custom.service`; `opencode.service` and its active agents remain running, and the browser reloads after the new OpenChamber process reports a different `startedAt`. Manual and unsupported runtimes return a stable unsupported response instead of exiting.

Both OpenChamber units want and start after `opencode.service`, but do not require it. This preserves boot ordering while allowing the active OpenChamber process to supervise an `opencode.service` restart and retain its upgrade operation state. A supervised upgrade immediately closes the server-owned new-turn admission barrier, while existing turns, aborts, and question or permission replies continue. New forks and compactions are also blocked because they can create or mutate session state without appearing in the active-turn map. After already admitted HTTP requests drain and OpenCode's authoritative `/api/session/active` map remains empty across the final quiet check, OpenChamber upgrades and waits synchronously for systemd to finish restarting OpenCode, then waits for readiness, rebinds realtime readers, and reopens turn admission. The queued drain is cancelable and has a 24-hour deadline; upgrade and restart phases are not cancelable.

The external OpenCode service selects an installed shell launcher that preserves the original command for OpenCode parsing and permission approval, then executes it in a transient `opencode-tools.slice` scope. The installer snapshots its current `PATH` into all three service definitions so OpenCode tools retain user-configured command directories; rerun it after changing the desired service `PATH`. Each command defaults to `MemoryMax=3G`, `MemorySwapMax=512M`, `TasksMax=512`, and 16 MiB of combined stdout/stderr. The launcher forwards the first output promptly, then batches later output in full 64 KiB chunks or at command completion; exceeding the byte budget stops the command tree with an explicit diagnosis. Bounding both bytes and update cadence prevents repeated cumulative output snapshots from amplifying inside OpenCode's own cgroup. The aggregate slice defaults to a 6.5 GiB managed threshold (`MemoryHigh=6656M`), a 7 GiB emergency hard limit, `MemorySwapMax=1G`, and `TasksMax=2048`. The OpenCode service is outside that tools slice and uses `MemoryMax=9G`, `MemorySwapMax=2G`, `OOMPolicy=continue`, and `ManagedOOMPreference=avoid`.

Aggregate enforcement is owned by `opencode-tool-memory-supervisor.service`, a restartable service explicitly placed in `app.slice`, outside `opencode-tools.slice`. The supervisor and command admission use one shared lock; spawned systemd, sleep, and file-operation processes close that lock descriptor. Before every command is admitted, the launcher starts the supervisor, takes the lock, and invokes stale-state reconciliation. The supervisor also checks the authoritative frozen state every 100 ms, covering a delayed freeze operation from a killed predecessor. An unmarked stale freeze is thawed. If a previous supervisor died after choosing a victim, its atomically renamed `.pending` marker lets reconciliation finish killing that exact scope, promote the marker to the final diagnosis, and only then thaw the slice. Broad cleanup markers similarly expand to every active scope after restart. This makes a supervisor `SIGKILL` recoverable before, during, and after victim selection.

When authoritative aggregate `memory.current` exceeds `memory.high`, the supervisor freezes the tools slice, validates every populated child against systemd state, and requires the complete scope-to-`memory.current` snapshot to match across two passes. It records a pending diagnosis and SIGKILLs the largest command tree, using the scope name as a deterministic tie-breaker, promotes the diagnosis after the scope is empty, then thaws survivors. The killed command prints that diagnosis before failed-unit cleanup. A command whose own scope reports `Result=oom-kill` likewise prints an explicit cgroup OOM diagnosis before cleanup. If every child cannot be validated and measured reliably, the supervisor marks and terminates all active tool commands with an explicit selection-failure diagnosis instead of claiming a deterministic victim. If the slice cannot be thawed, it similarly marks and terminates all active tool commands. If marked termination itself cannot be confirmed, the slice remains frozen for restart reconciliation rather than resuming uncontained survivors.

This is managed containment, not strict isolation. Freezing makes normal aggregate selection deterministic at the command-tree level, but `MemoryMax=7G` remains an emergency backstop if the supervisor cannot respond before usage crosses the 512 MiB headroom. At that hard parent boundary, Linux/systemd OOM semantics do not guarantee that only the largest command scope is killed; more than one command may be affected. A user-manager outage can also prevent restart or admission reconciliation, although the kernel hard limits remain active. The lower `MemoryHigh` threshold is safe during normal user-manager operation because the out-of-slice supervisor observes the throttle and resolves it instead of leaving an allocating command stalled there indefinitely. The OpenChamber surface units intentionally have no memory controls, so installing and reloading their replacement definitions cannot constrain an already-running legacy service before cutover. Override provider-specific environment variables in mode-0600 `~/.config/openchamber/opencode.env` rather than adding secrets to unit files.

The installer does not activate or restart services by default. This is intentional: replacing a managed OpenChamber while one of its OpenCode requests is active terminates that request. Install and verify first, start the external OpenCode service, then switch from a process outside the OpenChamber service being stopped. Set `OPENCHAMBER_CUSTOM_REPO` while installing when the selectable custom runtime should use another checkout.
