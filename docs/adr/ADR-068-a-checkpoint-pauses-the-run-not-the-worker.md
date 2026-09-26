# ADR-068: a checkpoint pauses the run, not the worker, and the answer carries it on

- Status: accepted
- Date: 2026-09-26
- Relates to: ADR-066 (work items), ADR-067 (attention items), ADR-022 (agent
  sessions), ADR-016 and issue #120 (page revisions), issue #140, issue #141,
  issue #142

## Context

With ADR-067 an agent could ask a person something about a piece of work and
the work moved to `waiting_for_human`. What happened next was left open: the
answer went into the history and the work back into the queue, and somebody
had to start the next attempt by hand, in a new conversation that knew nothing
of the first. A run that asked also went on running after it asked, so a write
it had planned behind a request for approval could happen before the approval
did. Issue #140 asks for human checkpoints as a protocol: the work pauses
without a process staying open, the answer is tied to exactly that checkpoint,
and the workflow continues with it. An approval has to say what it approves,
and an old approval must never apply to a state that has since changed.

## Decision

**A checkpoint is an attention item, not a second table.** It gains five
columns: `blocking` (the work waits on it), `context`, `action` (what an
approval approves, required for one), `workState` (the asker's account of
where the work stands, handed back verbatim) and `subject` (what an approval
is bound to). Everything else a checkpoint needs (who asked, the options, the
answer, who gave it, when) the row already records once raised and once
settled, which is the audit trail. A new table would have been a second
inbox to keep in step with the first.

**Only work waits.** A question about no work item, and a conflict, are never
blocking. A blocking question moves its work item to `waiting_for_human`
(ADR-067, unchanged); a non-blocking one is recorded and stays open when the
waiting state ends, because it never held anything up. A `review` may be asked
for, but only on a work item, and asking is moving the item into `review`: the
state raises its one review item and the request's context rides on it.

**The run that asked is read from a signed claim, never from a request.** The
worker signs the run's id into every service token its tool loop mints
(`ServiceTokenClaims.runId`); `SessionGuard` puts it into the request context
and clears it for every other credential; `WorkItemActor.runId` carries it
into every item raised in that request, a system item included. A run id a
caller could choose is a conversation a caller could choose to resume in.

**Pausing ends the run.** A tool result may say `pausesRun`; the built-in loop
then ends the run after that turn, as completed, and answers any further call
of the same turn with "not executed" rather than running it, because a write
queued behind a request for approval is exactly the write the approval is
about. Nothing stays open; an answer days later needs no process that waited
for it.

**The answer resumes in the paused conversation.** When the last blocking
answer on work the assistant holds arrives, `WorkItemResumeService` posts it
into the paused run's own conversation as the next user message, as the
conversation's owner, with the work item attached through the internal
parameter of ADR-066. The message names every answer since the pause with who
gave it, the working state, and the rules for reporting back; the model reads
it with its whole transcript still in context. The work moves from `queued` to
`working`, the history says `run_resumed`, and each answered item records the
new run as `resumedRunId`. Work a person or an external agent holds is not
resumed: they pick it up themselves and read the answer where they always did.
A returned review resumes the same way, because a person sending work back is
an answer too; a failed run's retry does not, because it starts a run of its
own.

**A resume that cannot happen never loses the answer.** The answer is
committed before the resume is tried. A spent budget, a conversation that is
gone or busy is written as `resume_failed` with its code and as `resumeError`
on the answered item, and the work stays in the queue for somebody to start.
This is also why the status is still not derived from a run (ADR-066): the
resume makes the same one move a started run makes and no other.

**An approval is bound to page revisions.** `subjectPages` names pages; each is
recorded at `DocumentContent.yjsUpdatedAt`, the one revision a write compares
`expectedYjsUpdatedAt` against (issue #120). A revision the asker sent that is
already stale is refused (`attention_subject_changed`). Answering compares
again: an answer given after a page moved settles the approval as obsolete
with `subject_changed` instead of approving a state nobody saw, and the run
hears that it approved nothing. A resumed run is handed the revisions to send
as `expectedYjsUpdatedAt`, so a change after the answer is refused by the write
itself rather than by a promise. What is compared is the content alone; a
rename or a move does not change what an approval to write a page was about.

## Consequences

- `exo_attention_request` takes `blocking`, `context`, `action`, `workState`
  and `subjectPages`, and `review` on a work item; `exo_attention_list` takes
  `conversationId`. No new tool: the capability is the old one done properly.
- The card in the inbox, on the work item and now under a chat's transcript
  shows the action, the pages with a warning once one moved, and folds away the
  context and the working state. A settled card says whether the work went on.
- An external agent's checkpoint is not resumed by eXocortex: it has no run
  here and no conversation to post into. It reads the answer with
  `exo_attention_get` or `raised_by_me`, as before.
- A person who answers within a second of the pause can find the conversation
  still busy with the paused run's last write; that is recorded as
  `resume_failed` (`ai_conversation_locked`) and the work waits in the queue.
- Notifying the recipient by push or mail is still a separate decision
  (ADR-052); the decision itself stays in eXocortex.
- A changeset is the second member of the subject union since #141 (ADR-070),
  bound by the hash of its changes the way a page is bound by its revision;
  deciding its last change is an answer that carries the paused run on.
  Provider-independent resume from explicit checkpoints came with #142
  (ADR-069) and builds on `workState`.
