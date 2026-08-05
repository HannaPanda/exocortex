# ADR-008: Separate application and collaboration sockets

* Status: accepted
* Date: 2026-08-04

## Context

The application needs two kinds of realtime traffic: high-frequency document updates
plus awareness, and lower-frequency domain events (tree changes, job progress, AI
streaming). Multiplexing both over one connection is possible but couples them.

## Decision

Two channels:

| Channel | Path | Protocol | Server |
| ------- | ---- | -------- | ------ |
| collaboration | `/collab` | Hocuspocus/Yjs | `apps/collaboration` |
| application | `/realtime` | Socket.IO | `apps/api` |

Domain events never travel over the Yjs protocol and awareness never travels over
the application channel. Cross-process fan-out uses a validated Redis pub/sub bus
(`packages/queue/src/event-bus.ts`): any process publishes, every API instance
re-emits into its local rooms.

Rooms are derived server-side from a `workspaceId`; clients never send raw room names
and every subscription is authorized against workspace membership.

## Consequences

* The Yjs protocol stays a pure CRDT transport, so it can be scaled, replaced or
  proxied independently.
* The worker can publish events to browsers without being a Socket.IO server — the
  reason the Redis bus was chosen over the Socket.IO Redis adapter. Using both would
  double-deliver events.
* Events are validated on publish *and* on receive, so a misbehaving publisher cannot
  inject arbitrary payloads into browsers.
* The browser holds two WebSocket connections per open document. Acceptable, and both
  are same-origin behind nginx.
