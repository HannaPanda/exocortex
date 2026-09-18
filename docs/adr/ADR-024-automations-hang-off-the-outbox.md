# ADR-024: Automations hang off the outbox, and never overwrite a page

- Status: accepted
- Date: 2026-09-12

## Context

Everything that happens in eXocortex is started by somebody: a person clicks, an
agent calls a tool, a cron fires. There are domain events (the outbox, ADR-010)
and there are jobs (`packages/queue`), and no way to connect the two without
writing a processor and deploying it. "When a page under _Technik_ changes, tell
Hermes" has been solved outside the system, by Windmill, which has to know an
internal nginx port to do it. That works and is tape.

Three cases already exist on this deployment: a new row in the ToDo database
should get a reminder; a page under `Technik` changing should make somebody
check whether a related page has gone stale; a session note landing in the
memory workspace should be announced to Hermes.

## Decision

### The outbox is the only trigger for a change

> Superseded in part by
> [ADR-038](ADR-038-the-clock-is-the-second-way-an-automation-starts.md)
> (issue #73): a rule can also be started by the clock. The sweep there is not a
> second event path -- it reads a column, not events -- and it ends in the same
> `automation` queue, with the same run log and the same refusals. Everything
> below still holds for every trigger that is a change.

`fireMatchingAutomations` runs inside `dispatchOutbox`
(`apps/worker/src/processors/maintenance-tasks/`). It is not a second listener
beside it.

The outbox already sees every domain event exactly once, in order, with
at-least-once delivery and a failure record per row. A rule that listened
somewhere else would be a second thing to keep correct, and the first time Redis
blinked the two would disagree about what happened. Realtime events are the
fast, best-effort half of the same news (ADR-008) and are deliberately not a
trigger: an automation that sometimes does not run is worse than one that runs a
few seconds later.

The cost of this on a deployment with no rules is one cached settings read per
event.

### Triggers are a small vocabulary, not the event names

`AutomationTrigger` has seven members and maps onto event types in one function.
Storing the raw `ApplicationEventType` would have been less code and would have
tied a rule somebody wrote in March to an internal transport vocabulary that
grows whenever the realtime channel needs a new message. `DOCUMENT_UPDATED` and
`DOCUMENT_CONTENT_CHANGED` are separate members because they are the two
questions people ask apart: somebody renamed it, and somebody wrote in it.

`database.row.updated` was declared in the event list and emitted by nothing.
This ADR makes it real, written inside the same transaction as the values it
describes, because a rule watching a database that could only see rows being
created and renamed would be a promise without cover.

### Debounce is a precondition, not a refinement

A page being typed into is materialized every couple of seconds. A rule with an
AI action and no quiet period would pay for a model call per paragraph, so the
contract enforces a floor of ten seconds and the default is sixty.

The window is per rule _and_ per page: `enqueueDebounced` with the job id
`automation-<ruleId>-<documentId>`, capped at twice the window so a page
somebody keeps editing still gets its rule run. One job is one run, which is
also why the event-driven path does not create the run row: a row per event
would fill the log with entries that never get a result.

### Feedback is stopped at two levels, and the first one is the one that matters

An automation's write carries the rule it came from, in a header the API accepts
only on a service token, stamped onto the `outbox_event` row inside the writing
transaction. The dispatcher reads it before it matches anything.

- A rule never reacts to its own action. This is the cheap guard and the one
  that bites: the shape people actually build is "when this page changes, write
  something about it", which without this would rewrite the page it just wrote,
  for ever.
- A chain through _other_ rules stops at `AUTOMATION_MAX_DEPTH` (3). Three is
  already more than anybody can reason about.

The header is read for a decision, unlike the provenance headers of ADR-022, so
`SessionGuard` forgets it for every credential that is not a service token. A
caller who forges it can at worst silence an automation on a request they were
making anyway.

### Two actions, and neither of them overwrites anything

**Webhook**: a signed POST, `sha256=<hex>` over `<timestamp>.<body>` in
`x-exocortex-signature` and `x-exocortex-timestamp`. The timestamp is inside the
signed material, not beside it, so a captured body cannot be replayed. The
signing secret is AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY` exactly like a
workspace's provider key (ADR-023), handed over once at creation and never
readable again. The body carries metadata about the page and never its text:
what the page says is behind this deployment's authentication, and a receiver
who may read it can come and read it.

**AI run**: one prompt against the changed page, written back as a comment or as
a child page. There is no "replace the page" output and there is not meant to be
one. An automation that rewrites content nobody asked it to rewrite is how a
page gets quietly destroyed by a rule somebody set up in March, and the run log
would show it as a success.

The page's text _is_ the model's input here, which is a deliberate difference
from ADR-015. That decision is about the chat quietly sending whatever page
happens to be open; an automation is the opposite, a scope and a prompt somebody
named in a form and saved.

### Three emergency stops, at three different distances

`automations.enabled` is the deployment-wide one and defaults to **off**: an
automation sends data outward or spends money, and neither should begin because
a version was deployed. It is workspace-overridable with the deployment value as
a ceiling, so a workspace may switch its automations off and can never switch
them on against a deployment that said no. That required teaching
`SETTING_CEILINGS` to clamp booleans as well as numbers, with `false` as the
floor.

`AutomationRule.enabled` is the per-rule one, and it is honoured again in the
worker rather than only in the dispatcher: a job sits in a debounce window for
up to two minutes, which is exactly long enough for somebody to press stop and
watch it be ignored.

`consecutiveFailures` is the automatic one. A rule pointing at a host that has
gone away does not get better by being retried every minute for a week; it fills
the run log, and the one signal that something is wrong drowns in the noise it
makes.

### A webhook target is a deployment decision

`automations.webhookAllowedHosts` starts empty, so no webhook rule can be
created or fire until a global admin fills it in. An allowlist that ships open is
not an allowlist. It is checked when a rule is written _and_ again when it
fires, because narrowing it has to stop the rules that already exist, not only
the ones nobody has written yet.

### The allowlist governs the connection, not only the URL

A host allowlist alone is a name check, and a name is not a destination (issue
#63). Two things follow from that, and both are part of this decision rather
than an implementation detail.

A webhook is **never redirected**. An allowed host answering `307` would hand
the signed body, method intact, to a target the allowlist never saw, which turns
one permitted receiver into a way out of the list and into the worker's own
network. A `3xx` fails the run instead, and a receiver that has moved is written
into the rule again.

The **address** is judged where the socket is opened. An allowed name can
resolve into this machine's network, today or after its DNS record changes, so
loopback, private, link-local and reserved addresses are refused at connect
time rather than once at save time. That is what a literal `fetch` cannot do,
which is why this one request is made through `node:http` with a lookup of its
own.

### Writing a rule is the OWNER's act

`canManageAutomations` is OWNER-only, the same bar as a provider key and for the
same reason: a rule keeps acting after the person who wrote it has closed the
tab, sending this workspace's data to a third party or spending money on every
change to every page in its scope. An ADMIN administers how the people here work
together; committing the workspace to an outbound relationship is not that.

Reading the rules and the run log needs only membership. What an automation has
been doing to the pages people work on is not a secret from those people, and a
log only the owner can open is a log nobody reads until something has been
broken for a week.

Mutating `/automations` routes need an `admin`-scoped API token, for the same
reason in the token dimension.

## Consequences

- Two tables, one pair of columns on `outbox_event`, one new queue and one
  nightly sweep (`prune-automation-runs`).
- Every rule runs as the account that created it. A rule whose owner is deleted
  survives as a visible row and stops acting, which is the honest outcome:
  inventing an authority for it would make automations the one way into this
  deployment that answers to nobody.
- The run log is the feature. Without it an automation that runs is
  indistinguishable from one that does not, so `exo_automation_runs` and the
  lower half of the automations page are not accessories.
- A rule can be tried by hand (`POST /api/automations/:id/trigger`). Without it
  the only way to find out whether a rule works is to edit a page and wait out
  the debounce, and an agent that can write a rule but not try it cannot finish
  the job.
- An AI rule cannot be turned into a webhook rule by a PATCH. Its signing secret
  can only be handed over once, and a PATCH response is not a place to hand one
  over.
