# ADR-062: the interface language belongs to the person

- Status: accepted
- Date: 2026-09-25

## Context

The interface was German by rule (CLAUDE.md rule 8): about 1,650 lines of
inline German across 196 files in `apps/web` and `packages/ui`, fixed
`'de-DE'` formatters in 54 files, and German produced on the server for a
reader: mail subjects, push texts, the run diagnosis in `AiRun.errorDetail`,
the 81 entries of the feature registry. Issue #98 asks for eight languages,
more to be added without rebuilding anything, translations that a model
drafts and a person can correct, and gates so none of it rests on
discipline.

## Decision

**A language is a property of the person, not of the URL.** The app sits
behind a login, and an address that changes with the reader's language would
be a second identity for every page. `User.locale` stores the choice
(`NULL` for "never chose"); resolution is `User.locale`, then the
`exocortex.locale` cookie, then `Accept-Language`, then German, in one
function (`resolveLocale` in `packages/i18n`). The session is loaded in the
browser, so the server renders from cookie and header and `LocaleSync` moves
the cookie to the account's choice once the session has arrived: on a device
the account already used the two agree from the first frame, on a new one the
first frame is in the browser's language.

**One package owns the catalogues, not the web app.** `packages/i18n` holds
`src/messages/<locale>/<namespace>.json` for every surface, because a mail
rendered in the worker and a button rendered in the browser have to agree on
what a word is. Its root entry point is browser-safe (locales, negotiation,
types); `@exocortex/i18n/catalog` imports every file and is for the server
side. The browser gets its own locale's web namespaces through
`NextIntlClientProvider`, never the mail templates. The locale list itself is
a wire contract (`SUPPORTED_LOCALES` in `packages/contracts`), so the API can
validate a choice without depending on the catalogues.

**`next-intl` in the browser, `use-intl` everywhere else.** Checked in
September 2026 against Lingui 6, which needs an SWC plugin and macros in the
build, and react-i18next, whose server-component story is thin and whose ICU
support is a plugin. `use-intl` is the same engine without Next, so a date in
a mail and a date on a screen are formatted by the same code.

**German is the source, and a translation remembers its source.**
`translation-state.json` records, per locale and key, the hash of the German
text a translation was made from and, while nobody edited it, the hash of what
the tool wrote. That is enough to tell four states apart without storing any
text twice: current, missing, stale (the German changed and the translation is
still the machine's), and review (the German changed and a person had
corrected the translation). The tool redoes the stale ones and reports the
review ones; it never overwrites a person without `--overwrite-manual`.

**The translator is a model, pinned, and checked.** `pnpm i18n:translate` calls
an OpenAI-compatible endpoint (OpenRouter by default) with `temperature: 0`, a
glossary, a short context per namespace and a register per language. The model
is a constant in the script (`google/gemini-3.8-flash`, chosen against a
51-string sample in Polish and French, see `docs/i18n.md`), because a model
change changes every future diff. Every answer is parsed and compared with
its source before it is written; a key that fails twice is not written at all.

**Two gates, no discipline.** `check-i18n.mjs` refuses a missing or extra key,
an empty string, an ICU message whose arguments, types, tags or select options
differ from German, a plural lacking a category of the target language, a
wrong brand spelling, a stale translation and a stale generated catalogue.
`check-i18n-literals.mjs` is a ratchet: per file, the number of code lines
carrying German may only fall, and the baseline has to follow it down in the
commit that lowered it. Both are dependency-free like every gate; the ICU
reader in `scripts/lib/icu.mjs` covers the syntax `use-intl` accepts and
nothing more. Key typing is `pnpm typecheck`'s part: the German catalogue is
next-intl's `Messages` type.

**Text for somebody else follows the reader.** A mail, a push, a diagnosis is
rendered in the recipient's locale, resolved when the job is queued, not in
the locale of whoever caused it. An invitation to somebody without an account
carries a language chosen in the invitation dialog, which becomes the new
account's first choice.

**Technical orderings stay locale-free.** `orderKey`, timestamps, ids, slugs,
hash inputs and serialisations compare by code unit; titles a person reads
alphabetically use `Intl.Collator` with the active locale.

## Consequences

- Adding a language is one entry in `SUPPORTED_LOCALES`, a line in the
  glossary's `register`, and `pnpm i18n:translate --locale <id>`.
- Changing German text means running the translation tool in the same commit
  series, or the build goes red. That costs a model call per change and is the
  price of never shipping a stale translation.
- The migration is gradual. Until the ratchet reaches zero, a non-German
  interface is partly German; the feature entry says so to the person.
- Not translated: user content, the model-facing text (system prompts, tool
  descriptions, MCP instructions), logs and error codes. The built-in AI
  answers in the language the person writes in and is told the interface
  locale only as a hint for runs without a human message.
- The root layout reads cookies and headers, so it renders on demand. Every
  screen behind the login already did; the styleguide is the one surface that
  lost static rendering.
