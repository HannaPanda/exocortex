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

`GET /api/session` carries the same role, lowercased, on `user.role`. That is
what the browser reads to stop offering what it knows it may not have: the
account menu leaves "Verwaltung" out for an ordinary account, `AdminGuard` in
`apps/web` answers "Kein Zugriff" without a request that was only ever going to
fail, and the entity-database setup says who can do it instead of handing over a
button that refuses. None of it is authorization: a forged field buys a menu
entry and nothing behind it, because every administrative route is still checked
by the API's own guard.

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

### Scopes: deployment-wide or per workspace (issue #52)

Every key carries a scope in `SETTING_SCOPES`, and `satisfies` makes a new key
a type error until somebody classifies it. `deployment` is what this page
edits. `workspace` means a workspace OWNER or ADMIN may override it for their
own area, under `/arbeitsbereich/:id/einstellungen`, and resolution becomes
four layers: defaults < environment < `setting` < `workspace_setting`.

The line is "who can answer this", not "how risky is it":

| Scope        | What lives there                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`  | Prompt, model choice, budgets and timeouts, vision, compaction, PDF and cover switches, the memory regulators, the calendar reminder schedule, the two page-size limits agents write under.                                        |
| `deployment` | `ai.enabled`, data retention, which PDF engine exists, `search.*` (ADR-020 wants one vector space), `entities.*` (one entity database per deployment), `mcp.*` and `agents.journalRetentionDays` (they decide what agents may do). |

Two things about overrides that are easy to get wrong later:

- **An absent row means inherit.** There is no third state and no tombstone.
  Unsetting an override is a `DELETE`, sent as `reset: ["ai.systemPrompt"]` in
  the patch, because `null` is already a real value for several keys.
- **`SETTING_CEILINGS` clamps while resolving, not while writing.** A workspace
  may go below the deployment value for budget, timeouts, output tokens, PDF
  size and recall size, never above. Lowering the deployment value therefore
  pulls every workspace down on the next read, without rewriting a single row.

`GET /api/workspaces/:id/settings` answers with the effective values, the
deployment values to fall back to, the keys this workspace has set and the keys
it may set. Both routes are deliberately absent from the MCP catalogue: the
overridable keys include `ai.toolsEnabled`, `ai.mutatingToolsEnabled`,
`ai.untrustedContentPolicy` and `ai.budgetMicroUsdPerRun`, so a tool for them
would let an agent widen its own permissions and raise its own spending limit.
`ai.untrustedContentPolicy` is the sharpest case of that (ADR-030): a boundary a
run could raise for itself is one an injected paragraph could raise for itself.

### A workspace's own provider key (issue #52, AP7)

A key is not a setting, and ADR-013 says so: a setting is a preference, never a
credential. `workspace_credential` is a separate table of AES-256-GCM
ciphertext, and nothing reads it back out to a browser. The routes are
`GET`, `PUT` and `DELETE /api/workspaces/:id/credentials[/:purpose]`, OWNER
only, and they answer with `configured`, `hint` (the last four characters),
`updatedAt` and `lastUsedAt`.

Setting it up takes one line in `.env`:

```bash
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Without it the feature is simply off: the form says so, every workspace runs on
`OPENROUTER_API_KEY`, and nothing refuses to boot. Losing the value later makes
the stored rows unreadable; every workspace falls back to the deployment key
and the owners enter theirs again.

What a workspace key pays for is **runs**: the model call and the vision
companion calls inside it. Cover images, memory capture and consolidation, and
above all search embeddings stay on the deployment key. Embeddings have to
(ADR-020: one vector space for index and query), the rest is a boundary worth
knowing about when a bill arrives. `AiRun.usedOwnKey` records which key paid,
and the usage report shows the share under "Kosten".

