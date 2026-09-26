#!/usr/bin/env node
/**
 * Gate: every place in the browser can be reached by name from Strg+K.
 *
 * Issue #148. The command palette is meant to be a way into the whole
 * application, not a side feature somebody remembers to update. The part of
 * that a build can check is the part that is countable: a screen exists, so a
 * command opens it; a settings group exists, so somebody typing its subject
 * lands in it.
 *
 * Two inventories, each compared in both directions:
 *
 *   1. the screens -- every `page.tsx` under `apps/web/src/app` has to be
 *      claimed by a `screen: '…'` in `navigation-commands.tsx`, or excused
 *      below with the reason it is not a place one goes to by name. A claim
 *      naming a screen that is gone is red too: the command would open a 404.
 *   2. the settings groups -- every group the settings page shows (the keys of
 *      `settings.groups` in the German catalogue) has search words under
 *      `shell.paletteCommands.settings.groups`. The commands themselves are
 *      derived from `SETTING_GROUPS`, so the words are the one thing a new
 *      group can arrive without.
 *
 * What it cannot see: an action hidden in a menu, a new tab on an existing
 * page, a dialog. Those are the rule in AGENTS.md and docs/command-palette.md,
 * checked by whoever reviews the change.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStringLiteral, repoRoot } from './lib/api-surface.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';
import { readNamespace, SOURCE_LOCALE } from './lib/i18n-catalog.mjs';
import { collectScreens } from './lib/web-screens.mjs';

const NAVIGATION_FILE = 'apps/web/src/components/palette/navigation-commands.tsx';

/**
 * Screens no command has to open, each with the reason.
 *
 * The test for an entry: would a person ever type its name to go there? A
 * page is reached by its title, which the same palette searches; a link
 * somebody was sent is reached by the link.
 */
const SCREEN_EXEMPT = [
  { screen: '/', reason: 'A redirect into /arbeitsbereich, not a screen.' },
  { screen: '/anmelden', reason: 'Signing in: the palette only exists once one is.' },
  { screen: '/passwort-vergessen', reason: 'Before signing in, like /anmelden.' },
  {
    screen: '/einladung/:x',
    reason: 'Opened from the invitation mail, with a token nobody types.',
  },
  {
    screen: '/verbinden',
    reason: 'The OAuth consent screen a connecting client sends the browser to.',
  },
  { screen: '/freigabe/:x', reason: 'A public link, anonymous and outside the shell.' },
  {
    screen: '/einstellungen/tokens',
    reason: 'A redirect to /einstellungen/verbindungen, kept for old bookmarks.',
  },
  {
    screen: '/teilen',
    reason:
      'The share target and the bookmarklet: it needs the address being shared, which only the sender has. Capture is the palette command for the same thing.',
  },
  {
    screen: '/arbeitsbereich/:x/seite/:x',
    reason: 'A page: found by its title in the same palette, which is its name.',
  },
  {
    screen: '/arbeitsbereich/:x/projekt/:x',
    reason: 'A project is a page and is found by its title like one.',
  },
  {
    screen: '/arbeitsbereich/:x/suche/:x',
    reason: 'A saved search: the palette lists every one by its name.',
  },
  {
    screen: '/arbeitsbereich/:x/auftraege/:x',
    reason: 'One work item, reached from the Aufträge list, which the palette opens.',
  },
  {
    screen: '/geteilt/:x',
    reason: 'One page somebody shared, reached from /geteilt, which the palette opens.',
  },
  {
    screen: '/design-system/rahmen/:x',
    reason: 'One styleguide experiment alone, drawn inside the styleguide’s iframe.',
  },
];

/** Every `screen: '…'` literal in the navigation module, with its line. */
function collectClaims() {
  const source = readFileSync(join(repoRoot, NAVIGATION_FILE), 'utf8');
  const claims = new Map();
  const pattern = /\bscreen:\s*(?=['"`])/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const literal = readStringLiteral(source, pattern.lastIndex);
    if (literal === null) continue;
    const line = source.slice(0, match.index).split('\n').length;
    claims.set(literal.text, `${NAVIGATION_FILE}:${line}`);
  }
  return claims;
}

step('Command palette coverage (every place can be opened by name)');

const screens = collectScreens();
const claims = collectClaims();
if (screens.size === 0 || claims.size === 0) {
  fail(
    'One of the inventories came back empty',
    [`screens: ${screens.size}`, `palette claims: ${claims.size}`],
    `An empty inventory passes everything. Check whether ${NAVIGATION_FILE} still writes its places as \`screen: '…'\`.`,
  );
}

const findings = [];
const hints = new Set();
const exempt = new Map(SCREEN_EXEMPT.map((entry) => [entry.screen, entry.reason]));

for (const [screen, where] of screens) {
  if (claims.has(screen) || exempt.has(screen)) continue;
  findings.push(`no palette command opens the screen ${screen}  (${where})`);
  hints.add(
    `Add the place to PLACES in ${NAVIGATION_FILE} with its label and search words under shell.paletteCommands.navigation, or, if nobody would ever go there by name, to SCREEN_EXEMPT in this script with the reason. Recipe: docs/command-palette.md.`,
  );
}
for (const [screen, where] of claims) {
  if (screens.has(screen)) continue;
  findings.push(`a palette command opens a screen that does not exist: ${screen}  (${where})`);
  hints.add('Correct or delete the place: the command would open a page that is not there.');
}
for (const [screen] of exempt) {
  if (!screens.has(screen)) {
    findings.push(`the screen exemption \`${screen}\` matches nothing`);
    hints.add('Delete the exemption: one that explains nothing is a hole.');
  } else if (claims.has(screen)) {
    findings.push(`the screen ${screen} is both opened by a command and exempted`);
    hints.add('Delete the exemption: the command answers the question it was excusing.');
  }
}

const groups = Object.keys(readNamespace(SOURCE_LOCALE, 'settings')?.groups ?? {});
const words = readNamespace(SOURCE_LOCALE, 'shell')?.paletteCommands?.settings?.groups ?? {};
if (groups.length === 0) {
  findings.push(`${SOURCE_LOCALE}/settings.json has no \`groups\``);
  hints.add('The settings groups are read from `settings.groups`; check whether it moved.');
}
for (const group of groups) {
  if (typeof words[group] === 'string' && words[group].trim().length > 0) continue;
  findings.push(`the settings group \`${group}\` has no palette search words`);
  hints.add(
    `Write them in ${SOURCE_LOCALE}/shell.json under paletteCommands.settings.groups.${'<group>'}: the words somebody would type to find these settings, separated by spaces.`,
  );
}
for (const group of Object.keys(words)) {
  if (groups.includes(group)) continue;
  findings.push(`palette search words for the settings group \`${group}\`, which does not exist`);
  hints.add('Delete them, or rename them with the group.');
}

if (findings.length > 0) {
  const unique = [...hints];
  fail(
    `${findings.length} place(s) the command palette cannot open, or opens and are gone`,
    findings,
    unique.length === 1 ? unique[0] : `${unique.length} different causes; see the lines above.`,
  );
}

info(
  `${claims.size} command(s) open ${screens.size - SCREEN_EXEMPT.length} of ${screens.size} screen(s), ` +
    `${SCREEN_EXEMPT.length} exempt; ${groups.length} settings group(s) have search words`,
);
ok('Every place in the browser can be opened from the command palette.');
