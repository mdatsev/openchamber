# Incident: OpenAI OAuth reauthentication required an external OpenCode restart

- **Type:** record
- **Purpose:** Record why successful OpenAI OAuth reauthentication did not fix provider requests through the external OpenCode runtime.
- **When to read:** OpenChamber reports successful provider reauthentication, but new OpenAI turns still fail with `Token refresh failed: 401`.

## Resolution (TL;DR)

The OAuth callback saved a new credential to `~/.local/share/opencode/auth.json`, but the OpenAI compact plugin in the already-running external OpenCode process retained the old credential in memory. Restarting `opencode.service` while no turns were active loaded the new credential; a real GPT-5.6 Sol request then returned `AUTH_OK`.

## Status

fixed

## Timeline + investigation

1. On 2026-08-27, OpenChamber showed `Authentication failed for this provider. Please re-authenticate and retry.` for new OpenAI turns. Persisted assistant errors and `~/.local/share/opencode/log/opencode.log` exposed the underlying error as `Token refresh failed: 401` from `opencode-openai-compact@1.3.1/dist/oauth.js`.
2. Reauthentication completed at 12:26 EEST. The mode-0600 `auth.json` changed at that time and contained a different OAuth access token, refresh token, and expiry from the retained backup. Credential values were not printed or copied.
3. `opencode.service` had retained the same process since the preceding day. OpenChamber's 12:27 manual configuration reload logged `Re-probing external OpenCode server`; it did not restart that process. This is the intended external-runtime contract: `POST /api/config/reload` returns `requiresManualRestart` after confirming that the connected server is healthy.
4. The installed compact plugin explains why a process restart mattered. Its auth loader copies the OpenAI OAuth object into the closure variable `openAIAuth`; request-time refresh reads that variable, and only the plugin's own successful refresh updates it. Saving a replacement credential through the provider OAuth callback does not update this already-loaded closure.
5. The port-4096 `/session/status` and `/api/session/active` endpoints were empty before remediation. Restarting only `opencode.service` produced a new PID and a healthy OpenCode 1.18.23 server. A temporary attached GPT-5.6 Sol session returned exactly `AUTH_OK`; the temporary session was then deleted, and OpenChamber's `/api/opencode/health` remained healthy.

## Remaining risk

`opencode.service` and `computer-deal-opencode.service` isolate their databases but still share `~/.local/share/opencode/auth.json`. Each process can retain a different in-memory OAuth credential. A refresh or reauthentication handled by one process can therefore leave the other process stale until it restarts. This topology is a plausible contributor to future refresh-token failures, but this investigation did not establish which process invalidated the original token.

Evidence sources: OpenCode's local session/message APIs on port 4096, `~/.local/share/opencode/log/opencode.log`, `systemctl --user status`, `packages/web/server/lib/opencode/lifecycle.js`, `packages/web/server/lib/opencode/core-routes.js`, `packages/ui/src/components/sections/providers/ProvidersPage.tsx`, and the installed `opencode-openai-compact@1.3.1` OAuth implementation.