| Key                                           | Type                           | Default                             | Affects                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.enabled`                                  | boolean                        | `true`                              | Master switch for the AI pipeline.                                                                                                                                                                                                                                                                                                                                                             |
| `ai.defaultModelSlug`                         | string \| null                 | `null` → `OPENROUTER_DEFAULT_MODEL` | Model used when a conversation names none. Must be a slug in the `ai_model` registry.                                                                                                                                                                                                                                                                                                          |
| `ai.systemPrompt`                             | string (≤ 8000)                | `''`                                | Prepended to every run's system prompt, ahead of any AI rule pages.                                                                                                                                                                                                                                                                                                                            |
| `ai.maxOutputTokens`                          | int 256–200000                 | `4096`                              | Output cap per model call.                                                                                                                                                                                                                                                                                                                                                                     |
| `ai.timeoutMs`                                | int 5000–600000                | `180000`                            | Timeout for a single model answer, not the whole run — see `ai.maxRunMs`.                                                                                                                                                                                                                                                                                                                      |
| `ai.maxRunMs`                                 | int 60000–3600000              | `900000`                            | Timeout for the whole run, across every turn and tool round-trip. Ends the run as `timed_out`, never `failed` (ADR-017). Can never be shorter than `ai.timeoutMs`.                                                                                                                                                                                                                             |
| `ai.budgetMicroUsdPerRun`                     | int 1000–50000000              | `500000`                            | Cost ceiling per run (µUSD), checked per tool iteration.                                                                                                                                                                                                                                                                                                                                       |
| `ai.toolsEnabled`                             | boolean                        | `true`                              | Whether the built-in AI gets tools at all. Also requires `SERVICE_TOKEN_SECRET`.                                                                                                                                                                                                                                                                                                               |
| `ai.mutatingToolsEnabled`                     | boolean                        | `true`                              | Whether the AI may call tools that change data.                                                                                                                                                                                                                                                                                                                                                |
| `ai.untrustedContentPolicy`                   | `guarded` \| `deny` \| `allow` | `guarded`                           | What the AI may still change once a run has read text from outside this deployment: an extracted document, a described image, later the web (ADR-030). `guarded` refuses mutating tools from that point on, `deny` never offers them, `allow` is the declared exception for a workflow that reads foreign documents and writes about them. A workspace may only tighten this, never loosen it. |
| `ai.maxToolIterations`                        | int 0–1000                     | `8`                                 | Tool round-trips per run before the loop stops. Deliberately roomy: cost and duration are already bounded by `ai.budgetMicroUsdPerRun` and `ai.maxRunMs`, which know money and time (issue #28).                                                                                                                                                                                               |
| `ai.visionEnabled`                            | boolean                        | `true`                              | Master switch for vision preprocessing (ADR-012).                                                                                                                                                                                                                                                                                                                                              |
| `ai.visionMaxImagesPerRun`                    | int 0–64                       | `4`                                 | Images described per run. Each one is a paid vision call, so the run budget is the real limit.                                                                                                                                                                                                                                                                                                 |
| `ai.pageContextEnabled`                       | boolean                        | `false`                             | Puts the open page's text into the system prompt (ADR-015). Off by default: it is the one switch here that sends document content the user did not ask for in that turn. Off, the model gets the page's title and path and fetches the text with `exo_page_read` when a question needs it — enough for a tool-capable model. Turn it on for models without tool support.                       |
| `ai.pageContextMaxChars`                      | int 500–100000                 | `12000`                             | Cap on that text. What is cut is stated in the prompt, so the model knows it has an excerpt.                                                                                                                                                                                                                                                                                                   |
| `ai.maxPinnedSources`                         | int 0–32                       | `8`                                 | How many sources a conversation may pin beside the open page (issue #75, ADR-043). Zero switches pinning off for the workspace. A count as well as a budget, because a chip row nobody can read at a glance stops being the promise it is meant to be.                                                                                                                                         |
| `ai.pinnedContextMaxChars`                    | int 0–200000                   | `24000`                             | Cap on all pinned sources that carry their text, together. Split into equal shares while the prompt is built, so one long page cannot eat it; every cut is stated in the prompt text.                                                                                                                                                                                                          |
| `ai.compactionThresholdPercent`               | int 30–95                      | `70`                                | Share of the context window at which compaction starts. Capped below 100 because at 100 the window has already overflowed.                                                                                                                                                                                                                                                                     |
| `ai.compactionKeepRecentMessages`             | int 2–200                      | `8`                                 | Messages left untouched by a compaction. A tail large enough to fill the window on its own turns compaction into a logged no-op.                                                                                                                                                                                                                                                               |
| `ai.compactionModelSlug`                      | string \| null                 | `null`                              | Model that writes the summary. Null reuses the conversation's model.                                                                                                                                                                                                                                                                                                                           |
| `ai.providerRouting`                          | object                         | `{}`                                | OpenRouter's `provider` object for every request (issue #135, ADR-063): `sort` (`throughput`, `latency`, `price`), `ignore`, `only`, and any other key it accepts, passed through. A model overrides single keys in the registry. Deployment-wide. Empty leaves the choice to OpenRouter.                                                                                                      |
| `ai.pdfExtractionEnabled`                     | boolean                        | `true`                              | Whether the `attachment-text` queue extracts PDF text.                                                                                                                                                                                                                                                                                                                                         |
| `ai.pdfExtractor`                             | `docling` \| `openrouter`      | `docling`                           | Engine tried first. `docling` is local, free per document and reads scans; `openrouter` needs no container but is billed per page.                                                                                                                                                                                                                                                             |
| `ai.pdfExtractorFallbackEnabled`              | boolean                        | `true`                              | Try the other engine when the one above finds nothing or fails. No effect when only one of the two is configured.                                                                                                                                                                                                                                                                              |
| `ai.pdfExtractionModelSlug`                   | string \| null                 | `null`                              | Model with a file parser. Null reuses `ai.defaultModelSlug`.                                                                                                                                                                                                                                                                                                                                   |
| `ai.pdfMaxBytes`                              | int 1024–52428800              | `10485760`                          | Largest PDF that is extracted.                                                                                                                                                                                                                                                                                                                                                                 |
| `ai.officeExtractionEnabled`                  | boolean                        | `true`                              | Whether the `attachment-text` queue reads Word, Excel, PowerPoint, OpenDocument, RTF, EPUB and CSV attachments. On by default, unlike the PDF engines: this one is a local library call with no container, no network and no tokens (ADR-050).                                                                                                                                                 |
| `ai.officeMaxBytes`                           | int 1024–104857600             | `26214400`                          | Largest office document that is extracted. Higher than the PDF limit because a compressed XML package of a given size is far more text than a PDF of that size.                                                                                                                                                                                                                                |
| `ai.imageGenerationEnabled`                   | bool                           | `false`                             | Lets a page cover be drawn from a prompt. Off by default: every picture is a paid call.                                                                                                                                                                                                                                                                                                        |
| `ai.imageModelSlug`                           | string \| null                 | `null`                              | Image-capable model, e.g. `google/gemini-2.5-flash-image`. Null leaves the feature unavailable however the flag above is set.                                                                                                                                                                                                                                                                  |
| `mcp.enabled`                                 | boolean                        | `true`                              | Master switch for the MCP tool surface.                                                                                                                                                                                                                                                                                                                                                        |
| `mcp.maxSearchResults`                        | int 1–100                      | `20`                                | Result cap for `exo_search`.                                                                                                                                                                                                                                                                                                                                                                   |
| `mcp.writeConfirmationRequired`               | boolean                        | `false`                             | Widens the two-step, destination-keyed confirmation to _every_ mutating MCP tool. Off, it still covers the four calls no snapshot undoes; see `docs/mcp.md`.                                                                                                                                                                                                                                   |
| `calendar.remindersEnabled`                   | boolean                        | `false`                             | Master switch for appointment reminders. Also requires `CALENDAR_REMINDER_COMMAND` and `CALENDAR_REMINDER_TARGET`; a deployment that mirrors a calendar has not thereby asked to be messaged about it.                                                                                                                                                                                         |
| `calendar.reminderLeadMinutes`                | int 0–1440                     | `30`                                | How long before a timed appointment the reminder goes out. `0` means at the start.                                                                                                                                                                                                                                                                                                             |
| `calendar.reminderAllDayHour`                 | int 0–23                       | `9`                                 | Local hour at which an all-day appointment is announced. It has no start time to count back from.                                                                                                                                                                                                                                                                                              |
| `calendar.timeZone`                           | string                         | `Europe/Berlin`                     | IANA zone the two settings above are read in. Validated against `Intl`, so a typo is refused at the boundary instead of thrown inside the worker every minute.                                                                                                                                                                                                                                 |
| `notifications.digestHour`                    | int 0–23                       | `7`                                 | Local hour at which the daily comment digest goes out, for everybody who asked for one. Morning, because the mail is meant to be read once rather than answered at once (issue #106, ADR-053).                                                                                                                                                                                                 |
| `notifications.digestTimeZone`                | string                         | `Europe/Berlin`                     | IANA zone the hour above is read in. Stated rather than taken from the server, which runs in UTC: a guessed zone would post everybody their morning mail at two in the morning with nothing reporting it as a fault.                                                                                                                                                                           |
| `notifications.commentMailDebounceMinutes`    | int 0–60                       | `2`                                 | How long `IMMEDIATE` comment mail waits so a burst of replies becomes one message. Zero means no waiting, which is the literal reading of the word.                                                                                                                                                                                                                                            |
| `activity.editSessionSnapshotsEnabled`        | boolean                        | `false`                             | Lets `snapshot-active-documents` take periodic `SCHEDULED` snapshots of a page while it is being edited, which is what lets the Aktivität tab show a real session range instead of a single point. Off by default: a new recurring write the deployment has not asked for yet.                                                                                                                 |
| `activity.editSessionSnapshotIntervalMinutes` | int 5–1440                     | `15`                                | Minimum time between two `SCHEDULED` snapshots of the same page. Only takes effect with the switch above on.                                                                                                                                                                                                                                                                                   |
| `activity.snapshotRetentionFullDays`          | int 1–365                      | `7`                                 | Every snapshot younger than this survives `prune-snapshots` outright, whatever its `reason`.                                                                                                                                                                                                                                                                                                   |
| `activity.snapshotRetentionDailyDays`         | int 1–3650                     | `30`                                | Between the full-retention window and this age, at most one snapshot per calendar day survives; older than this, at most one per calendar week. `MANUAL` snapshots are exempt from both tiers.                                                                                                                                                                                                 |
| `activity.snapshotRetentionDryRun`            | boolean                        | `true`                              | Computes and logs what tiered retention would delete without deleting anything. Defaults on so the first run after this feature ships cannot silently remove existing snapshots; switch off deliberately once the log line looks right.                                                                                                                                                        |

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

The agents' memory is off until a workspace is marked as one, and that is
deliberately the whole switch. Since issue #52 the marking is a property of the
workspace (`Workspace.isMemory`, set in the workspace's own settings page), not
a key here: `recall`, `remember` and `capture` are handed a user and a project
and never a workspace, so a deployment-wide pointer meant every account shared
one memory. Everything below resolves against the caller's own memory area, and
the regulators are workspace-scoped ([ADR-023](adr/ADR-023-settings-have-a-scope.md)).

| Setting                                             | Meaning                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.enabled`                                    | Master switch for writing. Off: nothing is captured or remembered; recall still answers.                                                                                                                                                                                                       |
| `memory.captureModelSlug`                           | Model that distils a session. Empty falls back to `ai.compactionModelSlug`, then `ai.defaultModelSlug`.                                                                                                                                                                                        |
| `memory.captureMinChars`                            | Shortest session worth remembering. The cheap half of the "is this memorable" question; the other half is the model's, which may answer that there is nothing to keep.                                                                                                                         |
| `memory.recallMaxChars` / `memory.recallMaxResults` | Hard ceilings on one recall answer, whatever a caller asks for. A memory that eats the context window it is meant to improve is worse than none.                                                                                                                                               |
| `memory.retentionDays`                              | How long a session note survives. `0` (the default) never deletes anything. With a period set, `prune-memories` moves an untouched note into the trash after it, and destroys it after a second one — so nothing was ever unrecoverable. Project pages and other workspaces are never touched. |
| `memory.mailboxEnabled`                             | The mailbox between agents ([ADR-047](adr/ADR-047-a-message-is-a-delivery-not-a-page.md)). On by default and free while nobody writes: an empty mailbox changes no recall. Off refuses sending and keeps mail out of recalls.                                                                  |
| `memory.messageExpiryDays`                          | How long a message waits when the sender names no span. Not `memory.retentionDays`: that one defaults to "for ever", which is right for notes and wrong for post. `prune-agent-messages` deletes what has passed it, hourly.                                                                   |
| `memory.recallMessageLimit`                         | Unread messages a recall puts in front of everything else. The hard ceiling: a full mailbox must not eat the context window the recall exists to improve. `0` keeps mail out of recalls; `exo_agent_messages` still reads it.                                                                  |

