# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer state with a lifecycle: drafts, mobile shell, history, popup placement, draft targeting |
| `submit/` | Turning what the user has into what gets sent |
| `attachments/` | Files: paths, drop payloads |
| `ui/` | Presentation |
| `text.ts` | How inserted text meets the text already there |

## Controller seam

Shared composer presentation reads a harness-neutral, observable
`ComposerController` from `controller/`. State is exposed by `getSnapshot()` and
`subscribe()` and consumed with `useSyncExternalStore`; operations and connected
renderers remain explicit controller dependencies. `ChatInput.tsx` is currently
the OpenCode composition root: it supplies the existing send, queue, abort,
command-menu and model-controls implementations to the provider. Presentation
leaves consume those dependencies
without inspecting a harness kind or importing the connected controls directly.
A different harness must provide the same contract at composition time; do not
add harness conditionals to the editor, footer, autocomplete popups or action
buttons. Existing-session and new-root Prime composers share the same
`PrimeComposerFrame`, `ComposerEditor`, `ComposerFooter`, and mobile shell. The
new-root composition stays in the same centered/compact-responsive placement as
OpenCode and omits attachments and other unsupported affordances. Its model and
thinking controls are a Prime-private local draft selection, never the connected
OpenCode controls and never a mutation of the source Prime session. They use only
a fresh retained Prime snapshot catalog. The initial selected row is explicitly
Prime defaults rather than the source session's current configuration; selecting
any catalog model creates an override, while resetting defaults clears model and
thinking together. Thinking remains an explicit Prime-default/null selection
until the source current model is explicitly selected. Every unconfigured draft
shows Load Prime options. Only that button's direct click refreshes the passive
catalog, privately ranks ready sources by same working directory and then latest
update, and explicitly activates the winner without replacing the visible draft.
The exact arriving fresh snapshot initializes the local controls; no unrelated
retained live snapshot may win. Configured submission passively refreshes that
same source before create. A transport or activation failure remains a safe
pre-create refresh failure, while a new activation generation may be rebased only
when its fresh snapshot still authoritatively publishes the exact selected model
and thinking level. Prime exposes no protocol-v7 pre-session catalog,
so an authoritative empty source catalog leaves the button retriable and explains
that an existing Prime session is required. The composer keeps honest Prime
defaults and remains sendable without options.

The controller boundary is intentionally narrow. CodeMirror handles, caret and
selection state, IME handling, paste/drop behavior, autocomplete placement and
mobile keyboard/overlay state remain local to the shared composer. They are UI
interaction state, not harness state. Likewise, OpenCode model/agent/variant
restoration remains inside `ModelControls.tsx` until its data controller is
separated from that connected component; the composer reaches it only through
the neutral model-controls renderer.

Action availability is explicit in `ComposerActionState`. Presentation must not
infer send or queue eligibility from a session identifier. Harness-private
identities also stay behind the composition root. Draft persistence is keyed by
`(runtime, harness, directory, session)`; Prime new-root drafts use a null session
and their normalized target directory only in this adapter-private state. Neither
OpenCode nor Prime draft targets are published through `ComposerController` or
neutral chat/catalog identities.

## The prompt language

`language/` is the single source of truth for composer syntax. Everything that
needs to know what a token means — highlighting, send-time resolution, and the
autocomplete triggers — goes through it.

**This is the invariant that matters most in this module.** Before it existed,
the `@` rule was written four times with divergent cleanup and the `/` rule
three times with different valid character sets, so a token could be painted as
a reference and then not resolve as one. Adding a construct meant finding every
copy.

- `mentions.ts` — `@` references. The `start..end` span is the reference
  itself and is what gets highlighted; in `see @a/b.ts,` the comma is sentence
  punctuation, not part of the file being referenced. Mentions are plain
  editable text: deleting a character edits the token and reopens the mention
  picker, the same way `/skill` tokens behave — not an atomic delete.
- `prefixTokens.ts` — `/command`, `/skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` stays plain prose.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention`.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
  to the language means adding it here, once.

## The editor

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

The composer previously painted a transparent `<textarea>` over a mirror
`<div>`. That restricted highlighting to styles which do not change glyph
advance width — colour, background, underline — because anything else made the
mirror drift out from under the caret. Bold and italic were impossible, and the
overlay was disabled outright on mobile, where wrapped text drifted anyway.
**Those constraints are gone**; adding a width-affecting style is now a
question of design, not of feasibility.

Selection rendering: every device runs CodeMirror's `drawSelection()` — it
keeps typing on the drawn-selection code path, and removing it makes
CodeMirror enforce cursor association on the native selection, which iOS
answers with severe input lag. Every device also layers
`composerNativeSelectionExtension` (`editor/theme.ts`) on top: it re-shows
the native selection, and — only while a range is selected — the native caret,
hiding the painted layers those replace. The native selection is the one that
shows for two reasons: the painted layer sits behind the content, so tokens
with their own background (inline code, fences) cover it completely; and
iOS's selection drag handles attach to the visible native selection and take
their colour from the caret, so a transparent caret means invisible handles.
The range-only caret scoping is load-bearing — a native caret visible while
typing makes WebKit re-render its caret UI after every keystroke, felt as
severe input lag. The selection tint comes from `--primary`, not the selection
token:
themes define `--interactive-selection` with its own alpha, so a translucent
mix of it is nearly invisible.

`composerLanguage.ts` retokenizes the whole document on every change. The
composer holds a prompt, not a source file: it is short enough that a full pass
is cheaper and far simpler than incremental mapping, and it keeps the editor
and the send path reading the same grammar.

## Ordering rules worth knowing

- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  inline comments and context into OpenCode's one-primary-plus-parts shape. The
  oldest queued message becomes primary; **inline comments attach to the last
  body the user authored** rather than becoming their own part; PR instructions
  precede the PR diff.
- `state/useComposerDraft.ts` — a draft belongs to a (runtime, harness,
  directory, session) identity. Writes are debounced while typing but forced at every edge
  where the page may stop running, because a pending timer is not a saved
  draft. Two orderings are load-bearing: the debounced write is skipped once
  while a draft is being restored, and a deleted draft's empty signature is
  recorded before a queued write could resurrect it.
- `state/useDraftTarget.ts` — the draft can target a directory that does not
  exist yet (a worktree being created). It must survive not appearing in the
  branch list, or the selector snaps back to the project root mid-creation.

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

**Every timeout and `flushSync` in them has a reason recorded next to it, and
none of them is verifiable outside a real device.** Change them only against
hardware.

## Testing

The package has no DOM test environment, so coverage stops at the state and
logic layers: the language, the submit assembly, path and drop handling, text
splicing, message history, and the CodeMirror language extension at the
`EditorState` level.

Rendering, focus, keyboard behavior, IME and WKWebView are **not covered by
tests** and are verified by hand. Do not report a change to them as validated
on the strength of type-check and unit tests.

Run tests per file (`bun test <path>`): `mock.module` is process-global, so
suites that install module mocks are order-dependent.
