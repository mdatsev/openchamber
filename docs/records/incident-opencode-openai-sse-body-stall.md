# Incident: OpenAI SSE body stall left a session busy

- **Type:** record
- **Purpose:** Record why an OpenAI GPT session remained busy without output and whether a newer OpenCode release fixes the failure mode.
- **When to read:** When an OpenAI session remains busy after tools complete but emits no reasoning, text, tool, completion, or error events.

## Resolution (TL;DR)

Two observed OpenAI requests produced no model lifecycle event and remained pending beyond OpenCode's five-minute response-header deadline. The best-supported explanation is that the requests received HTTP response headers and then stopped before their first parsed SSE event, but the local logs do not prove whether the silence originated in OpenAI's Codex backend, Cloudflare/network routing, Bun fetch/connection pooling, or the AI SDK parser. OpenCode 1.18.10 definitely has no default model-stream inactivity timeout, so none of those upstream or transport failures can reach retry handling and the session remains `busy`. OpenCode 1.18.18 and current `dev` retain this recovery gap; upstream PR [anomalyco/opencode#40010](https://github.com/anomalyco/opencode/pull/40010) proposes an adaptive stream-inactivity watchdog but was still open on 2026-08-13.

## Status

workaround

## Timeline + investigation

1. At 2026-08-13 11:10:48 EEST, OpenCode 1.18.10 started step 2 for an `openai/gpt-5.6-sol` turn immediately after the preceding step's web fetches completed. One web fetch had timed out normally; no tool remained active.
2. The new assistant message persisted with zero parts and no completion or error while `/session/status` continued to report `busy`. The OpenCode server stayed responsive, and unrelated GPT-5.6 Sol sessions continued making progress.
3. The live OpenAI provider configuration contained `headerTimeout: 300000` and no `chunkTimeout`. The turn remained pending beyond five minutes. The same timeout had successfully raised `ProviderHeaderTimeoutError` twelve times for GPT-5.6 Sol on 2026-08-10, so the evidence strongly favors headers arriving followed by a response body or parser that never yielded its first model event. It does not provide packet-level proof of that boundary.
4. OpenCode's provider fetch wrapper creates an SSE body watchdog only when `provider.openai.options.chunkTimeout` is explicitly positive. Without it, `reader.read()` has no deadline, no error reaches the retry policy, and the processor's cleanup cannot transition the session out of `busy`.
5. At 11:23:30 EEST, the user cancelled the turn. OpenCode immediately logged `error=Aborted`; a retry submitted at 11:23:33 produced model output and launched child tasks, confirming that the server, credentials, and model route were still usable.
6. Source comparison found no relevant change between OpenCode 1.18.10 and the latest stable 1.18.18. Release notes from 1.18.11 through 1.18.18 do not claim this fix, and current `dev` still defaults only `headerTimeout` for OpenAI.
7. Upstream issue [anomalyco/opencode#37580](https://github.com/anomalyco/opencode/issues/37580) identifies the same missing default chunk timeout. PR [anomalyco/opencode#40010](https://github.com/anomalyco/opencode/pull/40010) adds a provider-neutral inactivity watchdog and routes timeout failures through existing retry handling, but it is not released or merged.
8. OpenCode 1.18.10 already supports two opt-in mitigations: set a positive `provider.openai.options.chunkTimeout`, or enable `OPENCODE_EXPERIMENTAL_WEBSOCKETS=true`. The WebSocket path has a 15-second connect timeout, a five-minute idle timeout, bounded retries, and HTTP fallback. Both mitigations require deliberate rollout because an inactivity deadline that is too short can interrupt legitimate long reasoning silence, and the WebSocket transport remains experimental on stable channels.
9. The failure recurred in child session `ses_005c75d02ffe2fIja8fr9y38Np`. It completed three normal GPT-5.6 Sol model/tool rounds, then started step 3 at 11:25:00 EEST. The new assistant message had no parts, completion, or error for 10 minutes 5 seconds. The session was cancelled at 11:35:05; only then did the message complete with `MessageAbortedError`. Its sibling child continued completing many GPT-5.6 Sol calls in the same OpenCode process, which rules out a dead OpenCode server and makes a Task-orchestration deadlock unlikely for this occurrence.
10. The recurrence supports the same no-event stream failure but does not establish the external trigger. Application-level transport instrumentation can localize a future failure to the wait before response headers, before the first raw response-body bytes, or between raw bytes and the first parsed model event. Even that evidence may not distinguish an OpenAI backend pause from an intermediary or network pause when no bytes arrive.
11. Increased recent frequency is plausible without a new local regression. OpenCode 1.18.10 made no relevant OpenAI/provider/session change from 1.18.9. OpenAI reported an API, Codex, and Work Mode incident on 2026-08-11, and current public reports include Codex `/responses` requests remaining silent for minutes before an error and succeeding immediately on retry. This supports a recent provider/service degradation activating an older OpenCode recovery gap, but it is correlation rather than proof for these two requests.

## Next-occurrence capture plan

1. Use an instrumented build matching the deployed OpenCode revision. This requires a controlled process replacement or a separate isolated process; changing log level on 1.18.10 is insufficient because its fetch and SSE-reader paths contain no relevant debug events.
2. Generate one correlation ID per model request. Log only timestamps, provider/model, URL origin, response status and content type, safe provider request IDs, byte counts, event types, errors, aborts, and terminal state. Never log authorization headers, request bodies, response bytes, prompts, credentials, or model output.
3. Instrument the provider fetch wrapper around `fetchFn(...)` to record request start and fetch resolution. Fetch resolution is the observable response-header boundary used by OpenCode's `headerTimeout` cleanup.
4. Instrument `wrapSSE` around each `reader.read()` to record the first raw body chunk, subsequent chunk timing and byte count, stream close, read error, cancellation, and abort. This separates a post-header no-byte stall from a parser-level stall.
5. Instrument the AI SDK `fullStream` adapter to record the first parsed event and terminal event. This separates raw SSE activity that the AI SDK does not turn into model events from a session processor that fails after parsed events exist.
6. Optionally correlate process socket activity with `ss`, `strace`, or a packet capture. TLS encryption and possible HTTP/2 connection sharing mean those tools alone cannot identify header, SSE, or parser boundaries.
7. Keep `chunkTimeout` disabled only for the bounded diagnostic run so instrumentation observes the original behavior. Cancel a no-event request after the required boundaries are captured; do not leave it pending merely to exceed the old five-minute threshold.

Evidence sources: `~/.local/share/opencode/log/opencode.log`, OpenCode's local session and status APIs on port 4096, the running provider configuration, OpenCode tags `v1.18.9`, `v1.18.10`, and `v1.18.18`, current upstream `dev`, issue `#37580`, PR `#40010`, [OpenAI's 2026-08-11 incident](https://status.openai.com/incidents/01KZSC0T66YTVM57N5T79SV8ZV), and [openai/codex#37837](https://github.com/openai/codex/issues/37837).