**Do not mark a curated workspace as the memory area.** Automatically
written session notes belong where they may be tidied and expired; a workspace
somebody reads as a document is not that. The permission model does the rest:
give the agent account a writing role in the memory workspace and a reading role
in the curated ones, and `requireRole` makes the boundary physical, whatever
scope its token carries ([ADR-019](adr/ADR-019-agent-memory-in-its-own-workspace.md)).

### Web research settings (issue #26)

Off until somebody turns it on, and the reason is not cost: this is outgoing
traffic from your server to addresses a model chooses. It needs two containers
to be useful, and neither is configured by default -- SearXNG finds addresses
(`SEARXNG_BASE_URL`), a Steel browser reads the page behind one
(`STEEL_BASE_URL`). With neither set, the switch can be on and the tools still
report that nothing is configured.

| Setting                          | Meaning                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.webResearchEnabled`          | Master switch. A workspace may switch it off for itself; a deployment that switches it off switches every workspace off with it.                                                                          |
| `ai.webResearchMaxChars`         | Cap on the text of one fetched page. What is cut is announced as cut, so nothing summarises an ending it never read.                                                                                      |
| `ai.webResearchMaxFetchesPerRun` | Pages one run may read. `0` takes the fetch tool out of the catalogue and leaves searching in place. The budget is spent on the attempt, not on the page, so a broken address cannot be retried for ever. |
| `ai.webSearchMaxResults`         | Hits one search returns.                                                                                                                                                                                  |

A fetched page is foreign text, so `ai.untrustedContentPolicy` applies to it the
way it applies to an uploaded PDF: after a run has read one, mutating tools are
refused for the rest of that run. Turning research on therefore does not widen
what a poisoned page can ask for
([ADR-030](adr/ADR-030-foreign-content-and-mutating-tools.md),
[ADR-033](adr/ADR-033-web-research-through-rest.md)).

What a search result list cannot promise: SearXNG scrapes the engines itself,
and from a datacentre address some of them answer with a CAPTCHA rather than
results. The engines that stayed silent are named in the answer, so a short list
is readable as "an engine said no" rather than "nothing exists".

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
text has not changed is never embedded twice. A page above 2400 characters pays
for its passages on top of that, at most 64 of them
([ADR-034](adr/ADR-034-passages-beside-the-page-vector.md)); on this
installation that is about 2 percent of the pages. Searching costs one embedding
of the query per search
([ADR-020](adr/ADR-020-semantic-search-beside-full-text.md)).

## The AI model registry

`AiModel` is the admin-editable catalogue of selectable models. The picker, the
context-window arithmetic behind compaction, and the per-run cost estimate all
read from it, so a model that is not in the registry cannot be chosen.

```bash
# Seed the curated list (idempotent: upserts by slug, wires vision companions).
pnpm --filter @exocortex/database db:seed:ai-models

