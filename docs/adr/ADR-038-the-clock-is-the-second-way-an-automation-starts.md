# ADR-038: the clock is the second way an automation starts

- Status: accepted
- Date: 2026-09-18

## Context

[ADR-024](ADR-024-automations-hang-off-the-outbox.md) says automations are
triggered from the outbox and nowhere else, and gives a good reason: the outbox
already sees every domain event exactly once, in order, with at-least-once
delivery, so a second event path would be a second thing to keep correct and the
two would disagree the first time Redis blinked.

Issue #73 asks for the thing that sentence excludes. A daily briefing, a Sunday
project review, a research note to look at again in three days, a monthly
summary: none of them is a reaction to a change. They are the other half of what
people mean by an automation, and without them this deployment can only answer
"when something happens", never "every morning".

Three questions had to be settled first.

**Is a scheduled rule the same kind of thing as an event rule?** It shares the
whole second half: a scope, an action, a webhook or a prompt, an output, a
failure counter, a run log, an owner whose authority it acts with. It differs in
the first half only.

**What page does it act on?** Every action here needs a subject. A webhook says
which page it is about; an AI run reads one. An event supplies that subject. A
clock does not.

**Where does the schedule live?** BullMQ can hold a repeatable job per rule,
which is the obvious answer and the one that goes wrong quietly: the rules are
rows in Postgres, the schedulers would be keys in Redis, and every create,
update, delete, disable and restore would have to keep the two in step. A
flushed Redis would silently stop every scheduled rule in the deployment, and
nothing would be able to tell.

## Decision

**A schedule is a trigger on the existing rule, not a second entity.**
`AutomationTrigger` gains `SCHEDULE`, and `automation_rule` gains the seven
columns a schedule needs plus `nextRunAt`. Everything after the trigger is
untouched: the same actions, the same allowlist, the same loop guards, the same
run log, the same refusals.

**`SCHEDULE` is exclusive, and a scheduled rule names its page.** A rule that
listened to both the clock and a change would have two different answers to
"which page", so the contract refuses the mixture. And because the clock names
no page, a scheduled rule needs a `SUBTREE` or `DATABASE` scope: its scope
document _is_ the subject.

**The next run is a column, not a scheduler.** `nextRunAt` is computed when the
rule is written and again after each firing, by one pure function in
`packages/contracts/src/automation-schedule.ts` that the API and the worker both
call. A maintenance sweep (`run-due-automations`, every minute) asks one indexed
question -- which enabled rules are due -- and hands each to the same
`automation` queue the outbox dispatcher uses. Postgres holds the truth; Redis
holds only jobs in flight, and losing it loses nothing but a minute.

**The rule is moved on before it is queued.** The update is a claim: it filters
on the `nextRunAt` it read, so two workers that see the same batch both try and
exactly one writes. A worker that dies between the two writes loses one firing,
which is the failure mode to prefer over a rule that fires every minute until it
manages to write.

**A deployment that was switched off catches up once.** The next run is computed
from now rather than from the missed slot. A daily briefing owes nobody the
three briefings it did not write, and a queue of them is how a returning
deployment spends a morning's model budget on yesterday.

**Time zones belong to the rule.** An IANA zone is stored per rule and never
inferred from the server, so 07:00 stays 07:00 across a daylight saving change.
The conversion is the same two-pass offset lookup the calendar reminders use.

**The cron dialect is ours and it is small.** Five numeric fields with ranges,
lists and steps. No names, no `@daily`, no `L`, no `#`. An expression this
parser cannot read is refused when the rule is written rather than misunderstood
at half past four, and a library would have been a third party deciding what
`0 5 31 * *` means in February.

**A run says what started it.** `AutomationRun.origin` is `EVENT`, `SCHEDULE` or
`MANUAL`, beside the trigger rather than folded into it: the nightly run that
failed and the run somebody started by hand to find out why are the same rule
and the same trigger, and a log that cannot tell them apart cannot answer the
question it exists for.

## Consequences

- ADR-024's "from the outbox and nowhere else" now reads: from the outbox and
  from the clock, and those two are all. Both end in the same queue, and neither
  can act without passing the same refusals in the processor.
- A scheduled rule can be paused (`enabled: false`), and switching it back on
  recomputes the next run instead of firing immediately for a slot that passed
  while it was off.
- Firing a rule by hand no longer needs a page id when the rule has one of its
  own, which is what makes a scheduled rule testable in one press.
- The finest schedule is one minute, because the sweep's cadence is. Anything
  finer would be a job queue with a cron syntax, which is not what this is.
- A `ONCE` schedule ends with `nextRunAt` empty and the rule still enabled. It
  did what it was for; switching it off would claim something went wrong.
