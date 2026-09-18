# Automations

Rules that react to page changes, or to the clock: a signed webhook, or one AI
prompt against the page. Issue #50 and issue #73, and the reasoning is in
[ADR-024](adr/ADR-024-automations-hang-off-the-outbox.md) and
[ADR-038](adr/ADR-038-the-clock-is-the-second-way-an-automation-starts.md).

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
3. **Action.** `WEBHOOK` or `AI_RUN`.

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

## Loop protection

An automation's own writes carry the rule they came from. Two consequences:

- A rule never fires on its own action.
- A chain through other rules stops at depth 3.

Neither is configurable, and neither is a substitute for the debounce.

## Extending it

A third action means: a member on `AutomationAction`, a branch in
`apps/worker/src/processors/automation.ts`, and the fields it needs as columns
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
