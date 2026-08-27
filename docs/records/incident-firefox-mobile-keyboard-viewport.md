# Incident: Firefox Mobile Keyboard Occludes Hosted Surfaces

- **Type:** record
- **Purpose:** Record the hosted mobile viewport contract required for Firefox's virtual keyboard.
- **When to read:** When changing the hosted mobile entrypoint, mobile shell sizing, or keyboard-safe fixed surfaces.

## Resolution (TL;DR)

The dedicated hosted mobile entrypoint requests `interactive-widget=resizes-content`, matching the main web entrypoint. Browser mobile surfaces also consume live `visualViewport` geometry: this is required when a browser still exposes a layout viewport larger than the keyboard-visible area. The focused chat composer is pinned to that same visible bottom edge while retaining its content-driven height. Its flex slot reserves both the composer and the keyboard-covered part of the layout viewport so the transcript's readable region ends above the composer.

## Status

fixed

## Timeline + investigation

The reported symptoms were a chat composer partly hidden until typing and a fullscreen terminal with its lower controls behind the keyboard in Firefox mobile. The hosted mobile page is a separate Vite entrypoint at `packages/web/mobile.html`; unlike `packages/web/index.html`, it did not declare `interactive-widget=resizes-content`.

Firefox Android changed its default interactive-widget behavior to `resizes-visual` in Firefox 132 ([Mozilla Bug 1916002](https://bugzilla.mozilla.org/show_bug.cgi?id=1916002)). The visual viewport shrinks, but the layout viewport does not. OpenChamber locks page scrolling and sizes `MobileApp` from the viewport, while `MobileWorkspaceDrawer` renders the terminal as a body-level `fixed inset-0` surface. The ordinary chat composer remains in normal flow and therefore depends on the layout resize or browser focus reveal.

The baseline fix is the viewport declaration in `packages/web/mobile.html`. The shared browser path additionally tracks `visualViewport` in `packages/ui/src/apps/MobileApp.tsx`, sizes browser-only `oc-keyboard-inset-surface` surfaces from the live visible rectangle in `packages/ui/src/styles/mobile.css`, and pins the focused chat form through `useMobileViewportPin`. The pin must not set a fixed form height: the editor grows as text wraps, and freezing the initial height lets the footer and send controls overflow below the keyboard until focus is lost. Fixed positioning also removes the form from its flex slot. Reserving only the form's height is insufficient in Firefox's `resizes-visual` mode because the transcript can still occupy the layout strip behind the keyboard. The slot must reserve the form height plus the distance from the visual viewport bottom to the chat layout bottom. `useChatAutoFollow` also re-pins an already-following transcript when that readable height changes, while leaving a user-released transcript alone. This keeps the browser workaround separate from Capacitor's native keyboard choreography, which remains owned by `useNativeMobileChrome` and the native `Keyboard` configuration.

The first implementation passed automated web build, UI type-check, and UI lint validation. Manual Android API 34 emulator verification in Chrome showed the chat composer controls and terminal header/content above Gboard at a 432x960 viewport. Follow-up use found two existing-chat regressions: a fixed initial form height hid controls as wrapped input grew, and reserving only the form height let it cover the transcript end.

On 2026-08-27 the regressions were reproduced with the official Firefox 154.0.1 x86_64 build on an Android API 34 emulator at 900x2000 with Gboard. The captured cases covered the new-session draft, an existing chat with one-line and multiline input, transcript scrolling, and keyboard-open bottom following. The corrected build kept the draft composer and all controls above Gboard. The constrained emulator became unresponsive while rendering an existing long session after the correction, so the existing-session result remains supported by the corrected measured geometry and automated checks rather than a complete after-capture on that emulator.
