# Incident: ACE managed OpenCode restart timeout

- **Type:** record
- **Purpose:** Record why the ACE OpenChamber web UI became unreachable even though its HTTP server and UI authentication remained healthy.
- **When to read:** When ACE serves the OpenChamber page but mobile or browser clients show “Unable to reach server,” or `/api/opencode/health` reports that the OpenCode port is unavailable.

## Resolution (TL;DR)

ACE was running the globally installed OpenChamber 1.16.3, whose managed-process wrapper did not expose `exitCode` or `signalCode`. A transient failed health probe was therefore misclassified as a process exit; the subsequent managed OpenCode restart timed out twice and left OpenChamber without an active OpenCode port. Stopping the service removed the orphan processes, upgrading the global package to 1.18.1 installed the 1.17.1 managed-restart fix, and starting the service restored the public UI and OpenCode backend.

## Status

fixed

## Timeline + investigation

- On 2026-08-08, the Android Firefox client at tailnet address `100.122.36.88` successfully reached `https://ace.tail3d1306.ts.net:8453/`. Nginx returned successful UI assets and `/auth/session` responses, ruling out Tailscale reachability, the nginx route, Desktop Network Access, and UI-session authentication.
- The same client repeatedly received `503` from `/api/opencode/health`. Direct inspection of `/health` reported `openCodePort: null`, `openCodeRunning: false`, and `lastOpenCodeError: "Timeout waiting for OpenCode to start after 30000ms"`.
- The systemd journal showed periodic health checks at 18:59, 20:29, and 20:35 local time classifying managed OpenCode as exited. The last recovery tried ports `43849` and `35461`; both startup attempts timed out, even though the resulting orphan processes later listened on those ports behind Basic authentication.
- The installed global package reported OpenChamber 1.16.3. Its `createManagedOpenCodeServerProcess` wrapper returned only `url`, `pid`, and `close`, while `hasChildProcessExited` treated missing `exitCode` and `signalCode` properties as proof of exit because `undefined !== null`.
- The repository checkout was at 1.18.1 and contained both sides of the correction: wrapper getters for `exitCode` and `signalCode`, and nullish-safe liveness checks. `CHANGELOG.md` records the user-facing fix in 1.17.1: managed OpenCode no longer restarts repeatedly during a temporary connectivity failure.
- OpenCode logs also recorded a long `models.dev` fetch timeout during the failed restart window. This explains the startup timeout but was not the initiating fault; the false liveness classification made a transient health failure destructive by starting the unnecessary restart.
- At 22:53 local time, the systemd user service was stopped, the global `@openchamber/web` package was upgraded from 1.16.3 to the npm-published 1.18.1 release, and the service was started again. The old managed processes on ports `43849` and `35461` were removed.
- After a periodic health cycle, OpenChamber and its managed OpenCode process retained the same healthy port and PID. Public checks through `https://ace.tail3d1306.ts.net:8453` returned `200` with an authenticated UI session and `{"healthy":true}` from `/api/opencode/health`.

Evidence sources: `journalctl --user -u openchamber.service`, `/var/log/nginx/access.log`, `http://127.0.0.1:8792/health`, the installed `@openchamber/web/server/lib/opencode/lifecycle.js`, and the repository `packages/web/server/lib/opencode/lifecycle.js`.

## Follow-up: retry cleanup leak on 1.18.1

On 2026-08-09, real periodic health failures again reached the 20-failure threshold. The first managed restart attempt on port `41815` timed out after 30 seconds, the retry succeeded on `34169`, and a later health-triggered restart moved the active backend to `39847`. The process from the timed-out `41815` attempt remained alive as a child of OpenChamber and consumed about 250 MB RSS even though `/health` correctly identified only `39847` as active. This was not the cause of the concurrent remote cold-load incident because active health and API probes were fast. A deliberate OpenChamber service restart removed the orphan and launched one managed child on port `46013`; retry cleanup remains incomplete in application behavior and should be investigated separately.
