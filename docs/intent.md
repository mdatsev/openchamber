# Fork Intent

- **Type:** reference
- **Purpose:** Standing policy for maintaining and developing the `mdatsev/openchamber` fork.
- **When to read:** Before choosing a branch, performing Git operations, synchronizing upstream, or deciding whether a change belongs only in the fork.
- **Tracker:** none

## Repository Roles

- `openchamber/openchamber` is the upstream repository and the source of upstream updates.
- `mdatsev/openchamber` is the custom fork and collaboration repository.
- Keep upstream-owned `AGENTS.md`, project skills, and module documentation aligned with upstream. They own OpenChamber architecture, implementation discipline, and validation.
- Shared `agents-md` guidance owns machine-wide and cross-repository workflow.
- This document owns fork-specific branch, synchronization, contribution, and Git-operation policy. Do not duplicate upstream technical guidance here.
- `docs/fork-changes.md` owns the active index of implementation differences from upstream.
- Follow OpenChamber's repository-specific architecture and technical rules when they differ from general engineering defaults.

If instructions materially conflict and their ownership does not resolve the conflict, stop and ask the user.

## Branch Policy

- Keep `main` as an unchanged mirror of `upstream/main`. Do not place custom commits on it.
- Use `custom` as the shared integration and release branch for the fork.
- Create feature branches from `custom` and integrate them back into `custom`.
- Keep shared history stable. Do not rebase or force-push `custom`.
- Never merge `custom` into `main`.

## Upstream Synchronization

- Before implementing any new fix or feature, check upstream issues, pull requests, and changes newer than the fork's current upstream base for related discussion or an existing implementation. Also check relevant agent harnesses and other projects for comparable goals or features, how they were implemented, and whether they achieve the user's desired outcome through an approach different from the one requested. Treat those approaches as potential inspiration and surface a materially different implementation choice to the user rather than assuming the requested mechanism is the only valid solution. Use those findings to decide whether and how the request should be implemented: identify existing workflows that already achieve the goal, alternative formulations or solutions, prior design trade-offs, constraints, pitfalls, edge cases, and reasons earlier proposals were not implemented. This review must inform the implementation approach as well as avoid duplicating work and unnecessary fork divergence.
- Fast-forward `main` to `upstream/main`.
- Integrate normal fork updates by merging the selected stable upstream release tag into `custom` so the source installation follows published releases rather than unreleased `upstream/main` changes.
- Merge unreleased upstream commits into `custom` only when the user explicitly requests them.
- Give upstream synchronization merges or pull requests an explicit description of the integrated upstream revision or date.
- Resolve conflicts and validate the affected surfaces before treating an upstream synchronization as complete.
- Before integrating upstream, compare the incoming changes with every entry in `docs/fork-changes.md`.
- When upstream implements the same fix or behavior as an indexed fork change, remove the fork implementation and its index entry, then use the upstream implementation to minimize divergence.
- When an upstream change is similar but different, affects the same owning area, or might only partially replace an indexed fork change, stop and ask the user before continuing the integration.
- Treat uncertain equivalence as overlap that requires the user's decision, not as permission to retain or remove the fork implementation silently.
- Keep generally useful upstream contributions separate from fork-only work. Prepare an upstream contribution from `upstream/main`, and only when the user requests it.

## Agent Git Policy

- Agents may run read-only Git commands without separate approval when needed to understand or verify work. This includes status, diff, log, branch inspection, and remote inspection.
- An explicit implementation request permits creating or switching local feature branches and worktrees when needed for that task.
- Staging, committing, stashing, merging, rebasing, pushing, force-pushing, creating or updating pull requests, and changing branch protection require an explicit user request. A request to commit includes staging the intended changes.
- Preserve unrelated working-tree and staging-area changes.

## Tests

- Follow the shared `agents-md` test policy instead of repository guidance that would otherwise require adding or updating tests.
- Do not add, modify, delete, or regenerate tests or test snapshots unless the user explicitly requests test changes.
- Agents may inspect and run existing tests for validation.
- When repository guidance would require test changes, report the unmet requirement and ask the user rather than changing tests implicitly.

## Source Runtime State

- Keep the source-run Electron browser profile isolated as `OpenChamber Dev`; do not point it at the packaged application's Electron `userData` directory.
- Share canonical OpenChamber backend state through the standard `~/.config/openchamber` directory and OpenCode sessions through the standard OpenCode data directory.
- Treat browser-only state as intentionally local to each profile and origin. See `docs/fork-runtime-state.md` for the storage boundary.
- The packaged and source applications may run simultaneously, but avoid concurrent edits to the same shared setting or metadata because cross-process writes can be last-writer-wins.

## Supported Surfaces

- VS Code is not a supported target for fork-only behavior. Fork-only features do not require VS Code implementation, parity, or validation unless the user explicitly requests it.

## Inbox Semantics

- A running agent uses the live activity indicator and is not unread. Only the final response after the agent finishes can create unread state; read/unread state must not replace or compete with the running indicator.
- An agent error uses its separate persistent error state until the session is restarted. Error state is not unread state and must not be represented by unread metadata.

## Skills

- Load every applicable repository-local skill under `.agents/skills` as required by OpenChamber's `AGENTS.md`.
- The shared `agents-md` restriction on implicitly invoking manual skills applies only to user-facing skills owned by `agents-md`; it does not prevent loading mandatory repository-local skills.

## Documentation

- Follow both OpenChamber's repository-specific documentation requirements and the shared `agents-md` documentation workflow.
- Maintain `docs/fork-changes.md` whenever a fork-only implementation difference is added, changed, replaced by upstream, or removed.
- Update the owning OpenChamber documentation when behavior, module ownership, contracts, invariants, or user-facing instructions change and existing documentation would otherwise become inaccurate.
- Use the narrowest applicable `agents-md` document for durable intent, decisions, incidents, operational procedures, non-obvious constraints, or incomplete work.
- Do not document transient discussion, obvious code behavior, unverified guesses, or context already captured in the narrowest applicable document.
