# Automations

Rules that react to page changes, or to the clock: a signed webhook, one AI
prompt against the page, or the page by mail to whoever wrote the rule. Issues
#50, #73 and #104, and the reasoning is in
[ADR-024](adr/ADR-024-automations-hang-off-the-outbox.md),
[ADR-038](adr/ADR-038-the-clock-is-the-second-way-an-automation-starts.md) and
[ADR-054](adr/ADR-054-an-automation-may-write-to-its-owner-and-to-nobody-else.md).

## Switching them on

Automations are **off** by default, deployment-wide. Five settings govern them,
and the first two decide whether anything can run at all:

| Setting                              | Scope      | Why                                                                                         |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `automations.enabled`                | workspace  | The main switch. A workspace may switch it off for itself, never on against the deployment. |
| `automations.webhookAllowedHosts`    | deployment | Comma-separated hosts, no scheme and no port. Empty means no webhook rule works.            |
| `automations.maxConsecutiveFailures` | deployment | Failures in a row before a rule switches itself off. Default 5.                             |
| `automations.webhookTimeoutSeconds`  | deployment | How long the receiving server may take. Default 10.                                         |
| `automations.runRetentionDays`       | deployment | How long the run log is kept. Default 30, `0` means for ever.                               |

A webhook rule also needs `CREDENTIAL_ENCRYPTION_KEY` in the environment: the
signing secret is stored the same way a workspace's provider key is (ADR-023).

## Writing a rule

`/arbeitsbereich/<workspaceId>/automationen`, or the catalogue's
`exo_automation_create`. Three decisions:

1. **Scope.** The whole workspace, one page and everything under it
   (`SUBTREE`, the root page included), or one database and its rows
   (`DATABASE`).
2. **Triggers.** One or more of `DOCUMENT_CREATED`, `DOCUMENT_UPDATED` (title
   and properties), `DOCUMENT_CONTENT_CHANGED` (the text), `DOCUMENT_MOVED`,
   `DOCUMENT_ARCHIVED`, `DOCUMENT_DELETED`, `DATABASE_ROW_CHANGED` -- or
   `SCHEDULE`, which is the clock rather than a change and is described in its
   own section below. `DATABASE_ROW_CHANGED` only means something inside a
   `DATABASE` scope, and the other change triggers only outside one.
3. **Action.** `WEBHOOK`, `AI_RUN` or `EMAIL_SELF`.

Plus a debounce window, in seconds, with a floor of 10 and a default of 60. It
is how long the page has to stay quiet before the rule runs, and it is the
difference between one run and one run per paragraph typed.

Only a workspace **OWNER** may write, change, delete or fire a rule. Everybody
in the workspace may read the rules and the run log.

## A schedule instead of a change

`SCHEDULE` is a trigger like the others, on the same rule, with the same actions
behind it. Two rules apply to it and to nothing else:

- **It stands alone.** A rule that watched the clock _and_ a change would have
  two answers to "which page", so the mixture is refused.
- **It needs a page.** Scope `SUBTREE` or `DATABASE`, never the whole workspace:
  the scope document is the page the webhook is about and the page the prompt
  reads, because a clock names none.

Five shapes, and each uses only the fields it needs:

| `scheduleKind` | Fields                                      | Example                     |
| -------------- | ------------------------------------------- | --------------------------- |
| `ONCE`         | `scheduleAt` (an absolute instant)          | "in three days, look again" |
| `DAILY`        | `scheduleTime`                              | 07:00 every morning         |
| `WEEKLY`       | `scheduleTime`, `scheduleWeekday` (0 = Sun) | Sunday evening review       |
| `MONTHLY`      | `scheduleTime`, `scheduleDayOfMonth`        | the 1st, or the 31st        |
| `CRON`         | `scheduleCron`                              | `0 6 * * 1-5`               |

`scheduleTimeZone` is an IANA name and is **required**, never taken from the
server: 07:00 in `Europe/Berlin` stays 07:00 when summer time starts. A monthly
31st means the last day of a shorter month rather than skipping it.

The cron dialect is five numeric fields -- minute, hour, day of month, month,
day of week (0 or 7 is Sunday) -- with `*`, ranges, lists and steps. No names,
no `@daily`, no `L`, no `#`. Both day fields restricted is an **or**, the way
cron has always worked: `0 5 1 * 1` is the first of the month _and_ every Monday.
An expression this parser cannot read is refused when the rule is saved.

