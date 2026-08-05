# Fork Runtime State

- **Type:** reference
- **Purpose:** Storage boundaries between the official packaged application and the source-run custom fork.
- **When to read:** Before changing Electron profile identity, browser persistence, source launch behavior, or running packaged and source applications simultaneously.
- **Related:** intent.md, fork-changes.md, ../packages/electron/README.md

## Shared State

| State | Default location | Shared between packaged and source |
|---|---|---|
| OpenCode sessions, messages, and projects | `~/.local/share/opencode/opencode.db` | Yes |
| OpenCode authentication and configuration | `~/.local/share/opencode/`, `~/.config/opencode/` | Yes |
| OpenChamber settings and projects | `~/.config/openchamber/` | Yes |
| Session folders | `~/.config/openchamber/sessions-directories.json` | Yes, with browser mirrors |
| Electron browser profile | `~/.config/OpenChamber` or `~/.config/OpenChamber Dev` | No |

The source runtime deliberately keeps the `OpenChamber Dev` Electron profile. This isolates Chromium local storage, cookies, window state, service workers, and embedded-browser data while leaving sessions and canonical server settings shared. The installed custom launcher uses content-hash-cached built UI assets without HMR; terminal development may still opt into HMR with `bun run electron:dev`.

## Browser-Local State

Browser storage is scoped by both Electron profile and page origin. Packaged and bundled-UI source runs use `openchamber-ui://app`; HMR source runs use `http://127.0.0.1:<port>`. The separate packaged/source Electron profiles still isolate those applications even when their page origin matches. A changed HMR port creates another browser-storage namespace.

Important durable key families include:

| Keys or prefixes | Contents |
|---|---|
| `ui-store` | Layout, selected settings surface, rendering preferences, notification options, shortcuts, and model UI preferences; many values also synchronize to server settings. |
| `themeMode`, `lightThemeId`, `darkThemeId`, theme mirror keys | Theme selection and derived splash colors. |
| `projects*`, `activeProjectId*`, `lastDirectory`, `pinnedDirectories` | Browser mirrors of projects and directories plus local ordering. |
| `oc.sessions.folders.v2:*` | Runtime-scoped mirror of server-backed session folders. |
| `oc.sessions.pinned.v2` | Browser-only pinned sessions. |
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
- Session-folder, magic-prompt, and Git-identity metadata can have similar cross-process write races.
- Both managed OpenCode servers use the same SQLite database. SQLite locking protects database integrity, but simultaneous mutation of the same session can cause lock delays or stale process-local views.
- Different OpenCode versions may interpret or migrate shared data differently.
- Both applications can emit notifications and consume CPU and memory for their own UI, server, and managed OpenCode process.

Running both applications for observation or separate work is acceptable. Avoid editing the same setting, metadata record, or session concurrently, and keep their OpenCode versions compatible.
