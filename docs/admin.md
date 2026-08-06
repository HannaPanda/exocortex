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

## Settings

Runtime configuration lives in the `setting` table and overrides the
environment; see ADR-013 for why, and for the resolution order
(defaults < env < database). Read with `GET /api/admin/settings`, write a
**partial** patch with `PATCH /api/admin/settings`. An empty table is a valid
state: every key falls back to its default.

The keys below are generated from `settingsSchema` in
`packages/contracts/src/settings.ts`, which is the authority. Add a key there
first; the admin form and this table follow.

| Key | Type | Default | Affects |
| --- | --- | --- | --- |
| `ai.enabled` | boolean | `true` | Master switch for the AI pipeline. |
| `ai.defaultModelSlug` | string \| null | `null` → `OPENROUTER_DEFAULT_MODEL` | Model used when a conversation names none. Must be a slug in the `ai_model` registry. |
| `ai.systemPrompt` | string (≤ 8000) | `''` | Prepended to every run's system prompt, ahead of any AI rule pages. |
| `ai.maxOutputTokens` | int 256–200000 | `4096` | Output cap per model call. |
| `ai.timeoutMs` | int 5000–600000 | `180000` | Hard timeout per run. |
| `ai.budgetMicroUsdPerRun` | int 1000–50000000 | `500000` | Cost ceiling per run (µUSD), checked per tool iteration. |
| `ai.toolsEnabled` | boolean | `true` | Whether the built-in AI gets tools at all. Also requires `SERVICE_TOKEN_SECRET`. |
| `ai.mutatingToolsEnabled` | boolean | `true` | Whether the AI may call tools that change data. |
| `ai.maxToolIterations` | int 0–25 | `8` | Tool round-trips per run before the loop stops. |
| `ai.visionEnabled` | boolean | `true` | Master switch for vision preprocessing (ADR-012). |
| `ai.visionMaxImagesPerRun` | int 0–16 | `4` | Images described per run. |
| `ai.compactionThresholdPercent` | int 30–95 | `70` | Share of the context window at which compaction starts. |
| `ai.compactionKeepRecentMessages` | int 2–40 | `8` | Messages left untouched by a compaction. |
| `ai.compactionModelSlug` | string \| null | `null` | Model that writes the summary. Null reuses the conversation's model. |
| `ai.pdfExtractionEnabled` | boolean | `true` | Whether the `attachment-text` queue extracts PDF text. |
| `ai.pdfExtractor` | `docling` \| `openrouter` | `docling` | Engine tried first. `docling` is local, free per document and reads scans; `openrouter` needs no container but is billed per page. |
| `ai.pdfExtractorFallbackEnabled` | boolean | `true` | Try the other engine when the one above finds nothing or fails. No effect when only one of the two is configured. |
| `ai.pdfExtractionModelSlug` | string \| null | `null` | Model with a file parser. Null reuses `ai.defaultModelSlug`. |
| `ai.pdfMaxBytes` | int 1024–52428800 | `10485760` | Largest PDF that is extracted. |
| `mcp.enabled` | boolean | `true` | Master switch for the MCP tool surface. |
| `mcp.maxSearchResults` | int 1–100 | `20` | Result cap for `exo_search`. |
| `mcp.writeConfirmationRequired` | boolean | `true` | Two-step, destination-keyed confirmation for mutating MCP tools. |

Secrets are deliberately **not** settings. `OPENROUTER_API_KEY`,
`SERVICE_TOKEN_SECRET` and `DATABASE_URL` stay in `.env`, out of reach of
`GET /api/admin/settings`.

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

## API tokens

Long-lived bearer credentials for external clients (the MCP server, scripts,
cron jobs). A token carries **exactly its user's permissions** — nothing more,
nothing less — because `TokenOrSessionGuard` resolves it into the same
`VerifiedSession` a cookie produces (ADR/decision D1). There is no separate
scope vocabulary; `ApiToken.scopes` exists but an empty array means "everything
this user may do".

```bash
pnpm --filter @exocortex/api token:create -- \
  --email johanna@hannapanda.de --name "Hermes MCP" --days 365
```

The raw value is printed on the last line and **never again**: only its SHA-256
hash and a 12-character `prefix` are stored. Users manage their own tokens at
`/einstellungen/tokens` and through `GET`/`POST /api/me/api-tokens` and
`DELETE /api/me/api-tokens/:tokenId`.

Two prefixes exist, and they are different mechanisms:

* **`exo_`** — a user's `ApiToken` row, revocable, optionally expiring.
* **`exos_`** — a short-lived HMAC service token the worker mints for its own
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
