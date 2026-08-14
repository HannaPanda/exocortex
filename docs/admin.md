# The admin area

Deployment-wide administration: the global admin role, runtime settings, the AI
model registry and personal API tokens. Everything here is reachable through
`/api/admin/*` with a session cookie or an admin's API token, and through
`/admin` in the web app.

## The global admin role

`User.role` is a `UserRole`: `USER` (the default) or `ADMIN`. It is **global** and
has nothing to do with `WorkspaceRole` — a workspace `ADMIN` administers one
workspace, a global `ADMIN` administers the deployment.

One policy decides it, `canAdministerDeployment` in
`packages/auth/src/policies.ts`, which returns `admin_required` for anything but
`ADMIN`. It is enforced by `AdminGuard` (`apps/api/src/auth/admin.guard.ts`),
registered as an `APP_GUARD` in `app.module.ts`, so it runs on every request —
but only rejects routes marked `@AdminOnly()`. Both `AdminController` and
`AiModelsController` carry the decorator at class level, so a route added to
either is protected by default rather than by remembering to annotate it.

Promoting someone:

```bash
# Through the admin user table: /admin/nutzer, or
PATCH /api/admin/users/:userId   {"role":"ADMIN"}

# Or directly, when no admin exists yet to promote with:
psql -h 127.0.0.1 -p 5433 -U exocortex -d exocortex \
  -c "UPDATE \"user\" SET role='ADMIN' WHERE email='johanna@hannapanda.de';"
```

`pnpm db:seed` also promotes the production admin email it knows about, so a
freshly seeded deployment always has one.

## Who is here: invitations and account status

`/admin/nutzer` is the whole answer to "who has access", in two tables on one
page: the accounts, and the invitations that have not become accounts yet. They
belong together because they are the same question at two points in time — an
accepted invitation turns into a row in the upper table.

Self-registration is off, so an invitation is the only way in besides the seed
script. `docs/security.md` has the token design, the one-use guarantee and the
rate limits; what matters here is the shape of the routes:

| Route                                                             | Who                       | What                                                     |
| ----------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `GET /api/admin/invitations`                                      | global admin              | every invitation, newest first                           |
| `POST /api/admin/invitations`                                     | global admin              | invite; `workspaceId` optional, `role: "admin"` allowed  |
| `POST /api/admin/invitations/:id/resend`                          | global admin              | new token, old link dies                                 |
| `DELETE /api/admin/invitations/:id`                               | global admin              | withdraw                                                 |
| `GET`/`POST`/`DELETE` `/api/workspaces/:workspaceId/invitations…` | workspace `OWNER`/`ADMIN` | the same, bounded to that workspace, never a global role |
| `PATCH /api/admin/users/:userId/status`                           | global admin              | `{"disabled":true}` switches the account off             |
| `DELETE /api/admin/users/:userId`                                 | global admin              | only if the account authored nothing                     |

Three things about this that are easy to get wrong later:

- **The invitation link comes back exactly once**, in the create/resend response,
  and is never stored — only its SHA-256 is. If the mail fails, `emailSent` is
  `false` and the dialog stays open with the link, because that is the only
  chance to hand it over.
- **Disabling is not the same as deleting**, and the UI only offers deletion for
  an account with no authored content. `Document.createdById` is a required
  reference; the database would refuse the rest, and rewriting authorship to get
  around that would falsify the history.
- **Neither route works on your own account**, and neither can remove the last
  global admin. Same two guards as `updateUserRole`, for the same reason: a
  locked-out sole administrator cannot repair themselves.

## Settings

Runtime configuration lives in the `setting` table and overrides the
environment; see ADR-013 for why, and for the resolution order
(defaults < env < database). Read with `GET /api/admin/settings`, write a
**partial** patch with `PATCH /api/admin/settings`. An empty table is a valid
state: every key falls back to its default.

The keys below are generated from `settingsSchema` in
`packages/contracts/src/settings.ts`, which is the authority. Add a key there
first; the admin form and this table follow.

