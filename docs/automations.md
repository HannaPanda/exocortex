# Automations

Rules that react to page changes: a signed webhook, or one AI prompt against the
changed page. Issue #50, and the reasoning is in
[ADR-024](adr/ADR-024-automations-hang-off-the-outbox.md).

## Switching them on

Automations are **off** by default, deployment-wide. Two settings before
anything can run:

| Setting                            | Scope      | Why                                                       |
| ---------------------------------- | ---------- | --------------------------------------------------------- |
| `automations.enabled`              | workspace  | The main switch. A workspace may switch it off for itself, never on against the deployment. |
| `automations.webhookAllowedHosts`  | deployment | Comma-separated hosts, no scheme and no port. Empty means no webhook rule works. |
| `automations.maxConsecutiveFailures` | deployment | Failures in a row before a rule switches itself off. Default 5. |
| `automations.webhookTimeoutSeconds`  | deployment | How long the receiving server may take. Default 10. |
| `automations.runRetentionDays`       | deployment | How long the run log is kept. Default 30, `0` means for ever. |

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
   `DOCUMENT_ARCHIVED`, `DOCUMENT_DELETED`, `DATABASE_ROW_CHANGED`. The last one
   only means something inside a `DATABASE` scope, and the others only outside
   one.
3. **Action.** `WEBHOOK` or `AI_RUN`.

Plus a debounce window, in seconds, with a floor of 10 and a default of 60. It
is how long the page has to stay quiet before the rule runs, and it is the
difference between one run and one run per paragraph typed.

Only a workspace **OWNER** may write, change, delete or fire a rule. Everybody
in the workspace may read the rules and the run log.

## The webhook contract

A rule's POST carries two headers:

```
x-exocortex-timestamp: 1789412345
x-exocortex-signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`, hex-encoded.
Verify against the **raw** body, before any JSON parsing, and reject a timestamp
that is not recent — that is what the timestamp is inside the signed material
for.

The body:

```json
{
  "event": "automation.triggered",
  "rule": { "id": "…", "name": "Hermes benachrichtigen" },
  "trigger": "DOCUMENT_CONTENT_CHANGED",
  "workspaceId": "…",
  "document": { "id": "…", "title": "Technik", "type": "PAGE", "parentId": null },
  "occurredAt": "2026-09-12T20:00:00.000Z",
  "correlationId": "…"
}
```

Metadata only, never the page's text. A receiver that may read the page can come
and read it through the API.

The signing secret is shown **once**, in the response that creates the rule, and
cannot be read back afterwards. Losing it means creating a new rule.

## The AI action

One prompt, with the changed page's Markdown (capped at 20 000 characters) as
its material. The answer is written back as

- `COMMENT` — an unresolved comment on the page, or
- `CHILD_PAGE` — a new page underneath it.

There is deliberately no option to overwrite the page. The model is told it is
not editing.

An AI rule spends the deployment's own provider key, not the workspace's: a
run somebody did not start should not appear on their bill without a decision
that is not modelled yet.

## Debugging a rule

1. `POST /api/automations/:ruleId/trigger` with a `documentId`, or "Jetzt
   ausführen" in the UI, or `exo_automation_trigger`. It skips the debounce.
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
on `automation_rule` — not a JSON blob, for the reason the schema comment gives.
`automationRuleProblems` in `packages/contracts/src/automations.ts` is where the
cross-field rules live, and both create and update validate the merged rule
against it, so there is one place to say what a coherent rule is.

A new trigger means a member on `AutomationTrigger` and a case in
`triggerForEvent`. If the event it needs is not in the outbox yet, put it there
first — a trigger whose event nobody emits is worse than no trigger.
