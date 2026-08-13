# Incident: Descendant session hidden by directory allowlist

- **Type:** record
- **Purpose:** Record why an OpenCode session under a configured project root was absent from OpenChamber even though the connected server returned it.
- **When to read:** When an externally created session is present in `experimental.session.list` but absent from the web or desktop sidebar and Recent section.

## Resolution (TL;DR)

Adding the watcher directory as an exact project made the session appear temporarily, but another open client later replaced the shared project list with an older snapshot. The sidebar now accepts desktop/web sessions below a configured project root while preserving exact-workspace behavior in VS Code and excluding unrelated or undiscovered external-worktree directories.

## Status

fixed

## Timeline + investigation

- On 2026-08-13, session `ses_005474677ffeeBm5s8Hw9G9ZZP` (`Computer deal watcher`) existed in the shared OpenCode database with directory `/home/marti/projects/personal/computer-deal-watcher`.
- Both direct OpenCode `GET /experimental/session` on port 4096 and proxied OpenChamber `GET /api/experimental/session` on port 8795 returned the session. The active custom UI did not render its title.
- OpenChamber had `/home/marti/projects` configured as a project. `SessionSidebar.tsx` nevertheless filtered active sessions through `isKnownActiveSessionDirectory`, which accepted only exact configured project roots and discovered worktree roots. It rejected the watcher directory before Recent or project ownership was derived.
- `sidebar/sessionOwnership.ts` already walks parent directories and would assign this session to the deepest configured project. The early exact-directory allowlist therefore conflicted with the later desktop/web ownership semantics. VS Code intentionally retains exact-workspace matching.
- The allowlist originated in upstream commit `ce39dad5` for [issue #1010](https://github.com/openchamber/openchamber/issues/1010). That change removed speculative filesystem listing of persisted session directories and filtered stale deleted-worktree sessions, but it also excluded valid descendant directories.
- Upstream [issue #1441](https://github.com/openchamber/openchamber/issues/1441) separately requests that Recent show sessions from directories OpenChamber did not explicitly open. Its stated multi-server discovery cause does not apply here because the connected external OpenCode server already returned the watcher.
- Adding `/home/marti/projects/personal/computer-deal-watcher` through the Add Project dialog persisted the exact directory in the authoritative `~/.config/openchamber/settings.json`, and the session rendered with its existing history. Browser storage is only a synchronized startup mirror, not independent project authority.
- The workaround did not persist. Server logs show a `projects` save at 17:54 that added the watcher and another `projects` save at 17:55 that restored the older three-project snapshot. Project mutations persist the complete client snapshot, so an already-open client with stale in-memory project state can overwrite a newer project list. This last-write-wins race is a separate existing shared-settings limitation, not evidence that projects are browser-local.
- `https://ace.tail3d1306.ts.net:8453/` proxies to regular OpenChamber on port 8792, which was inactive and returned `502`; the selected custom runtime on port 8795 is exposed at `https://ace.tail3d1306.ts.net:8455/`. This URL distinction explains the earlier `502` but not the session-discovery defect: both services use the same OpenCode backend and canonical OpenChamber settings.
- The implemented fix preserves the stale external-worktree safeguard and exact VS Code behavior while allowing desktop/web sessions whose normalized directory has a configured project root as an ancestor.
