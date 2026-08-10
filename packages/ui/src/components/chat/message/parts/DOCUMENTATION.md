# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact/grouped mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Mount the directory-scoped child-session subscription only for a Task with both an authoritative child `sessionId` and a validated visible directory. Ordinary tools and directory-unresolved Prime views must not call OpenCode child-store hooks or borrow a stale OpenCode directory.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.
  - Background Task calls made by a subagent remain in that parent Task's child-session summary; ordinary nested foreground Tasks and todo bookkeeping remain hidden.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface.
- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- The managed `openchamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- Expandable IPython rows scan a bounded source prefix and prefer a meaningful file operation, subprocess, mutating call, or assignment-to-call over setup data and reads for the single-line collapsed preview. A first-content-line `%%bash` cell magic labels the row `Bash`, skips setup commands and scores command chains for a meaningful shell preview, and selects Bash highlighting for the expanded input while preserving the original cell text. Completed rows show bounded nonblank input/output line counts and duration; edit-result metadata may add grouped per-file `+A -R` summaries and expanded shared diff views, with an explicit count when bounded entries were omitted. These are display-only snippet diffs because the daemon does not provide complete file-line context; safe in-workspace paths expose only file navigation, while basename-only outside-workspace entries expose no file action. Exact redundant `Edited <path>` output is suppressed only when every bounded diff was projected.
- Running bash output falls back to `state.metadata.output` until canonical `state.output` arrives. Its fixed-height output viewport follows new output until the user scrolls up, then resumes following when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Read or Skill in compact mode":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles `read` or `skill` in `StaticToolRow`.
3. Keep all other tool header/output behavior in `ToolPart.tsx`.
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: only navigation tools use the compact static path; all other tools need observable input and output.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove a tool name from `STATIC_TOOL_NAMES` only when it has a reliable direct in-app navigation action
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate both modes (`sorted` and `live`).

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`

## Transcript inputs

Message-part renderers consume the SDK-neutral models in `../../transcript/types.ts`. OpenCode SDK records and compatibility payload normalization stop at `../../transcript/openCodeTranscriptAdapter.ts`; leaf renderers use neutral `kind` discriminants and normalized tool state only. Do not cast neutral parts back to SDK `Part` values.