`nextRunAt` is on the rule and is what the UI shows. It is computed when the
rule is written and again after each firing, by the same function
(`packages/contracts/src/automation-schedule.ts`) in both places.

Three things follow from `nextRunAt` being a column rather than a repeatable job
in Redis:

- Pausing is `enabled: false`, and switching the rule back on recomputes the
  next run rather than firing for the slot that passed meanwhile.
- A deployment that was down catches up **once**, not once per missed slot.
- A `ONCE` rule ends with an empty `nextRunAt` and stays enabled. It did what it
  was for.

The sweep is `run-due-automations`, every minute, which is also the finest a
schedule can be.

## The webhook contract

A rule's POST carries two headers:

```
x-exocortex-timestamp: 1789412345
x-exocortex-signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`, hex-encoded.
Verify against the **raw** body, before any JSON parsing, and reject a timestamp
that is not recent -- that is what the timestamp is inside the signed material
for.

The body:

```json
{
  "event": "automation.triggered",
  "rule": { "id": "…", "name": "Hermes benachrichtigen" },
  "trigger": "DOCUMENT_CONTENT_CHANGED",
  "origin": "EVENT",
  "workspaceId": "…",
  "document": { "id": "…", "title": "Technik", "type": "PAGE", "parentId": null },
  "occurredAt": "2026-09-12T20:00:00.000Z",
  "correlationId": "…"
}
```

`origin` is `EVENT`, `SCHEDULE` or `MANUAL`: what started the run, which
`trigger` alone stopped answering once the clock could start one.

Metadata only, never the page's text. A receiver that may read the page can come
and read it through the API.

The signing secret is shown **once**, in the response that creates the rule, and
cannot be read back afterwards. Losing it means creating a new rule.

## Where a webhook may go

