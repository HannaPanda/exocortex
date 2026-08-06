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
  messages a user typed are part of a run. **Superseded for document images**
  by [ADR-012](ADR-012-vision-preprocessing.md): a configured vision model
  describes them as text, which is sent externally. Everything else in this
  ADR is unaffected.
* Two later clarifications, neither of them a reversal:
  1. **The tool loop is the way content leaves.** Once `ai.toolsEnabled` is on,
     the model can call `exo_page_read` and the page's text is part of the next
     request. That is a user-controlled action per turn, not a standing export
     of the workspace, which is why it is not treated as a second exception.
  2. **The open page is named in the system prompt** (title, breadcrumb,
     `documentId`, type — see "Page context" in `docs/ai-architecture.md`).
     That is metadata, not content, and it exists precisely so the model can
     use the tool above instead of being fed the page unasked.
* **Superseded for the open page's text, when switched on**, by
  [ADR-015](ADR-015-page-content-in-the-prompt.md): `ai.pageContextEnabled`
  (default **off**) puts the page's derived Markdown into the system prompt, for
  deployments whose model cannot call tools. With the default left alone this
  ADR's promise is unchanged. A selection the user hands over from the editor is
  not covered by it either way: that is content the user picked and sent.
* Capabilities are data, so the UI can adapt (for example hide vision features) once
  more providers exist.
