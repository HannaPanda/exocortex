# ADR-023: Settings have a scope, and credentials are not settings

- Status: accepted
- Date: 2026-09-12

## Context

ADR-013 moved runtime configuration into the `setting` table and argued the
resolution order: defaults < environment < database. It said nothing about
_who_ a value belongs to, because at the time there was only one answer. The
table's primary key is `key` alone, so every value is deployment-wide, and that
was never a decision anybody made: it is what the schema happened to imply.

It held for as long as the deployment was one person's. It stopped holding at
three separate points:

- One system prompt, one default model and one budget per run for every
  workspace. A team that wants the AI to answer differently in their area has
  nowhere to say so.
- One `memory.workspaceId`. Every account on the deployment shares one agent
  memory, and only a global admin can point it anywhere.
- Nowhere to put a workspace's own provider key. ADR-013 is explicit that a
  setting is a preference and never a credential, which is correct and which
  also means the settings table is not the answer for BYOK.

The three look like one problem and are not. The first is answered by a
workspace, the second cannot be, and the third must not be answered by this
table at all.

## Decision

### Every key has a scope

`SETTING_SCOPES` in `packages/contracts/src/settings.ts` maps each key to
`deployment` or `workspace`, and `satisfies Record<SettingKey, SettingScope>`
makes a new key in `settingsSchema` a type error until somebody classifies it.
The line is not "how risky is it" but "who can answer it": a prompt, a model
and a budget belong to the people working in a workspace; whether semantic
search is on, which PDF engine exists on this host and how long the agent
journal is kept do not.

Three groups stay deployment-wide for reasons written down elsewhere:
`search.*` because ADR-020 wants one vector space for index and query;
`entities.*` because an entity is a thing in the world and the same host under
two names in two workspaces is what that layer exists to prevent; `mcp.*` and
`agents.*` because they decide what agents may do and how long the record of
what they did survives.

### A fourth resolution layer, and no third state

`workspace_setting` holds one row per `(workspaceId, key)`. **An absent row
means inherit.** There is no nullable value column and no tombstone, because
several keys are themselves nullable (`ai.defaultModelSlug: null` means "fall
back to the env default") and a sentinel would have to be distinguished from
them for ever. Unsetting an override is a `DELETE`, expressed in the API as a
separate `reset: SettingKey[]` list rather than as a value.

`resolveSettings()` takes optional `workspaceRows` and applies them key by key
onto the already-resolved deployment object, rather than merging them into the
candidate and re-parsing. Two reasons: the deployment value has to survive as
the ceiling to clamp against, and every field of `settingsSchema` validates
independently, so a per-key parse is exactly as strict while letting one bad
row be dropped the way a bad deployment row already is.

### Ceilings clamp while resolving, not while writing

`SETTING_CEILINGS` names the numeric keys that buy time, money or memory on
this host. A workspace may spend less than the deployment allows, never more.
The clamp happens in `resolveSettings()`, so lowering the deployment value
pulls every workspace down on the next read without anybody rewriting rows.
The write path refuses an over-value as well, but only so the form can say
what happened; the resolve-time clamp is the half that actually holds.

### The memory area is a property of the workspace

`memory.workspaceId` is gone. `Workspace.isMemory` replaces it, and the
resolution for an account is "the memory workspace among their memberships,
with at least MEMBER, oldest membership first". This is not a per-workspace
setting because it could not have been one: `recall`, `remember` and `capture`
are handed a user and a project and never a workspace, so there is no context
an override could have been resolved against.

The three nightly sweeps (`pruneMemories`, `consolidateMemories`,
`decayMemoryFacts`) iterate over every memory area and read its own regulators.

### Credentials get their own table

BYOK does not go in `setting` or in `workspace_setting`. ADR-013's rule stands:
a setting is a preference, never a credential. `workspace_credential` holds one
row per `(workspaceId, purpose)`, and everything in it is AES-256-GCM output
from `packages/auth/src/credential-cipher.ts`. The purpose is bound in as
additional authenticated data, so a row moved between purposes fails to decrypt
rather than being handed to a service it was never meant for, and `keyVersion`
sits on the row so a later rotation can re-encrypt row by row instead of
invalidating the table.

The value never travels back out. The API answers with `configured`, `hint`
(the last four characters) and two timestamps; the plaintext exists only in the
worker, for the length of one provider call. `CREDENTIAL_ENCRYPTION_KEY` is
optional like `SERVICE_TOKEN_SECRET`: unset means no workspace can bring a key,
and nothing refuses to boot.

Resolution is `aiKeyFor(workspaceId)` in the worker: the workspace's key if it
has a usable one, the deployment's otherwise. A stored row that cannot be
decrypted falls back rather than failing the run, and the run is then recorded
as deployment-paid, because a usage report that guesses is worse than one that
undercounts BYOK.

The boundary is **what a run spends**. An `AiRun` and the vision companion
calls inside it are paid for by the workspace's key; the deployment-wide
machinery around them (cover images, memory capture and consolidation, search
embeddings) stays on the deployment key. Embeddings must: ADR-020 needs index
and query in one vector space, and two accounts embedding under two keys
against one index is the failure mode that looks exactly like a healthy
deployment returning nothing.

Storing a key is OWNER-only (`canManageWorkspaceCredentials`), a rung above the
ADMIN bar for settings. A prompt or a model is how the people here work; a
provider key is a paying relationship with a third party, and it belongs to
whoever answers for the bill. `AiRun.usedOwnKey` records which of the two paid,
so the usage report can say how much of one total was somebody else's money.

## Consequences

- **A workspace with no rows behaves exactly as before.** The fourth layer is
  optional, and every deployment-wide caller that passes nothing gets the old
  answer. `resolveSettings({ rows })` is unchanged in meaning.
- **Every caller now has to know whether it has a workspace.** The ones that do
  pass it: AI runs, cover generation, PDF extraction, capture, consolidation,
  calendar reminders. The ones that genuinely span the installation (snapshot
  pruning, index maintenance, the outbox) read deployment-wide, and that is a
  decision per call site rather than a default.
- **The calendar reminder sweep lost its global gate.**
  `calendar.remindersEnabled` is workspace-scoped and defaults to off, so a
  deployment-wide check would have silenced exactly the workspace that switched
  it on. The decision moved into a per-workspace resolver that returns `null`
  for a workspace with reminders off.
- **The partial-patch trap from ADR-013 now has a second door.** `reset` is a
  new way to write the wrong thing: a key that is both set and reset in one
  request is refused by the schema, and the tests pin it.
- **Two caches instead of one.** `SettingsService` keeps a map keyed by
  workspace beside the deployment object, both on the same 15 second TTL. A
  deployment-wide write clears all of them, because those values are the floor
  and the ceiling of every workspace answer.
- **A workspace key buys the runs and nothing else.** Covers, memory jobs and
  embeddings stay on the deployment key, so a workspace with its own key still
  costs the deployment something. This is a stated boundary and not an
  oversight: the alternatives are a second key per purpose or a vector index
  that quietly splits in two.
- **Losing `CREDENTIAL_ENCRYPTION_KEY` loses the stored keys, not the service.**
  Every workspace falls back to the deployment key and keeps working; the rows
  become unreadable and have to be entered again. That is the price of not
  keeping a second copy of the key anywhere.
- **This is not multi-tenancy.** The admin area stays deployment-wide: users,
  the model registry, AI usage, agent sessions. A global admin still sees
  everything. What this ADR buys is configuration per workspace, which is the
  precondition for tenancy and not the thing itself.
