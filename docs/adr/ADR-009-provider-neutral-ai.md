# ADR-009: Provider-neutral AI architecture

* Status: accepted
* Date: 2026-08-04

## Context

Model providers change quickly, pricing changes faster, and self-hosters will want
their own. Coupling application logic to one vendor's SDK would make switching a
rewrite. CLI coding agents additionally need process isolation.

## Decision

All AI access goes through `AiProvider` (`generate`, `stream`, `capabilities`) in
`packages/ai`. Application code never imports a vendor SDK. Usage reporting,
cancellation, timeouts and budgets are part of the contract, not of an
implementation.

CLI agents get a separate contract, `AgentRunner`, which declares its isolation level
explicitly. Runners may only be executed from `apps/worker`, never from a process
serving HTTP or WebSocket traffic.

## Consequences

* Adding a provider is one file plus a registry entry plus a config enum value.
* The mock provider makes the entire streaming path testable without network access
  or cost, and it is the default.
* The OpenRouter adapter exists but refuses to run without an API key, so it cannot
  silently start making paid calls.
* No document content is sent to an external provider at this stage; only the
  messages a user typed are part of a run.
* Capabilities are data, so the UI can adapt (for example hide vision features) once
  more providers exist.
