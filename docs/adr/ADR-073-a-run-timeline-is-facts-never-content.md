# ADR-073: a run's timeline is recorded as facts, never as content, and joined rather than copied

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-031 (tracing is optional and in band), ADR-059 (a run says
  what it spent its calls on), ADR-060 (tool subsets), ADR-066 to ADR-070
  (work items, attention, checkpoints, working states, proposals), issue #145,
  issue #42

## Context

A run of the built-in AI could say how it ended (status, error code, the
diagnosis of ADR-059) and what it cost in total, and with a collector
configured its spans told an operator where the time went. Nobody using the
product could answer "what did the agent actually do, and why": which model
answered through which provider, which tools it called and how long each
took, which question it asked and how it was carried on, and above all what
its prompt was made of. Traces answer that for whoever runs the deployment,
leave it for a collector with a different access model, and are off by
default. Logs are not a product surface at all.

## Decision

**A run records its steps as `ai_run_event` rows while it happens.** One row
per step, numbered within the run: the context the first turn was built from,
each exchange with the provider, each tool call, each compaction, each
truncated answer picked up again. The worker writes them through
`RunTimeline`, which chains the inserts, swallows a failed one with a warning
and is flushed before the terminal status is written. The inspector is a view
on the run, never part of it: a run that answered correctly must not fail
over its bookkeeping.

**What is recorded is facts, never content.** Ids, counts, sizes, names,
durations and outcomes, shaped per kind by `aiRunEventDataSchema`. The
observability rule for spans applies unchanged: no prompt, no message, no
tool argument or result, no page text. A tool call is its name, its target
as the catalogue names it (`document:<id>`), the size of its answer, whether
the cap cut it, the origin of foreign text it brought in (ADR-030), whether it
repeated an earlier answer (ADR-059) and whether it paused the run (ADR-068).
That is also why the rows outlive the retention sweep that empties a run's
texts: there is nothing in them to prune.

**The context is measured from what was actually sent.** The system prompt
reports itself as parts (`PromptSection`) with the sources behind each one:
rule pages, the open page and whether it went as a pointer or with its text,
pinned sources and whether they were embedded or named. The worker adds the
role and mode notes, image descriptions, the transcript split by role and the
tool schemas, measures every part from the very messages it hands the
provider and records one `context` event. Tokens are estimated with the route
planner's arithmetic, and the screen says so.

**What other tables already know is joined at read time, not copied.** A
question the run raised and how it was settled (`attention_item.aiRunId`), a
proposal it made (`changeset.aiRunId`), a working state recorded during it
(`work_item_checkpoint.aiRunId`), the run an answer carried it on in and the
run it carries on (`resolution.resumedRunId`), and the run's own creation,
start and end. A second copy would be a second truth that can disagree.

**Reading is reading the run.** `GET /api/ai/runs/:id/inspection` asks what
`GET /api/ai/runs/:id` asks, membership of the run's workspace, and shows
less: the run's answer text is left out. A source or a tool target is named
by a title looked up in the run's workspace and nowhere else; a page that is
gone stays an unnamed size. `exo_ai_run_inspect` serves the same to external
agents and, like `exo_ai_run_get`, is not offered to the built-in AI, which is
what is being inspected.

**The operator's tools are referenced, not rebuilt.** The run keeps its
correlation id, which every log line of the run carries, and its trace id
when tracing is on. The inspector names both; it does not grow its own
distributed tracing.

**The upstream provider is read from the gateway.** OpenRouter names the
provider that served a request in its response; `AiUsage.servedBy` carries
it, a turn records it, and the summary counts a turn served by a different
provider than the one before as a switch. That is a fact about where the
turn went, not a claim about why.

## Consequences

- Every run of the built-in AI has a timeline from 2026-10-11 on; an older
  run shows only the joined half and says so (`recorded: false`).
- A run writes a few dozen rows more. `AI_RUN_EVENT_LIMIT` (600) is the
  floor under a misconfigured tool limit, and the screen says when it was
  reached.
- A new kind of step is a new member of the discriminated union, a recording
  call in the worker and a line in the inspector; an unknown kind in an old
  row is skipped on read, never fatal.
- What the person sees is bounded by the same rule the spans are. A feature
  that wants to show content in the inspector has to argue against this ADR,
  not around it.
