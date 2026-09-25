# The command palette

`Strg + K` opens one field that answers three kinds of question at once: which
page, which saved search, and which thing the application can do or open.
Pages come from the search adapter, saved searches from their list, and
everything else from the command registry described here (issues #115, #148).

It is a way into the whole application, not a side feature. CLAUDE.md rule 16
says a feature brings its palette commands in the same commit series, and
`scripts/check-palette-coverage.mjs` enforces the part of that a build can
count.

## Where the commands live

```
apps/web/src/components/palette/
  palette-command.ts       the types, PaletteContext, keywordsOf, fillScreen
  registry.tsx             usePaletteCommands: the list of providers
  navigation-commands.tsx  PLACES: every screen one goes to by name
  settings-commands.tsx    the deployment's settings groups, the workspace tabs
  settings-addresses.ts    ?gruppe= and ?tab=, read by the settings pages
  shell-commands.tsx       capture, panels, trash (built in AppShell)
```

A command is a `PaletteCommand`:

| Field      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `id`       | stable and unique across all providers; it is the row's key                  |
| `group`    | `actions`, `view`, `navigation` or `settings`: the heading it stands under   |
| `label`    | from the catalogue, never inline                                             |
| `keywords` | words somebody might type instead, one message separated by spaces           |
| `icon`     | a `lucide-react` icon at `size-4 text-muted-foreground`                      |
| `hint`     | the shortcut doing the same thing, or where the target lives                 |
| `idle`     | offered before anything is typed; off by default, see below                  |
| `href`     | a place: rendered as a real link, so it opens in a new tab and can be copied |
| `run`      | an action here: runs after the palette closes                                |

Whether a command is offered is decided by its provider from the
`PaletteContext` (open workspace, open page, deployment role, workspace role),
so the condition sits beside the command. A command that cannot work on the
current surface is not offered at all, rather than offered and refused.

## Adding something

**A new screen.** Add it to `PLACES` in `navigation-commands.tsx` with its
route pattern written as a literal (`screen: '/arbeitsbereich/:x/vorlagen'`,
`:x` for a dynamic segment, the same spelling the capability matrix uses), its
audience and an icon. Write `label` and `keywords` under
`shell.paletteCommands.navigation.<key>` in
`packages/i18n/src/messages/de/shell.json`. If nobody would ever type its name
to go there (a page reached by its title, a link somebody was sent), add it to
`SCREEN_EXEMPT` in the gate with the reason instead.

**A new settings group.** Nothing to register: the commands are derived from
`SETTING_GROUPS` in `apps/web/src/components/settings/setting-copy.ts`, and
each opens `/admin/einstellungen?gruppe=<group>`. Write its search words under
`shell.paletteCommands.settings.groups.<group>`; the gate refuses a group
without them.

**A new tab on a settings page.** Give the page a query parameter the way
`settings-addresses.ts` does for the workspace settings, and add the command
to `settings-commands.tsx`. The gate cannot see tabs, so this one is on the
reviewer.

**A new domain of commands** (the page's actions, a database's, a chat's).
Write a provider module beside the others, a plain function from
`PaletteContext` and its translator to `PaletteCommand[]`, and add it to the
list in `registry.tsx`. Nothing else grows.

Then run `pnpm i18n:translate --all` for the new words.

## What it shows, and in which order

With nothing typed, the recently edited pages come first, then only the
commands marked `idle`, then the saved searches. Forty places underneath the
recent pages would bury the one list that needs no memory, so a place waits to
be asked for by name.

With something typed, matching commands come first, grouped as actions, view,
navigation, settings, then saved searches, then pages. Matching is word by
word: every typed word has to be found in the label, the heading or one of the
search words, in any order, so "einst ki" finds the KI settings.

## What stays out

Editor formatting (bold, headings, lists) belongs to the slash menu, where the
cursor is. The palette is for navigation, global actions, actions on the open
object and the application's functions.

## The gate

`node scripts/check-palette-coverage.mjs`, in `build.sh` among the hard gates:

- every `page.tsx` under `apps/web/src/app` is opened by a `screen:` in
  `navigation-commands.tsx` or excused in `SCREEN_EXEMPT` with a reason
- no command opens a screen that does not exist, and no exemption names one
- every key of `settings.groups` in the German catalogue has search words, and
  no search words are left for a group that is gone

It reads the source as text, like every gate here, so it runs before anything
is built. `scripts/gates.test.ts` proves each of these can still go red.
