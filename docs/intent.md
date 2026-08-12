# Fork Intent

- **Type:** reference
- **Purpose:** Standing policy for maintaining and developing the `mdatsev/openchamber` fork.
- **When to read:** Always.

## Repository Roles

- `openchamber/openchamber` is the upstream repository and the source of upstream updates.
- `mdatsev/openchamber` is the custom fork and collaboration repository.
- Keep upstream-owned `AGENTS.md`, project skills, and module documentation aligned with upstream. They own OpenChamber architecture, implementation discipline, and validation.
- `docs/fork-requirements.md` owns the active requirements that distinguish the fork from upstream.

## Branch Policy

- Keep `main` as an unchanged mirror of `upstream/main`; never commit fork changes or merge `custom` into it.
- Use `custom` as the shared integration and release branch for the fork.
- Create feature branches from `custom` and integrate them back into `custom`.
- Keep shared history stable. Do not rebase or force-push `custom`.

## Upstream Synchronization

- Before implementing a fork feature or fix, check newer upstream issues, pull requests, and changes for work addressing the same goal.
- When useful, check similar agent tools for alternative approaches and surface materially different solutions before implementation.
- Fast-forward `main` to `upstream/main`.
- Integrate normal fork updates by merging the selected stable upstream release tag into `custom` so the source installation follows published releases rather than unreleased `upstream/main` changes.
- Merge unreleased upstream commits into `custom` only when the user explicitly requests them.
- Give upstream synchronization merges or pull requests an explicit description of the integrated upstream revision or date.
- Before integrating upstream, compare the incoming changes with every entry in `docs/fork-requirements.md`.
- Prefer upstream features that meet the same goal, even when their implementation or UI differs.
- After adopting and validating an upstream feature, remove the replaced fork code and its requirement.
- Ask before integrating any feature that could change fork-only behaviour.

## Agent Git Policy

- When working in a worktree always commit and push your changes to the feature branch.
- Merging to custom requires explicit user instruction.

## Tests

- Follow the shared `agents-md` test policy instead of upstream guidance that would require changing tests.

## Supported Surfaces

- VS Code is not a supported target for fork-only behavior. Fork-only features do not require VS Code implementation, parity, or validation unless the user explicitly requests it.

## Fork-Only Settings

- Place preferences for fork-only behavior under **Custom Fork > Fork Settings**, not in upstream-owned Settings pages.

## Fork Requirements

- Do not change `docs/fork-requirements.md` without explicit user approval. If you find divergences between the requirements and the implementation, report them to the user.