# What the provider offers right now, marked with what the registry has.
GET  /api/admin/ai-models/catalog

# Register picked slugs with everything the provider knows about them.
POST /api/admin/ai-models/catalog     # {"slugs":["z-ai/glm-5.2"],"enabled":true}

# Which providers serve one model, with what capacity (ADR-032).
GET  /api/admin/ai-models/:modelId/endpoints

# Refresh prices, context windows and capabilities from the live provider.
POST /api/admin/ai-models/sync        # optionally {"slugs":["z-ai/glm-5.2"]}
```

**Registering a model is picking it, not typing it.** Everything the registry
stores is already in the provider's list, so `GET .../catalog` maps that list
onto the registry's columns and the admin area shows it as a searchable dialog
(`ModelCatalogDialog`). `POST .../catalog` then creates the picked rows, sorted
after the existing ones and enabled by default — picking a model out of a list
is the deliberate act that `sync`'s `addMissing` switch was asking for, and a
slug that has meanwhile been registered is skipped rather than refused, so one
stale row does not lose the other nine. The manual form stays for a model the
provider does not offer and for correcting a row afterwards. The catalogue is
not cached server-side: a stale price here would be copied into a row.

**An alias is resolved, and so are its providers.** OpenRouter's
`~vendor/model-latest` entries always point at the current model of a family
(`alias_target`), and their row carries the figures of the _cheapest_ endpoint
rather than of the model. So the catalogue describes an alias with the target's
figures, and registering or syncing any model also reads
`GET /models/{target}/endpoints` into `ai_model_endpoint` (ADR-032). That
snapshot is what every request's provider allowlist is planned from; the model's
own `contextWindowTokens` becomes the largest window a provider offers, and its
prices the highest, because the router may pick either end. Expanding a row in
the admin table shows the snapshot: provider, usable input, output limit, price,
capabilities, and when it was last refreshed. `sync-ai-model-routes` keeps it
current hourly, and a run that sees an alias answer as a different model marks
the row for the next sweep itself.

`sync` reads the live OpenRouter model list. A slug that has disappeared
upstream is set to `enabled = false` rather than deleted, so conversations that
already reference it still resolve (ADR-012 / risk R12). CRUD for individual
rows is `POST`, `PATCH /api/admin/ai-models/:modelId` and `DELETE`; a disabled
model leaves the picker but stays resolvable.

**Grouped by vendor.** Both the admin table and the chat's model picker group
the list by the vendor segment of the slug (`openai/gpt-5` is made by OpenAI and
served by OpenRouter). It is derived, not stored: `provider` on the row already
means who serves the model, and a second column would be one more field to fill
in by hand. `aiModelVendorLabel` (`packages/contracts/src/ai-models.ts`) knows
how the common vendors spell themselves and title-cases the rest, so a vendor
nobody has heard of yet still reads as a name.

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

## AI usage: what it costs and how reliably it answers

`/admin/nutzung`, behind `GET /api/admin/ai-usage?from=…&to=…` and the MCP tool
`exo_ai_usage` (issue #10). Everything on it is derived from `ai_run` over the
requested window: run counts per status, success rate, cost, tokens in and out,
median and 95th-percentile duration, a breakdown per model, an error-code table
and a daily series stacked by outcome. The range defaults to thirty days and may
not exceed a year.

Three decisions are worth knowing before reading the numbers.

**Cost is two figures, never one.** `providerCostMicroUsd` is what the provider
reported; `estimatedCostMicroUsd` is what the model registry's prices say the
run cost, and it is written only when the provider reported nothing. They are
kept in separate columns and shown separately, because a total made only of
reported costs counts every unreported run as free — which was the state before
this view existed. A run that names a model the registry does not hold appears
as `unpricedRuns`: no price from either side, and no invented one.

**A cancelled run is not a failure.** It counts in neither half of the success
rate and does not appear in the error table. Somebody pressing stop says nothing
about whether the AI works, and counting it would make a deployment look worse
the more its users change their minds.

**The figures are columns, not JSON.** Before issue #10 everything lived inside
`AiRun.usage`, where each question needed a cast and no index helped. The five
figures are columns now; `usage` stays for provider-specific extras. Old rows
were carried over by the migration, except for the estimate, which needs the
price at the time of the run and cannot be recovered after the fact.

Retention: `ai.runPayloadRetentionDays` empties the prompt and answer of old
runs while keeping their figures, so the history stays cheap. See
`prune-ai-run-payloads` in `docs/background-jobs.md`.

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
  `DELETE /api/me/connections/:clientId`. That call deletes the account's
  refresh grants for the client, so renewal stops; deletes its consent; and
  switches the `oauth_client` row off when nobody else still consents to it.
  That last step is what ends the access token the client may be holding right
  now: it is a signed JWT with no row to delete, and `disabled` is checked on
  every use. Before this existed, the only way to end a connection was an
  UPDATE against the database.
- **Token** — the personal API tokens described above.
- **Einrichten** — one finished command per client, built from
  `apps/web/src/lib/connection-snippets.ts` and the browser's own origin. The
  reveal dialog renders the same command with the new secret already inside it:
  a token is shown once, so anything a person has to paste in by hand is a step
  where setup fails. The first card is the Claude Code plugin in
  `tools/claude-code-plugin`, which is the only entry that carries no token at
  all: Claude Code asks for it itself when the plugin is enabled.

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

## Agenten: what an agent wrote, and taking it back

`/admin/agenten` lists every agent session this deployment has recorded: which
client, which account, over what period, how many writes on how many pages
(issue #49, ADR-022). "Details" shows the writes themselves, newest first, with
one column that matters more than the rest — whether the write left a state to
go back to.

"Zurücknehmen" sets every page of that session back to the state before its
first write there. It is partial by nature and reports as such: a page somebody
else has written since is skipped and named, never overwritten, and so is a page
whose only change was a rename or a move, because those leave no snapshot to
return to. The revert itself snapshots the current state of each page first, so
the step is undoable in turn.

The page exists so that giving an agent write access stops being a decision one
has to be brave about. That is also why the revert is **not** an MCP tool: an
agent that could take back an afternoon in one call would be a new way to lose
work. Listing and reading a session are tools
(`exo_agent_session_list`, `exo_agent_session_get`); pressing the button is a
human act.

`agents.journalRetentionDays` under Einstellungen decides how long the list
reaches back. See `prune-agent-journal` in `docs/background-jobs.md`.

### How large an agent may let a page grow

Two more keys under `agents.*`, and unlike the one above they are
workspace-overridable with the deployment value as a ceiling, because how big a
page may get is a fact about what a workspace keeps rather than about what an
agent is allowed to do (issue #118, ADR-023):

- `agents.largePageChars` (15,000) is where the answer to a write starts naming
  the page's new size and its biggest sections, and suggests a subpage for the
  next topic. Nothing is refused.
- `agents.oversizedPageChars` (50,000) is where a write that would make the page
  **bigger** is refused with `document_page_oversized`. The message names the
  biggest sections and `exo_page_extract_section`, which moves one of them onto
  its own page in a single call.

Three things this deliberately does not do. It is not a limit on page size: a
clip, an import, the inbox, the entity profiles, the agent memory and anybody
typing in the editor write past both numbers untouched, and no page is ever
split automatically (issue #118, section 10). It never blocks a write that
leaves the page the same size or smaller, or an oversized page would be one
nothing could repair. And it is judged against the Markdown the write produces,
never the stored `markdown` column, which a job derives and which lags.

## Automationen: the two switches only a global admin has

Rules live in a workspace and are written by its OWNER, but two of the things
that decide whether they can run at all are deployment-wide (issue #50,
ADR-024):

- `automations.enabled` is the main switch and defaults to **off**. It is
  workspace-overridable with this value as a ceiling, so switching it off here
  switches it off everywhere and no workspace can switch it back on.
- `automations.webhookAllowedHosts` starts **empty**, which means no webhook
  rule can be created and none can fire. Hosts are comma-separated, without
  scheme or port; a subdomain of an allowed host counts. It is checked when a
  rule is saved and again every time one fires, so shortening this list stops
  the rules that already exist.

Neither is reachable from a workspace's own settings. Everything else about
automations is, including the run log: `docs/automations.md`.

## Übersichtsseiten: what a composition costs

A page marked as an overview describes its sub-pages, and keeps describing them
(issue #53, [ADR-028](adr/ADR-028-overview-pages-are-derived.md)). The marking
is per page and belongs to whoever writes; what belongs here is the spending.

| Setting                    | Meaning                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview.enabled`         | Whether anything is composed at all. **On** by default, and a ceiling: off here is off everywhere. Off still lists every sub-page, because that list is read from the tree and costs nothing.   |
| `overview.modelSlug`       | Empty falls back to `ai.defaultModelSlug`. A small model belongs here: the work is two to five sentences at a time, many times.                                                                 |
| `overview.debounceSeconds` | How long a page has to stay quiet before its overview is recomposed. 300 by default, much longer than an automation's: nobody is waiting for a paragraph.                                       |
| `overview.maxChildren`     | Beyond this no paragraph is written and the list stays complete. A prompt with two hundred digests in it is expensive and says nothing the list does not.                                       |
| `overview.maxPageChars`    | How much of a page's own text reaches its digest prompt.                                                                                                                                        |
| `overview.generateCovers`  | Draws a cover for an overview page that has none, once per page. Needs `ai.imageGenerationEnabled` and an `ai.imageModelSlug`, so it does nothing in a deployment that has not paid for images. |

What is actually spent: one small call per changed page under an overview, one
per overview whose children changed, both only when the input hash has moved.
A page nobody has marked never reaches a model.

## Adding a setting

1. Add the field with a `.default()` to `settingsSchema`
   (`packages/contracts/src/settings.ts`). If an env var should seed it, add it to
   `SETTING_ENV_MAP` too.
2. Read it where it applies: `settingsService.getKey('your.key')` in `apps/api`,
   or the resolved `settings` object in the worker.
3. Add a control to `apps/web/src/components/admin/settings-form.tsx`. It diffs
   against the loaded values and sends only what changed — keep that property.
   That diff is also what the unsaved-changes guard counts
   (`components/settings/unsaved-changes-guard.tsx`, issue #113): a setting
   that compares unequal to itself would make the form claim an edit nobody
   made, and warn about losing it on every navigation.
4. Add the row to the table above.

No migration is needed: the `setting` table is key/value.
