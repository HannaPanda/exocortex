# ADR-004: Yjs and Hocuspocus for collaboration

* Status: accepted
* Date: 2026-08-04

## Context

Multiple people must edit the same page simultaneously, offline edits must survive
and merge, and the collaboration hot path must not be able to take the REST API down.

## Decision

Yjs is the collaborative data structure, Hocuspocus is the server, one Yjs document
per eXocortex document. The collaboration server is its own process.

Access control uses short-lived, signed, per-document tickets rather than session
cookies:

```ts
interface CollaborationTicketClaims {
  userId: string; documentId: string; access: 'read' | 'write'; expiresAt: number;
}
```

* the API issues them after resolving the caller's role through the policy layer,
* the ticket is signed with `COLLABORATION_TICKET_SECRET`, which is **not** the
  Better Auth secret,
* the Hocuspocus document name is the opaque document id only,
* on connect the server re-checks membership and archival state and applies
  `min(ticketAccess, policyAccess)`.

## Consequences

* The collaboration server never receives permanent authentication material, so a
  compromise there cannot mint sessions.
* A ticket cannot widen permissions and a revoked member cannot reconnect, even
  inside the ticket's TTL.
* One document per page keeps memory bounded and awareness meaningful, and prevents
  content from crossing permission boundaries.
* The client needs a round trip to the API before it can connect. That cost buys the
  properties above and is paid once per document open.
* Scaling to several collaboration instances needs
  `@hocuspocus/extension-redis`; the constructor is the single place to add it.
