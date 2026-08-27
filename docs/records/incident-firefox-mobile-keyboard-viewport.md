# Incident: Firefox Mobile Keyboard Occludes Hosted Surfaces

- **Type:** record
- **Purpose:** Record the hosted mobile viewport contract required for Firefox's virtual keyboard.
- **When to read:** When changing the hosted mobile entrypoint, mobile shell sizing, or keyboard-safe fixed surfaces.

## Resolution (TL;DR)

The dedicated hosted mobile entrypoint requests `interactive-widget=resizes-content`, matching the main web entrypoint. Browser mobile surfaces also consume live `visualViewport` geometry: this is required when a browser still exposes a layout viewport larger than the keyboard-visible area. The focused chat composer is pinned to that same visible bottom edge while retaining its content-driven height, and its flex slot reserves the same live height so the transcript remains fully scrollable.

## Status

fixed

## Timeline + investigation

The reported symptoms were a chat composer partly hidden until typing and a fullscreen terminal with its lower controls behind the keyboard in Firefox mobile. The hosted mobile page is a separate Vite entrypoint at `packages/web/mobile.html`; unlike `packages/web/index.html`, it did not declare `interactive-widget=resizes-content`.

Firefox Android changed its default interactive-widget behavior to `resizes-visual` in Firefox 132 ([Mozilla Bug 1916002](https://bugzilla.mozilla.org/show_bug.cgi?id=1916002)). The visual viewport shrinks, but the layout viewport does not. OpenChamber locks page scrolling and sizes `MobileApp` from the viewport, while `MobileWorkspaceDrawer` renders the terminal as a body-level `fixed inset-0` surface. The ordinary chat composer remains in normal flow and therefore depends on the layout resize or browser focus reveal.

The baseline fix is the viewport declaration in `packages/web/mobile.html`. The shared browser path additionally tracks `visualViewport` in `packages/ui/src/apps/MobileApp.tsx`, sizes browser-only `oc-keyboard-inset-surface` surfaces from the live visible rectangle in `packages/ui/src/styles/mobile.css`, and pins the focused chat form through `useMobileViewportPin`. The existing-chat pin must not set a fixed height: the editor grows as text wraps, and freezing the initial form height lets the footer and send controls overflow below the keyboard until focus is lost. Fixed positioning also removes the form from its flex slot; without an explicit placeholder height, the chat viewport expands behind the composer and cannot scroll its final content above it. The position tracker reads the form's current height each frame, moves it upward as it grows, and applies that height to its slot so the transcript and composer remain separate flex regions. This keeps the browser workaround separate from Capacitor's native keyboard choreography, which remains owned by `useNativeMobileChrome` and the native `Keyboard` configuration.

The first implementation passed automated web build, UI type-check, and UI lint validation. The hosted service was restarted and health-checked. Manual Android API 34 emulator verification in Chrome showed the chat composer controls and terminal header/content above Gboard at a 432x960 viewport. Follow-up use on Firefox found two existing-chat regressions. First, the form's fixed initial height caused the send controls to move offscreen as wrapped input increased the editor height. Second, removing the form from flex layout without reserving its live height let it cover the end of the transcript. The follow-up removes the form height lock and preserves the same live height on its flex slot. Firefox Android still needs direct confirmation after this follow-up because the available official `fennec-latest` download is an obsolete ARM APK and is not installable on the emulator.
