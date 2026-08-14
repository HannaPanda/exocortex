# ADR-013: Runtime settings live in the database, the environment bootstraps

- Status: accepted
- Date: 2026-08-05

## Context

Every tunable of the AI pipeline was an environment variable read at process
start: the default model, the per-run budget, the timeout, whether vision
preprocessing runs. Changing any of them meant editing `/var/www/exocortex/.env`
and restarting four systemd units. That is a deploy, performed by hand, for what
is really an operator preference — and it puts every such change out of reach of
the admin area entirely.

The environment cannot simply be replaced, though. All four units have to keep
booting from `.env` alone: a fresh clone, a rebuilt database, or a `setting`
table that has never been written to must not leave the deployment unable to
start. Configuration and secrets are also different problems. An API key belongs
in a file with restrictive permissions, not in a table any global admin can read
through `GET /api/admin/settings`.

## Decision

Runtime configuration lives in a `Setting` table, one row per key, the value as
JSON. `settingsSchema` in `packages/contracts/src/settings.ts` is the single
definition of what a setting is: every field carries a `.default()`, so
`settingsSchema.parse({})` is the complete fallback configuration.

`resolveSettings()` merges three layers, in this order:

1. the zod defaults,
2. the environment, for the keys listed in `SETTING_ENV_MAP`,
3. the `setting` rows.

So the database wins at runtime, the environment is the bootstrap fallback, and
the defaults are the floor. `SettingsService` in `apps/api` caches the resolved
object for 15 seconds and invalidates that cache on write; the worker reads the
table directly through Prisma and calls the same `resolveSettings()`, so the two
processes cannot disagree about what a setting means.

Secrets stay in `.env` and are deliberately absent from `settingsSchema`:
`OPENROUTER_API_KEY`, `SERVICE_TOKEN_SECRET`, `DATABASE_URL`. A setting is a
preference, never a credential.

## Consequences

- **An empty table is a valid, fully functional state.** Nothing has to be
  seeded. The deployment behaves exactly as it did before this ADR until an
  admin changes something.
- **A bad row is dropped, not fatal.** `resolveSettings()` validates each value
  individually; one that fails is discarded, its key reported in `invalidKeys`
  and logged as a warning, and the key falls back to env or default. A
  hand-edited row can never stop a process from booting, which is the property
  that makes it safe for the worker to read this table on a hot path.
- **A patch must be a real partial.** `SettingsService.update` writes one row
  per key it is given, so the update contract has to keep absent keys absent.
  `settingsSchema.partial()` does _not_: zod keeps each field's `.default()`
  inside the optional it produces, so a one-key patch parses into all twenty
  keys and the first save would materialize every default as an explicit row —
  pinning `ai.defaultModelSlug` to `null` and shadowing
  `OPENROUTER_DEFAULT_MODEL` permanently. `updateSettingsRequestSchema`
  therefore unwraps each default before making the field optional. The tests in
  `packages/contracts/src/settings.test.ts` pin this behaviour; it is the one
  way this ADR can be silently undone.
- **The env values that are still consulted are a small, explicit list.**
  `SETTING_ENV_MAP` names them. A new setting that has no env counterpart simply
  does not appear there, and that is the normal case.
- **Reads are eventually consistent for up to 15 seconds** across processes. A
  setting changed in the admin area can take that long to affect a worker run
  already in flight. Acceptable: none of these values need to change atomically.
