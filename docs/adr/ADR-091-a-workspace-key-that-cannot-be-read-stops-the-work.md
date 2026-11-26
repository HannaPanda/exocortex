# ADR-091: A workspace key that cannot be read stops the work

- Status: accepted
- Date: 2026-11-26
- Amends: ADR-023 (a stored row that cannot be decrypted falls back to the
  deployment key), ADR-090 (the same fallback, kept open for covers)
- Relates to: ADR-059 (a run says what went wrong), issue #52 (workspace
  keys), issue #225 (a refused key), issue #252 (covers), issue #260

## Context

ADR-023 let a workspace bring its own OpenRouter key, stored encrypted under
the deployment's `CREDENTIAL_ENCRYPTION_KEY`. For a stored row that could not
be decrypted, and for a deployment that had no usable encryption key at all,
it chose to keep the workspace working: the run went to the deployment's key
and was recorded as deployment-paid.

Issues #225 and #252 then settled the neighbouring case the other way. A key
the provider refuses (401, 402) ends the run or the cover, and nothing steps
in for it, because nobody else agreed to pay. The undecryptable row was left
as the one silent fallback onto somebody else's account, and ADR-090 named it
as an open decision. The person answering for the bill decided it on
2026-11-26: stop and say so.

## Decision

**A workspace that has a key of its own is never paid for by the deployment's
key.** `aiKeyFor(workspaceId)` looks the row up first. No row: the deployment's
key, as before. A row it cannot read: it throws `WorkspaceKeyUnreadableError`
with one of two reasons, and the caller ends its work.

- `undecryptable`: the row does not decrypt with this deployment's key
  (rotated, restored from an older `.env`, a damaged row). The workspace's
  owner fixes it by entering the key again, or decides to remove it, which
  hands the workspace back to the deployment's key by an act somebody chose.
- `noEncryptionKey`: the deployment has no usable `CREDENTIAL_ENCRYPTION_KEY`,
  so no stored key can be read and none can be entered. Only whoever runs the
  installation can fix that. The row is still looked up for this case, because
  "which workspaces brought a key" is exactly what a deployment that lost its
  encryption key would otherwise forget.

**A run ends before it starts.** The run is refused with `ai_key_unreadable`
and the `keyUnreadable` diagnosis of ADR-059 (`reason`), rendered in each
reader's language: what happened, that nothing was sent and no other key
stepped in, and who can fix it. Nothing is prepared on anybody's key first,
not the vision companion and not the tool routing question, and a run on a
subscription preset is refused as well: its fallback turns are the
workspace's to pay, and there is no key to pay them with.

**A cover ends the same way.** `document.cover.generated` carries
`key_unreadable` with the same `reason`, worded in the browser. No generator is
built, no model is asked, and so no `IMAGE` row is written (ADR-090 records
what was asked of a model). With image generation switched off the cover still
says `unavailable`, because that is the more fundamental answer.

Neither the error, the log line nor the diagnosis carries any part of either
key; the log names the workspace and the reason.

## Consequences

- **Losing `CREDENTIAL_ENCRYPTION_KEY` now stops the workspaces that brought a
  key**, instead of moving their costs onto the deployment unnoticed. Every
  other workspace keeps working. Restoring the encryption key brings the
  stored keys back; replacing it means every owner enters theirs again.
- **The fix is visible where the failure is.** The person in the chat panel
  and on the page reads who has to act, and `exo_ai_run_get` returns the same
  diagnosis to an agent.
- **No new state.** Nothing marks the row as broken; the next run simply tries
  again, so a restored encryption key heals every workspace at once.
- ADR-023's sentence "a stored row that cannot be decrypted falls back rather
  than failing the run" and its consequence "every workspace falls back to the
  deployment key and keeps working" no longer hold; both carry a note pointing
  here.
