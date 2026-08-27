# Fork Requirements

- **Type:** reference
- **Purpose:** Active requirements that distinguish `mdatsev/openchamber` from upstream OpenChamber.
- **When to read:** Before implementing fork-only behavior, reviewing the fork's divergence, or integrating an upstream release.
- **Related:** intent.md

## Active Requirements

### FC-001: Disable upstream updates

- Disable in-app upstream updates for the custom fork.
- Still show update notifications, but direct users to merge upstream manually.

### FC-002: Install the fork alongside the official application

- Install the fork as a separate desktop application without changing the official application’s settings.
- Launch it bundled without hot-reload, and save terminal logs to a file.

### FC-003: Distinguish fork instances from the official application

- Add a custom title for OS windows and browser tabs

### FC-004: Search the Changes Walkthrough

- Add `Ctrl`/`Cmd` + `F` search across the full walkthrough, with highlighting and navigation between matches.

### FC-005: Show when an agent needs input

- Show a question indicator (instead of busy) when an agent or hidden subagent awaits user input.

### FC-006: Show when an agent was interrupted

- Show an interrupted indicator (instead of idle) when an unfinished response is no longer running.

### FC-007: Show a background subagent under the agent that spawned it

- Nest it in the spawning Task's chat summary. The child session may remain visible in session navigation.

### FC-009: Prevent accidental file reverts

- Ask for confirmation before reverting a file with uncommitted changes.

### FC-010: Allow viewing files outside the workspace

- Remove restrictions on viewing files outside the workspace.

### FC-011: Synchronize session inbox state across clients

- Sync unread and pinned state across clients connected to the same server.
- Add mark unread button.

### FC-012: Add "move to a new worktree" action to mobile UI

- Match the desktop behavior on mobile.
- When the source worktree has uncommitted changes, let the user name the new branch and directory and choose whether to move those changes.

### FC-013: Highlight changed words in patch previews

- Highlight word-level changes in tool-call patch previews.
- Skip unusually long lines rather than slowing down the UI and show an indicator that the line was skipped.

### FC-014: Worktree diff improvements

- Be able to see changes not merged to the root branch for each worktree.
- Not merged changes include both committed and uncommited changes.
- Let the user view committed changes, uncommitted changes, or both together. Cherry-pick equivalence is not supported.
- Show an orange repository icon on a project when its root checkout has uncommitted changes or commits ahead of its tracked upstream.
- Show an orange worktree icon on a worktree entry when it has committed or uncommitted changes relative to the root branch, or commits ahead of its tracked upstream.
- Show an orange upward arrow on a project or worktree entry when its branch has commits ahead of its tracked upstream.
- When a project is collapsed, show the repository icon, worktree icon, or both according to changes in its root checkout and worktrees.
- Do not repeat checkout status on ordinary session rows inside an expanded project. A compact single-conversation worktree row acts as the worktree entry and shows its changed indicator there.
- In the mixed-project Recent list, show one repository or worktree icon per session: neutral when authoritatively clean and orange when dirty or unmerged. Show no checkout icon for confirmed non-repositories or unresolved state.
- Use compact sidebar rows for worktrees with zero or one conversation.

### FC-015: Update OpenCode in settings

- Show OpenCode update status and actions even after dismissing the update notification.
- Support upgrading the external OpenCode service in the fork's systemd-managed runtime without interrupting active agents.

### FC-016: Switch between official and fork servers without interrupting agents

- Provide a Linux server setup that can switch between official and custom OpenChamber.
- Keep OpenCode and running agents alive while switching or restarting the custom server.

### FC-017: Show Desktop Recent status indicators on Mobile

- Show the same indicators in the mobile recent-session switcher as in Desktop Recent.
- This includes but is not limited to activity, unread, permission, interruption, worktree status, and should cover all future features.

### FC-018: Limit memory used by agent commands

- Limit memory use per command and across all agent commands.
- Keep OpenCode alive when a command exceeds its limit, and report the out-of-memory failure to the agent.
- When aggregate pressure requires selecting a command to stop, reliably stop the most memory-intensive command tree; if reliable selection is impossible, fail explicitly instead of claiming deterministic isolation.

### FC-019: Keep fork-only preferences separate

- Put fork-only preferences in a dedicated Custom Fork settings page.
- Let users choose whether New Chat actions inherit the current worktree.

### FC-020: Resume archived sessions through normal messaging

- Show matching archived sessions under their projects in sidebar search results.
- Before sending a prompt, slash command, or shell input to an archived session, restore it and wait for server confirmation.
- If restoration fails or the runtime changes, do not dispatch the message.