| Key                                           | Type                      | Default                             | Affects                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai.enabled`                                  | boolean                   | `true`                              | Master switch for the AI pipeline.                                                                                                                                                                                                                                                                                                                                       |
| `ai.defaultModelSlug`                         | string \| null            | `null` → `OPENROUTER_DEFAULT_MODEL` | Model used when a conversation names none. Must be a slug in the `ai_model` registry.                                                                                                                                                                                                                                                                                    |
| `ai.systemPrompt`                             | string (≤ 8000)           | `''`                                | Prepended to every run's system prompt, ahead of any AI rule pages.                                                                                                                                                                                                                                                                                                      |
| `ai.maxOutputTokens`                          | int 256–200000            | `4096`                              | Output cap per model call.                                                                                                                                                                                                                                                                                                                                               |
| `ai.timeoutMs`                                | int 5000–600000           | `180000`                            | Timeout for a single model answer, not the whole run — see `ai.maxRunMs`.                                                                                                                                                                                                                                                                                                |
| `ai.maxRunMs`                                 | int 60000–3600000         | `900000`                            | Timeout for the whole run, across every turn and tool round-trip. Ends the run as `timed_out`, never `failed` (ADR-017). Can never be shorter than `ai.timeoutMs`.                                                                                                                                                                                                       |
| `ai.budgetMicroUsdPerRun`                     | int 1000–50000000         | `500000`                            | Cost ceiling per run (µUSD), checked per tool iteration.                                                                                                                                                                                                                                                                                                                 |
| `ai.toolsEnabled`                             | boolean                   | `true`                              | Whether the built-in AI gets tools at all. Also requires `SERVICE_TOKEN_SECRET`.                                                                                                                                                                                                                                                                                         |
| `ai.mutatingToolsEnabled`                     | boolean                   | `true`                              | Whether the AI may call tools that change data.                                                                                                                                                                                                                                                                                                                          |
| `ai.maxToolIterations`                        | int 0–1000                | `8`                                 | Tool round-trips per run before the loop stops. Deliberately roomy: cost and duration are already bounded by `ai.budgetMicroUsdPerRun` and `ai.maxRunMs`, which know money and time (issue #28).                                                                                                                                                                         |
| `ai.visionEnabled`                            | boolean                   | `true`                              | Master switch for vision preprocessing (ADR-012).                                                                                                                                                                                                                                                                                                                        |
| `ai.visionMaxImagesPerRun`                    | int 0–64                  | `4`                                 | Images described per run. Each one is a paid vision call, so the run budget is the real limit.                                                                                                                                                                                                                                                                           |
| `ai.pageContextEnabled`                       | boolean                   | `false`                             | Puts the open page's text into the system prompt (ADR-015). Off by default: it is the one switch here that sends document content the user did not ask for in that turn. Off, the model gets the page's title and path and fetches the text with `exo_page_read` when a question needs it — enough for a tool-capable model. Turn it on for models without tool support. |
| `ai.pageContextMaxChars`                      | int 500–100000            | `12000`                             | Cap on that text. What is cut is stated in the prompt, so the model knows it has an excerpt.                                                                                                                                                                                                                                                                             |
| `ai.compactionThresholdPercent`               | int 30–95                 | `70`                                | Share of the context window at which compaction starts. Capped below 100 because at 100 the window has already overflowed.                                                                                                                                                                                                                                               |
| `ai.compactionKeepRecentMessages`             | int 2–200                 | `8`                                 | Messages left untouched by a compaction. A tail large enough to fill the window on its own turns compaction into a logged no-op.                                                                                                                                                                                                                                         |
| `ai.compactionModelSlug`                      | string \| null            | `null`                              | Model that writes the summary. Null reuses the conversation's model.                                                                                                                                                                                                                                                                                                     |
| `ai.pdfExtractionEnabled`                     | boolean                   | `true`                              | Whether the `attachment-text` queue extracts PDF text.                                                                                                                                                                                                                                                                                                                   |
| `ai.pdfExtractor`                             | `docling` \| `openrouter` | `docling`                           | Engine tried first. `docling` is local, free per document and reads scans; `openrouter` needs no container but is billed per page.                                                                                                                                                                                                                                       |
| `ai.pdfExtractorFallbackEnabled`              | boolean                   | `true`                              | Try the other engine when the one above finds nothing or fails. No effect when only one of the two is configured.                                                                                                                                                                                                                                                        |
| `ai.pdfExtractionModelSlug`                   | string \| null            | `null`                              | Model with a file parser. Null reuses `ai.defaultModelSlug`.                                                                                                                                                                                                                                                                                                             |
| `ai.pdfMaxBytes`                              | int 1024–52428800         | `10485760`                          | Largest PDF that is extracted.                                                                                                                                                                                                                                                                                                                                           |
| `ai.imageGenerationEnabled`                   | bool                      | `false`                             | Lets a page cover be drawn from a prompt. Off by default: every picture is a paid call.                                                                                                                                                                                                                                                                                  |
| `ai.imageModelSlug`                           | string \| null            | `null`                              | Image-capable model, e.g. `google/gemini-2.5-flash-image`. Null leaves the feature unavailable however the flag above is set.                                                                                                                                                                                                                                            |
| `mcp.enabled`                                 | boolean                   | `true`                              | Master switch for the MCP tool surface.                                                                                                                                                                                                                                                                                                                                  |
| `mcp.maxSearchResults`                        | int 1–100                 | `20`                                | Result cap for `exo_search`.                                                                                                                                                                                                                                                                                                                                             |
| `mcp.writeConfirmationRequired`               | boolean                   | `false`                             | Widens the two-step, destination-keyed confirmation to _every_ mutating MCP tool. Off, it still covers the four calls no snapshot undoes; see `docs/mcp.md`.                                                                                                                                                                                                             |
| `calendar.remindersEnabled`                   | boolean                   | `false`                             | Master switch for appointment reminders. Also requires `CALENDAR_REMINDER_COMMAND` and `CALENDAR_REMINDER_TARGET`; a deployment that mirrors a calendar has not thereby asked to be messaged about it.                                                                                                                                                                   |
| `calendar.reminderLeadMinutes`                | int 0–1440                | `30`                                | How long before a timed appointment the reminder goes out. `0` means at the start.                                                                                                                                                                                                                                                                                       |
| `calendar.reminderAllDayHour`                 | int 0–23                  | `9`                                 | Local hour at which an all-day appointment is announced. It has no start time to count back from.                                                                                                                                                                                                                                                                        |
| `calendar.timeZone`                           | string                    | `Europe/Berlin`                     | IANA zone the two settings above are read in. Validated against `Intl`, so a typo is refused at the boundary instead of thrown inside the worker every minute.                                                                                                                                                                                                           |
| `activity.editSessionSnapshotsEnabled`        | boolean                   | `false`                             | Lets `snapshot-active-documents` take periodic `SCHEDULED` snapshots of a page while it is being edited, which is what lets the Aktivität tab show a real session range instead of a single point. Off by default: a new recurring write the deployment has not asked for yet.                                                                                           |
| `activity.editSessionSnapshotIntervalMinutes` | int 5–1440                | `15`                                | Minimum time between two `SCHEDULED` snapshots of the same page. Only takes effect with the switch above on.                                                                                                                                                                                                                                                             |
| `activity.snapshotRetentionFullDays`          | int 1–365                 | `7`                                 | Every snapshot younger than this survives `prune-snapshots` outright, whatever its `reason`.                                                                                                                                                                                                                                                                             |
| `activity.snapshotRetentionDailyDays`         | int 1–3650                | `30`                                | Between the full-retention window and this age, at most one snapshot per calendar day survives; older than this, at most one per calendar week. `MANUAL` snapshots are exempt from both tiers.                                                                                                                                                                           |
| `activity.snapshotRetentionDryRun`            | boolean                   | `true`                              | Computes and logs what tiered retention would delete without deleting anything. Defaults on so the first run after this feature ships cannot silently remove existing snapshots; switch off deliberately once the log line looks right.                                                                                                                                  |

The bounds in the table are not repeated in the admin form. `SETTING_NUMBER_RANGES`
derives them from `settingsSchema`, and the form reads them for the input's
`min`/`max` and for the "Zulässig: … bis …" line under the field, so a range
cannot be stated in two places and drift. A refused save names the offending
setting at its own row and scrolls it into view; the summary alert sits next to
the save button, not at the top of the page (issue #27).

A row already in the table that does not validate is a second, quieter version
of the same problem. `resolveSettings` drops it and boots on the default, which
must stay that way — one hand-edited row cannot be allowed to stop a process
from starting — but the drop used to be reported only into the log, so the form
showed a default while the table held something else. `GET /api/admin/settings`
and `PATCH /api/admin/settings` therefore both answer with `invalidKeys`
alongside `settings`, and the form states at the top which settings are being
ignored. Saving the field replaces the bad row.

A bound that exists only out of caution is a bug, not a safety measure: the
places where a run can really cost something are `ai.budgetMicroUsdPerRun` and
`ai.maxRunMs`. Every remaining cap above carries the reason it exists in a
comment next to it in `settings.ts` (issue #28).

Secrets are deliberately **not** settings. `OPENROUTER_API_KEY`,
`SERVICE_TOKEN_SECRET` and `DATABASE_URL` stay in `.env`, out of reach of
`GET /api/admin/settings`.

### Memory settings (issue #34)

The agents' memory is off until a workspace is named, and that is deliberately
the whole switch.

| Setting                                             | Meaning                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.enabled`                                    | Master switch for writing. Off: nothing is captured or remembered; recall still answers.                                                                                                                                                                                                       |
| `memory.workspaceId`                                | Which workspace the agents write into. Empty means there is no destination, and `POST /api/memory/capture` answers `{accepted: false, reason: 'memory_workspace_not_configured'}` instead of guessing one.                                                                                     |
| `memory.captureModelSlug`                           | Model that distils a session. Empty falls back to `ai.compactionModelSlug`, then `ai.defaultModelSlug`.                                                                                                                                                                                        |
| `memory.captureMinChars`                            | Shortest session worth remembering. The cheap half of the "is this memorable" question; the other half is the model's, which may answer that there is nothing to keep.                                                                                                                         |
| `memory.recallMaxChars` / `memory.recallMaxResults` | Hard ceilings on one recall answer, whatever a caller asks for. A memory that eats the context window it is meant to improve is worse than none.                                                                                                                                               |
| `memory.retentionDays`                              | How long a session note survives. `0` (the default) never deletes anything. With a period set, `prune-memories` moves an untouched note into the trash after it, and destroys it after a second one — so nothing was ever unrecoverable. Project pages and other workspaces are never touched. |