Two gates, and both of them have to be passed at the moment of the request
(issue #63):

1. The **host allowlist**, `automations.webhookAllowedHosts`. Checked when the
   rule is written and again on every firing, because narrowing the list has to
   stop the rules that already exist.
2. The **address** the connection actually uses. Loopback, `0.0.0.0`, RFC1918
   and RFC4193 private space, carrier-grade NAT, link-local (including
   `169.254.169.254`, the cloud metadata address), multicast and the reserved
   ranges are refused. A written-out address is refused while the rule is being
   saved; a hostname is judged in the moment the socket is opened, so a DNS
   record that changes later, or answers differently the second time, changes
   nothing.

**A webhook is never redirected.** A `301`, `302`, `303`, `307` or `308` fails
the run and no second request is made, because the allowlist governs the URL in
the rule and cannot govern where that URL leads -- and a `307` would hand the
signed body to the new target unchanged. A receiver that has moved is written
into the rule again, and checked again.

That is also why this one request does not use `fetch`: it is made through
`node:http` with a DNS lookup of the worker's own, in
`apps/worker/src/processors/automation/webhook-request.ts`.

## The mail action

`EMAIL_SELF` sends the page to the account that owns the rule, its Markdown
shown as written inside the shared mail layout (`docs/mail.md`), with a link
underneath. Together with `SCHEDULE` that is a daily agenda, a
weekly review or a one-off "send me this on Friday", and it needs no scheduler
code of its own.

**It has no recipient, and that is the whole design** (ADR-054). There is no
column on the rule, no field in the request and no parameter on the tool naming
an address: it is read from `createdById` when the mail is queued. A rule that
could name an inbox would be an allowlist-free way to carry a workspace out of
this deployment, written by whoever can write a rule -- which includes an
agent.

Four things follow:

- The page is fetched **as the owner**, so a rule cannot mail out a page its
  owner may not read.
- The account has to exist, be switched on and have a **confirmed** address.
  Any of those missing **fails** the run rather than skipping it: the rule is
  broken, and it should end up visibly disabled rather than quietly doing
  nothing every morning at seven.
- The body is cut at 10 000 characters on a line boundary, and the mail says it
  was cut.
- `mailSubject` is optional; without it the rule's name is the subject. The
  rendered subject is prefixed `eXocortex:` either way.

The run records `queued`, never `sent`: the relay conversation happens in the
`mail` queue afterwards, under its retry policy, so an SMTP outage delays a
letter instead of failing five runs and switching a working rule off. The
mail's job id comes from the run id, so a retried automation job cannot post
the same morning twice.

There is deliberately **no notification preference** for it. A rule _is_ the
decision to be written to; switching it off is `enabled: false`, where it was
switched on (`docs/notifications.md` has the model for everything that is a
notification).

## The AI action

One prompt, with the changed page's Markdown (capped at 20 000 characters) as
its material. The answer is written back as

- `COMMENT` -- an unresolved comment on the page, or
- `CHILD_PAGE` -- a new page underneath it.

There is deliberately no option to overwrite the page. The model is told it is
not editing.

An AI rule spends the deployment's own provider key, not the workspace's: a
run somebody did not start should not appear on their bill without a decision
that is not modelled yet.

## Debugging a rule

1. `POST /api/automations/:ruleId/trigger` with a `documentId`, or "Jetzt
   ausführen" in the UI, or `exo_automation_trigger`. It skips the debounce. For
   a scheduled rule the `documentId` may be left out: the rule already names its
   page, and the run is logged with `origin: MANUAL` so it is not mistaken for
   the nightly one.
2. Read the outcome: the run log on the page, or `exo_automation_runs`.

A run ends in one of five states. `SKIPPED` is not a failure and does not count
towards the automatic disabling: it means nothing was attempted, and `error`
says why (the rule was off, the workspace switch was off, the owner is gone).

## Telling the owner that a rule stopped working

Issue #107. A rule that switches itself off does nothing from then on, and a
scheduled run fails at an hour nobody is watching. Both are worth a letter to
the rule's owner, and nothing else a rule does is:

| What happened                                                    | Outbox event            | Template                |
| ---------------------------------------------------------------- | ----------------------- | ----------------------- |
| the failure that reaches `automations.maxConsecutiveFailures`    | `automation.disabled`   | `AUTOMATION_DISABLED`   |
| the first failure of a streak, for a run with `origin: SCHEDULE` | `automation.run.failed` | `AUTOMATION_RUN_FAILED` |

So a streak produces at most two mails, however often the rule fails in
between. A run that an event or a person started sends none for its own
failure: an event-driven rule is announced when it switches itself off, and a
person who pressed "Jetzt ausführen" is looking at the result.

`noteFailure` in `apps/worker/src/processors/automation.ts` writes the event
in the transaction that counts the failure, and the switch-off is an
`updateMany` conditional on `enabled: true`, so two runs failing at once
cannot both announce it. A re-enable resets `consecutiveFailures`, which is
what lets the next streak be announced again.

The payload carries ids and a reason from `automationFailureReasonSchema`,
never the error text. `classifyAutomationFailure` in
`apps/worker/src/processors/automation/failure.ts` names the step while the
error still has its type: a 403 or 404 from the API is `PAGE_UNAVAILABLE`, an
owner refusal is `OWNER_UNAVAILABLE`, anything else is the action's own reason.
The run log keeps the message.

`failure-notifications.ts` in the outbox dispatcher decides at dispatch time,
from the state that holds then: the rule still exists (and, for a switch-off,
is still off), the owner exists, is switched on and is still a member of the
workspace, and the `FAILURE`/`EMAIL` pair is not `OFF`. The mail's job id is
the outbox row's id. `docs/notifications.md` has the pair.

Render jobs and project builds do not mail when they fail. A compile error is
the ordinary way a LaTeX build ends while somebody is iterating on it, the
person who started it is watching the build panel, and a letter per failed
compile is how a sender ends up in a filter. A lost worker (`worker_lost`) is
an infrastructure fault and belongs to the alerts.

## Loop protection

An automation's own writes carry the rule they came from. Two consequences:

- A rule never fires on its own action.
- A chain through other rules stops at depth 3.

Neither is configurable, and neither is a substitute for the debounce.

## Extending it

A fourth action means: a member on `AutomationAction`, a branch in `act` in
`apps/worker/src/processors/automation.ts` (a switch over the closed union, so
forgetting the branch is a type error), and the fields it needs as columns
on `automation_rule` -- not a JSON blob, for the reason the schema comment gives.
`automationRuleProblems` in `packages/contracts/src/automations.ts` is where the
cross-field rules live, and both create and update validate the merged rule
against it, so there is one place to say what a coherent rule is.

A new trigger means a member on `AutomationTrigger` and a case in
`triggerForEvent`. If the event it needs is not in the outbox yet, put it there
first -- a trigger whose event nobody emits is worse than no trigger.

A new schedule shape means a member on `AutomationScheduleKind`, the columns it
needs on `automation_rule`, a branch in `dayMatcher` and `candidateMinutes` in
`packages/contracts/src/automation-schedule.ts`, and the cross-field rules in
`schedulingProblems` beside it. The sweep never learns about it: it reads
`nextRunAt` and knows nothing else about time.
