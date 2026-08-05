# ADR-010: Transactional outbox for reliable domain events

* Status: accepted
* Date: 2026-08-04

## Context

Some domain events must not be lost: a page whose title changed must end up in the
search index even if Redis is briefly unavailable. Publishing to a message bus after
committing a transaction can lose events; publishing before it can announce events
that never happened.

## Decision

Domain mutations write an `OutboxEvent` row **inside the same transaction** as the
state change. A repeatable `dispatch-outbox` maintenance job (every 5 seconds, 100
rows per run) turns unprocessed rows into follow-up jobs and marks them processed. A
failure records `attempts` and `lastError` and is retried; nothing is dropped.

Realtime delivery over the Socket.IO channel happens right after the transaction and
is explicitly best-effort: a failure is logged and the request still succeeds.

This is a narrow outbox, not an event-sourcing framework. The database rows remain
the source of truth; outbox rows are delivery instructions.

## Consequences

* Correctness comes from the outbox, latency from the socket. Both paths exist on
  purpose.
* At-least-once delivery, so every consumer must be idempotent — which they are
  (search indexing is a full upsert, materialization compares timestamps).
* An extra table and a polling job. Polling is cheap because of the partial index on
  `processedAt IS NULL`.
* `AuditLog` uses the same in-transaction pattern, so an audit entry can never exist
  for a rolled-back operation.