**Do not point `memory.workspaceId` at a curated workspace.** Automatically
written session notes belong where they may be tidied and expired; a workspace
somebody reads as a document is not that. The permission model does the rest:
give the agent account a writing role in the memory workspace and a reading role
in the curated ones, and `requireRole` makes the boundary physical, whatever
scope its token carries ([ADR-019](adr/ADR-019-agent-memory-in-its-own-workspace.md)).

### Search settings (issue #34, AP4)

Semantic search is off until somebody turns it on, because switching it on
turns every indexed page into a paid embedding call.

| Setting                        | Meaning                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search.semanticEnabled`       | Adds vector similarity beside full-text, fused by rank. Off: the search box and `recall` behave exactly as before. On: newly indexed pages are embedded as they are written, and `backfill-embeddings` works through the ones that already exist.                                                         |
| `search.embeddingModelSlug`    | An OpenRouter slug that returns 1536 dimensions. `openai/text-embedding-3-small` (the default) does natively; `openai/text-embedding-3-large` shortens to it on request. Anything else is refused rather than stored wrong. Changing it makes the old vectors invisible and the backfill writes new ones. |
| `search.semanticWeightPercent` | How much the semantic list counts against the full-text list. `0` is pure full-text, `100` pure meaning, `50` weighs them equally.                                                                                                                                                                        |

Cost, so it is not a surprise: `text-embedding-3-small` is about two cents per
million tokens, one vector per page of up to 24k characters, and a page whose
text has not changed is never embedded twice. Searching costs one embedding of
the query per search ([ADR-020](adr/ADR-020-semantic-search-beside-full-text.md)).

## The AI model registry

`AiModel` is the admin-editable catalogue of selectable models. The picker, the
context-window arithmetic behind compaction, and the per-run cost estimate all
read from it, so a model that is not in the registry cannot be chosen.

```bash
# Seed the curated list (idempotent: upserts by slug, wires vision companions).
pnpm --filter @exocortex/database db:seed:ai-models

