# Session Inbox

## Purpose

This module owns durable per-session unread and pin metadata for web, Desktop, hosted mobile, and Capacitor clients connected to one OpenChamber server.

## Semantics

- Running and retrying sessions use live status and do not mutate inbox state.
- Only a top-level assistant `message.updated` event with `finish: "stop"` automatically creates unread state.
- Session errors retain their separate persistent error presentation and never become unread metadata.
- Manual Mark as unread creates a server-issued token.
- Mark as read clears only the unread token observed by the client, so a delayed read cannot clear a newer completed response.
- Pin mutations are server-serialized and last-write-wins.

## Persistence

`runtime.js` stores a versioned snapshot at `~/.config/openchamber/session-inbox.json` by default. Each record is keyed by normalized directory plus session ID and contains `unreadToken`, `pinned`, and a server-issued revision. Writes are serialized, written to a temporary file, atomically renamed, committed in memory, and only then broadcast.

Missing storage is distinct from an authoritative empty file. Malformed storage fails loading instead of becoming empty state. Records have no age or count eviction; authoritative session deletion removes them.

## Routes And Events

- `GET /api/session-inbox` returns the authoritative snapshot.
- `PATCH /api/session-inbox/sessions/:sessionId` accepts `read`, `unread`, `pin`, `unpin`, and `delete` actions with an explicit directory.
- Persisted mutations broadcast `openchamber:session-inbox.updated` through the existing notification SSE and global message WebSocket fanout.

The routes are registered after the shared `/api` authentication gate and before the generic OpenCode proxy. They require normal runtime bearer authentication and no URL-auth allowlist changes.

## UI Ownership

`packages/ui/src/stores/useSessionInboxStore.ts` is the active-runtime projection. A successful snapshot is authoritative; fetch or parse failure preserves prior state. Realtime records are revision-checked, and snapshot hydration restarts if a newer local or realtime mutation arrives while its request is in flight.

`oc.sessions.pinned.v2` remains a browser mirror and one-time migration source for pre-inbox pins. After migration, server state is authoritative.
