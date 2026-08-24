# Incident: Side-chat fork timeout created ordinary orphan sessions

- **Type:** record
- **Purpose:** Record why `/side` created ordinary forks without opening the panel or sending the prompt.
- **When to read:** When side-chat creation times out on a large parent conversation or leaves an unmarked fork in normal session history.

## Resolution (TL;DR)

OpenCode creates the fork session before synchronously copying its messages, so aborting the request does not cancel or identify the resulting session. The route now waits for the upstream fork without a fixed timeout and acts only on the exact session ID returned after copying completes. It does not infer ownership from structural similarity. A transport failure between OpenChamber and OpenCode can still strand an unidentified ordinary fork because the upstream API has no client-supplied fork ID, idempotency key, or operation-status contract; failing without touching another session is the safe boundary.

## Status

fixed

## Timeline + investigation

- On 2026-08-12, two `/side` attempts against a parent with more than 500 messages exceeded the route's fixed 15-second upstream request timeout.
- OpenCode created the corresponding sessions before copying 513 messages and 3,137 parts in one fork and 517 messages and 3,184 parts in the other. Copying finished after the caller's abort in both cases.
- The aborted response was the only source of the fork session ID. OpenChamber therefore could not mark or delete either fork, and the UI correctly stopped before opening the panel or sending the prompt.
- Installed OpenCode SDK 1.18.12 accepts only `sessionID`, directory/workspace routing, and optional `messageID` for a fork. The server generates the new session ID internally, inherits the parent's metadata, emits session creation, copies all selected messages and parts, and only then returns the session. Metadata inheritance cannot supply authority because an unrelated concurrent fork would inherit the same marker.
- Structural reconciliation was rejected: a similar concurrent fork may be unrelated, and a newly listed fork may still be mid-copy because creation is published before copying completes. Marking or deleting such a candidate risks unrelated user data.
- OpenChamber now leaves the fork request unbounded. Its successful response is the copy-completion boundary and supplies the only session ID that the route may mark or roll back. Ordinary list/marker/delete requests retain bounded timeouts.
- Existing marked side chats are discovered through every cursor page of OpenCode's inclusive global session endpoint, avoiding the former 500-session visibility cap. Only explicit disposable metadata grants duplicate-cleanup authority.
- Browser caller cancellation is not forwarded to the upstream fork, so navigation or a dropped browser connection does not cancel the server-owned operation. OpenChamber process loss or an OpenChamber-to-OpenCode transport failure after dispatch remains ambiguous and cannot be reconciled safely with the current upstream contract.
- The client already preserves repeated `/side <prompt>` semantics: an existing marked side chat is focused and the new trailing prompt is sent to it.

Evidence sources: `journalctl --user -u openchamber-custom.service`, `~/.local/share/opencode/log/opencode.log`, read-only queries against `~/.local/share/opencode/opencode.db`, OpenCode 1.18.12 `Session.fork`, and `packages/web/server/lib/side-chats/routes.js`.

## Follow-up, 2026-08-24

The user approved retiring FC-008 and restoring upstream v1.20 `/btw` as the authoritative behavior. The custom disposable side-chat lifecycle described in this incident is no longer an active fork requirement. This record remains as the history of the timeout and orphan investigation.

Sessions that still carry the old custom marker surface as ordinary sessions. They are not deleted or migrated.