# Refresh prices, context windows and capabilities from the live provider.
POST /api/admin/ai-models/sync        # optionally {"slugs":["z-ai/glm-5.2"]}
```

`sync` reads the live OpenRouter model list. A slug that has disappeared
upstream is set to `enabled = false` rather than deleted, so conversations that
already reference it still resolve (ADR-012 / risk R12). CRUD for individual
rows is `POST`, `PATCH /api/admin/ai-models/:modelId` and `DELETE`; a disabled
model leaves the picker but stays resolvable.

**Vision companions.** A model with `supportsVision = false` cannot answer
questions about a page containing images. `visionCompanionId` names a cheap
vision-capable model that describes the images in text first, which the main
model then reasons about (ADR-012). Resolution order, in
`apps/worker/src/processors/ai-run.ts`:

1. `ai.visionEnabled = false` → no preprocessing at all.
2. The main model has `supportsVision = true` → skipped, it sees images itself.
   This is the payoff of the registry: a vision model pays for no companion call.
3. The conversation's `visionCompanionSlug` is the literal `'off'` → disabled for
   this conversation.
4. Otherwise: the conversation's override, else the model's admin-configured
   companion.

The seeded companion for the text-only models is `qwen/qwen3.7-flash`.

## Connections: API tokens and connected applications

Long-lived bearer credentials for external clients (the MCP server, scripts,
cron jobs). A token carries **at most its user's permissions** — never more —
because `TokenOrSessionGuard` resolves it into the same `VerifiedSession` a
cookie produces (ADR/decision D1). It can carry less: `ApiToken.scopes`
(`read` / `write` / `admin`, cumulative) is enforced by `TokenScopeGuard`, and
an empty array grants **nothing**.

```bash
pnpm --filter @exocortex/api token:create -- \
  --email johanna@hannapanda.de --name "Hermes MCP" --days 365
