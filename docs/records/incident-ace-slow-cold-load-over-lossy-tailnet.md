# Incident: ACE slow cold load over lossy tailnet

- **Type:** record
- **Purpose:** Record why the ACE OpenChamber shell loaded while model and terminal-dependent UI remained pending for a remote Windows client.
- **When to read:** When `https://ace.tail3d1306.ts.net:8453/` is healthy locally but loads slowly or only partially on another tailnet device.

## Resolution (TL;DR)

The OpenChamber and OpenCode backends were healthy and fast. The affected Windows peer had a high-latency, lossy Tailscale path while the nginx endpoint offered only HTTP/1.1 and forced revalidation of content-hashed assets, turning one page load into hundreds of serialized or congestion-limited round trips. Port `8453` now advertises HTTP/2 and gives content-hashed `/assets/` responses a one-year immutable cache policy; OpenChamber was restarted once to remove a secondary orphan process.

## Status

fixed

## Timeline + investigation

- On 2026-08-09, the page shell loaded on `marti-laptop`, but the model selector and terminal-dependent UI remained pending.
- Direct and public probes from ACE were healthy: `/health` reported OpenChamber 1.18.1 with managed OpenCode ready on port `39847`; `/api/opencode/health` returned `{"healthy":true}`; public health and shell requests completed in roughly 8–13 ms.
- An isolated cold browser run on ACE completed normally. Its page load used 250 resources and transferred about 6.5 MB compressed, including 130 application assets totaling about 4.0 MB compressed (18.3 MB decoded). The model metadata response added about 234 KB compressed (3.6 MB decoded).
- The affected Windows load generated 243 nginx requests in 34 seconds: 127 asset requests and 102 API requests. Content-hashed `/assets/` responses use `Cache-Control: public, max-age=0`, so Chrome revalidated the complete asset graph and received 142 `304` responses instead of reusing those files without network access.
- The nginx listener on port `8453` negotiated HTTP/1.1, not HTTP/2. The current configuration also disables proxy buffering globally.
- Live TCP diagnostics for `marti-laptop` showed roughly 70–147 ms RTT, congestion windows as low as 2–10 segments, repeated retransmissions, and observed delivery rates around 0.16–0.68 Mbit/s on several connections. `tailscale ping` reached the peer directly at its current endpoint in 116 ms; this was not a DERP-only route.
- The affected load never completed the model-metadata/config-provider requests in nginx's access log before the browser connection settled or was refreshed. Server-side calls to those endpoints remained successful and fast enough to rule out current OpenCode readiness as the initiating cause.
- The canonical and deployed nginx configurations were updated so the port `8453` TLS listener advertises HTTP/2 and content-hashed `/assets/` responses use `Cache-Control: public, max-age=31536000, immutable`. Root HTML and API responses retain their upstream cache policies.
- `nginx -t` passed before and after reload. Public probes negotiated HTTP/2; a warm isolated-browser reload transferred only three 304 asset responses (900 bytes of Resource Timing overhead) across the 130-entry asset graph instead of revalidating all 130 assets.
- OpenChamber was restarted once, leaving one managed OpenCode child. Public model metadata and provider-config requests completed successfully, and browser probes opened `/api/global/event/ws`, `/api/terminal/ws`, and `/api/openchamber/events` through nginx.
- A first load on an empty cache will still depend on the peer's link quality and includes a large external terminal font. The immutable policy primarily removes repeated asset validation after the first post-change reload.

Evidence sources: `/var/log/nginx/access.log`, `ss -tin`, `tailscale status`, `tailscale ping`, public/local `curl` timing probes, an isolated `tool-use browser` session, and `/home/marti/projects/.nginx-tailscale/ace-tailnet.conf`.
