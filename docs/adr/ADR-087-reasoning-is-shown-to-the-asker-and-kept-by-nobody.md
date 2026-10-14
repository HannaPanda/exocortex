# ADR-087: reasoning is shown to the person who asked, and kept by nobody

- Status: accepted
- Date: 2026-10-14
- Relates to: ADR-008 (separate sockets), ADR-029 (withdrawn access reaches open connections), ADR-073 (the run timeline holds facts, never content), ADR-083 (subscription presets), issue #6, issue #195

## Context

Since issue #6 the provider adapter dropped every reasoning fragment and
passed on only its length, so the panel could say "KI denkt nach" without the
thinking leaving the adapter. The reason was sound: reasoning is not the
answer, and on an event bus or in a log it would spill into places the user
never asked for.

Issue #195 asks to show it, the way current chat clients do, without
inventing any of it. Before deciding anything, both endpoints that serve the
default model were measured with real requests on 2026-10-14 (the matrix is
in the issue): DeepSeek V4.1 Flash streams its reasoning live, token by token,
in `delta.reasoning` on OpenRouter and on Cline Pass alike, repeats it in
`delta.reasoning_details[].text`, and sends all of it before the answer and
the tool calls of the same turn. Neither needs it back for the tool loop.

What changes is who may see the thinking, not whether it is private.

## Decision

- **The adapter passes the fragment on, beside the answer, never in it.**
  The `reasoning` stream event carries `text`; `resultText` is untouched.
  Only `delta.reasoning` is read, `reasoning_details` repeats it.
- **One event addressed to a person.** The worker coalesces fragments for
  200 ms (`ReasoningRelay`) and publishes `ai.run.reasoning` with
  `recipientUserId`, the run's `createdById`. The gateway delivers it to that
  person's sockets that are subscribed to the run's workspace, and to
  nobody else: the user room alone would reach a tab whose membership was
  just withdrawn (ADR-029), the workspace room alone is everybody. Every
  other `ai.run.*` event keeps going to the workspace, and `ai.run.phase`
  still names the silence for anybody watching.
- **Nothing keeps it.** No column on the run, no row in the timeline (which
  stays facts, ADR-073), no line in a log, no heartbeat write, no replay. A
  reload, a reconnect or a dropped frame loses it, so its `sequence` orders
  and does not repair, unlike the answer's. The panel says so in the trace.
- **It is not sent back.** A follow-up turn carries the assistant's text and
  tool calls only. Measured: on Cline, returning the reasoning suppressed the
  next turn's thinking.
- **The panel names what it has.** "Gedankengang" only when reasoning
  arrived, "Aktivitäten" for tool calls alone, nothing for a run with
  neither, so a model that does not stream its thinking is never shown as
  thinking. The trace is outside the transcript's live region, so a screen
  reader does not read the thinking aloud word by word.

## Consequences

- A person sees what a model reasoned about their question while it
  reasons, and never afterwards; there is nothing to export, audit or leak
  later, and nothing to delete.
- An agent or a colleague in the same workspace sees the phase and the tool
  calls of somebody else's run, as before, and not the thinking.
- MCP and the built-in AI gain no tool: there is nothing stored to read, and
  a run's facts stay readable through the run inspector.
- A model that reasons without streaming it (or a provider that drops it)
  simply shows activities; nothing has to be configured per model.
- Measuring this showed that the "aus" thinking level never meant "no
  thinking": the field was left out and DeepSeek reasoned at its default.
  Since 2026-10-14 `effort: none` is sent, and a model whose reasoning
  OpenRouter reports as `mandatory` no longer offers "aus" at all, because it
  answers `none` with a 400.