```

The raw value is printed on the last line and **never again**: only its SHA-256
hash and a 12-character `prefix` are stored. Users manage their own tokens at
`/einstellungen/verbindungen` (the old `/einstellungen/tokens` redirects there)
and through `GET`/`POST /api/me/api-tokens` and
`DELETE /api/me/api-tokens/:tokenId`.

That page has three sections, because "which agent may reach my brain" is one
question, not three:

- **Verbundene Anwendungen** — the OAuth clients this account let in through
  `/verbinden`, from `GET /api/me/connections`, each with a button behind
  `DELETE /api/me/connections/:clientId`. That call deletes the account's access
  tokens for the client (each row holds the refresh token too, so renewal stops
  as well), deletes its consent, and switches the `oauth_application` row off
  when nobody else still consents to it. Before this existed, the only way to
  end a connection was an UPDATE against the database.
- **Token** — the personal API tokens described above.
- **Einrichten** — one finished command per client, built from
  `apps/web/src/lib/connection-snippets.ts` and the browser's own origin. The
  reveal dialog renders the same command with the new secret already inside it:
  a token is shown once, so anything a person has to paste in by hand is a step
  where setup fails.

Both connection routes need the `admin` scope (`requiredScopeForRequest`), for
the same reason token management does: a credential that can manage credentials
is not a narrow credential. An agent holding a `write` token can neither see nor
cut the connections watching over it.

Two prefixes exist, and they are different mechanisms:

- **`exo_`** — a user's `ApiToken` row, revocable, optionally expiring.
- **`exos_`** — a short-lived HMAC service token the worker mints for its own
  tool calls, signed with `SERVICE_TOKEN_SECRET`, TTL `SERVICE_TOKEN_TTL_SECONDS`
  (default 300). No database row per run. It resolves to the run's own user, so a
  tool call the model makes is authorized exactly as that human would be. With
  `SERVICE_TOKEN_SECRET` unset the AI still runs, just without tools, and logs a
  warning — a missing `.env` line can never break boot.

Usage: `Authorization: Bearer exo_…` against `http://127.0.0.1:3211`, which
bypasses nginx and its HTTP basic auth on purpose. Through the public host, the
basic-auth credentials are needed as well.

## Adding a setting

1. Add the field with a `.default()` to `settingsSchema`
   (`packages/contracts/src/settings.ts`). If an env var should seed it, add it to
   `SETTING_ENV_MAP` too.
2. Read it where it applies: `settingsService.getKey('your.key')` in `apps/api`,
   or the resolved `settings` object in the worker.
3. Add a control to `apps/web/src/components/admin/settings-form.tsx`. It diffs
   against the loaded values and sends only what changed — keep that property.
4. Add the row to the table above.

No migration is needed: the `setting` table is key/value.
