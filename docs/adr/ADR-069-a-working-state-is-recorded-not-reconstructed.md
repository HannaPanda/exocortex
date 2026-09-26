# ADR-069: a working state is recorded, not reconstructed from a transcript

- Status: accepted
- Date: 2026-09-26
- Relates to: ADR-066 (work items), ADR-067 (attention items), ADR-068 (human
  checkpoints), ADR-046 (memory checkpoints), ADR-032 and ADR-063 (provider
  routing), issue #142, issue #136, issue #42

## Context

Since ADR-068 a question pauses the run that asked, and the answer carries it
on in the same conversation. That covers one kind of interruption and relies
on one thing staying true: the conversation is still there, and the model that
reads it is the one that wrote it. Work stops for other reasons too -- a
provider out of quota, a deploy that loses the worker, a timeout, a person
cancelling, a budget -- and after most of them the next attempt was a new run
that started from the goal and the previous result, or a model asked to read
somebody else's transcript and guess where things stood. Issue #142 asks for
an explicit working state a later run can continue from, with another model or
provider if need be, without the old conversation.

The memory checkpoint of ADR-046 is a different thing with a similar name. It
answers "what should an agent know for good" and is written before a
compaction; this answers "what am I doing on this task, what is done and what
is left" and is worthless once the task is closed. Keeping the two apart is a
requirement of the issue, not a style choice.

## Decision

**A working state is a row of its own, never edited.** `work_item_checkpoint`
holds a summary in words and a structured state (`workCheckpointStateSchema`:
the plan with each step `done`, `in_progress` or `open`, assumptions, findings,
the last action and the next step), the pages the work made or relies on, the
blocking decisions open at the time, the budget as it stood, and the model and
provider of the run. The newest row is the state; the older ones are how the
work got there. It hangs on the work item, not on a run, because the work
outlives its runs (ADR-066), and not in the memory workspace, because it is not
memory.

**Whoever does the work records it, and a record carries the last one
forward.** `exo_work_item_checkpoint` takes any subset of the fields; what is
left out is copied from the previous checkpoint, an empty list clears a list
and `null` clears a line, and only the first checkpoint must bring a summary.
That makes "step two is done" one field rather than a restatement of
everything, which is what makes an agent actually write one after each step.
The assignee may record one whatever their role, like any other progress.

**eXocortex records one at the points where work stops without the worker
deciding so.** A blocking question writes a `waiting_for_human` checkpoint in
the transaction that raises it, with the asker's `workState` as its summary
when it gave one. A run behind open work that ended failed, timed out, lost its
worker or was cancelled gets a `run_interrupted` checkpoint from the minute
sweep `checkpoint-interrupted-runs`, carrying the last state forward with the
run's error code and its last tool call. Both are `system: true`. A sweep
rather than a hook for the same reason as ADR-067's failure sweep: a run ends
in several places. A partial unique index over `aiRunId` for interrupted runs
makes a second pass write nothing.

**A page is recorded at its revision.** Each page carries the
`DocumentContent.yjsUpdatedAt` it had when it was named, the same revision
ADR-068 binds approvals to. A reader is shown whether the page has moved on
since, and a resumed run is told to read such a page again, because a finding
about its old state may no longer hold. A carried-forward page keeps the
revision it was named at: carrying is not re-reading.

**A new run starts from the newest checkpoint by default.** `POST
/api/work-items/:id/runs` takes `fromCheckpoint` (`latest` is the default,
`none` starts from the goal, an id names an older one) and a `modelSlug`. The
first message is the ordinary work item prompt with a section added: the
state, the pages with their marks, every decision settled since the checkpoint
(worded exactly as a resumed conversation is told them, one shared function),
the decisions still open, and the budget now. It says that the old transcript
is not available, so the run does not look for it. `run_started` records the
checkpoint in the history. A retry from the inbox is such a run, so a provider
out of quota followed by a retry on another model loses nothing that was
recorded.

**The transcript path of ADR-068 stays, and falls back to this one.** When an
answer arrives and the paused run's conversation is still there, it is carried
on in place, as before; the model reads more than any checkpoint says. When the
conversation is gone, the answer now starts a new run from the newest
checkpoint instead of being recorded as `resume_failed`.

## Consequences

- Two tools, `exo_work_item_checkpoint` and `exo_work_item_checkpoints`, in the
  `workItems` domain on both surfaces; `exo_work_item_start_run` takes
  `fromCheckpoint`. The run prompt tells the built-in AI to record a checkpoint
  after each larger step and before it stops.
- The work item page shows the newest state under "Arbeitsstand" with the
  older ones folded away, and the start dialog offers to continue from it and a
  choice of model. A person does not write checkpoints in the browser: a person
  changes the work by answering, editing or starting a run.
- A checkpoint states what the worker said. It is not verified against the
  pages, and a run that never records one leaves only the system checkpoints,
  whose summary is the last one somebody wrote, or empty.
- Choosing a provider automatically when one is out of quota is not part of
  this; that is the scheduler of issue #147. What this guarantees is that such
  a switch does not lose the working state.
- Work checkpoints go with their work item when it is deleted for good, and
  are never swept into the memory's fact layer (ADR-021).
