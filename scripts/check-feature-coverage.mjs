#!/usr/bin/env node
/**
 * Gate: nothing a person can do here is missing from the feature registry.
 *
 * Issue #80, ADR-040, CLAUDE.md rule 15. The problem this exists for is not
 * documentation drift in the usual sense. It is that a deployment can grow
 * faster than its owner's memory of it: a feature is built, shipped, used
 * twice and forgotten, and a year later somebody does by hand what a screen
 * already does. The capability matrix does not help, because it speaks in
 * routes; the tool catalogue does not, because it speaks in arguments. What
 * helps is a sentence in a person's words, and the one thing a build can
 * enforce about a sentence is that somebody wrote one.
 *
 * So `packages/features` is written by hand and this gate counts. Three
 * inventories are read out of the source and every entry in them has to be
 * claimed by at least one feature:
 *
 *   1. the MCP tool catalogue -- anything an agent can call,
 *   2. the browser's screens -- every `page.tsx` under `apps/web/src/app`,
 *   3. the automation triggers and actions -- the two enums a rule is built
 *      from, because a new trigger is a new thing a person can automate and
 *      it arrives without a route or a tool of its own.
 *
 * And the other way round: a claim that matches nothing is red too. A tool
 * that was renamed leaves its old name behind in an entry describing a
 * capability that no longer works that way, which is worse than an entry
 * nobody wrote.
 *
 * "At least one", not "exactly one", on purpose. The page view hosts a dozen
 * capabilities, and forcing one of them to own it would buy a tidier counter
 * with a lie. Tools are held to "exactly one" instead, but by the catalogue's
 * own unit test rather than here, since that one needs the real types.
 *
 * The words themselves live in the German message catalogue, namespace
 * `features` (issue #98, ADR-062), keyed by the entry's id. So the gate reads
 * that too and holds the two halves together: every entry has a title, a
 * summary and a long form that is more than a teaser, a door in the browser
 * has its sentence saying where and only such a door has one, and no
 * catalogue entry is left over for an id the registry no longer has.
 *
 * What it cannot do: judge whether a summary is true, current or useful. That
 * is what reading it is for. It guarantees only that no capability shipped
 * with nobody having to describe it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectTools, readBlock, readStringLiteral, repoRoot } from './lib/api-surface.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';
import { readNamespace, SOURCE_LOCALE } from './lib/i18n-catalog.mjs';
import { collectScreens } from './lib/web-screens.mjs';

const REGISTRY_DIR = join(repoRoot, 'packages/features/src/features');
const AUTOMATION_CONTRACT = join(repoRoot, 'packages/contracts/src/automations.ts');

/**
 * Screens no feature has to describe, each with the reason.
 *
 * Three entries, and none is a capability: the root path redirects into the
 * workspace the shell resolves (describing it would mean writing "opening
 * eXocortex opens eXocortex"), and the styleguide and its frames show the interface's own
 * parts with made-up data.
 */
const SCREEN_EXEMPT = [
  { screen: '/', reason: 'A redirect into /arbeitsbereich, not a screen.' },
  {
    screen: '/design-system',
    reason:
      'The styleguide (issue #125): a reference for people and agents building the interface, drawn with fixtures. It does nothing with anybody’s data, so there is no capability to describe.',
  },
  {
    screen: '/design-system/rahmen/:x',
    reason:
      'One styleguide experiment alone, for the iframe that shows it at phone width (issue #126). Fixtures only, like the styleguide.',
  },
];

// ---------------------------------------------------------------------------
// The inventories
// ---------------------------------------------------------------------------

/** The members of one `z.enum([...])` in the automation contract. */
function enumMembers(name) {
  const source = readFileSync(AUTOMATION_CONTRACT, 'utf8');
  const start = source.indexOf(`export const ${name} = z.enum([`);
  if (start === -1) return [];
  const open = source.indexOf('[', start);
  let depth = 1;
  let cursor = open + 1;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === '[') depth += 1;
    else if (source[cursor] === ']') depth -= 1;
    cursor += 1;
  }
  return [...source.slice(open, cursor).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every `defineFeature({ … })` in the registry, read as text.
 *
 * Text and not an import, for the reason every gate here is: this has to run
 * with plain `node` before anything is built. The scan going quiet is what
 * `scripts/gates.test.ts` watches for, and the count below collapsing to zero
 * is what fails the run if it ever does.
 */
function collectRegistry() {
  const entries = [];
  for (const file of readdirSync(REGISTRY_DIR).filter((name) => name.endsWith('.ts'))) {
    const rel = `packages/features/src/features/${file}`;
    const source = readFileSync(join(REGISTRY_DIR, file), 'utf8');
    const opener = /\bdefineFeature\s*\(\s*\{/g;
    let match;
    while ((match = opener.exec(source)) !== null) {
      const block = readBlock(source, opener.lastIndex - 1).text;
      const id = block.match(/\bid:\s*'([^']+)'/)?.[1];
      if (id === undefined) continue;
      entries.push({
        id,
        where: `${rel}:${source.slice(0, match.index).split('\n').length}`,
        hasUi: /\bui:\s*\{/.test(block),
        tools: stringArray(block, 'tools'),
        screens: stringArray(block, 'screens'),
        automationTriggers: stringArray(block, 'automationTriggers'),
        automationActions: stringArray(block, 'automationActions'),
      });
    }
  }
  return entries;
}

/**
 * The string literals of `key: [ … ]` inside a block, or none.
 *
 * `readStringLiteral` rather than a character class, so an apostrophe inside a
 * German summary a few lines above cannot end an entry early.
 */
function stringArray(block, key) {
  const start = block.search(new RegExp(`\\b${key}:\\s*\\[`));
  if (start === -1) return [];
  const open = block.indexOf('[', start);
  let depth = 1;
  let cursor = open + 1;
  const found = [];
  while (cursor < block.length && depth > 0) {
    const char = block[cursor];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === "'" || char === '"' || char === '`') {
      const literal = readStringLiteral(block, cursor);
      if (literal !== null) {
        found.push(literal.text);
        cursor = literal.end;
        continue;
      }
    }
    cursor += 1;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/**
 * Two findings per inventory: what exists and nobody claimed, and what
 * somebody claimed and does not exist.
 */
function compare({ label, singular, exists, claimed, hint }) {
  const unclaimed = [...exists.entries()]
    .filter(([entry]) => !claimed.has(entry))
    .map(([entry, where]) => `${entry}  (${where})`);
  const stale = [...claimed.entries()]
    .filter(([entry]) => !exists.has(entry))
    .map(([entry, owners]) => `${entry}  (claimed by ${owners.join(', ')})`);
  return { label, singular, unclaimed, stale, hint };
}

/** entry -> the feature ids that claim it. */
function claimIndex(entries, field) {
  const claims = new Map();
  for (const entry of entries) {
    for (const value of entry[field]) {
      if (!claims.has(value)) claims.set(value, []);
      claims.get(value).push(entry.id);
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * What an entry's words lack in the German catalogue, as findings.
 *
 * The length rule was the catalogue's own unit test while the prose sat in
 * `packages/features`: an entry written to satisfy a schema is one paragraph
 * repeating the summary in other words. Two paragraphs and more than 400
 * characters is what "how it works, how you use it, where it stops" comes out
 * at; the gate cannot judge whether the prose is true, it can insist that
 * somebody sat down and wrote some.
 *
 * The paragraphs are `details.p1`, `details.p2` and on without a gap, because
 * the API reads them in that order and stops at the first one missing.
 */
function wordFindings(entry, words) {
  const where = `${SOURCE_LOCALE}/features.json ${entry.id}`;
  if (words === undefined || words === null || typeof words !== 'object') {
    return [`${entry.id} has no words in ${SOURCE_LOCALE}/features.json  (${entry.where})`];
  }
  const found = [];
  const text = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!text(words.title)) found.push(`${where}: no title`);
  if (!text(words.summary)) found.push(`${where}: no summary`);
  const details = words.details !== null && typeof words.details === 'object' ? words.details : {};
  const keys = Object.keys(details);
  const paragraphs = [];
  for (let index = 1; text(details[`p${index}`]); index += 1) {
    paragraphs.push(details[`p${index}`]);
  }
  if (paragraphs.length === 0) found.push(`${where}: no details.p1`);
  else if (paragraphs.length !== keys.length) {
    found.push(`${where}: details has to be p1, p2, … without a gap, found ${keys.join(', ')}`);
  } else {
    const written = paragraphs.join(' ');
    if (paragraphs.length < 2) found.push(`${where}: details has fewer than two paragraphs`);
    if (written.length <= 400) found.push(`${where}: details says too little`);
    if (text(words.summary) && written.includes(words.summary)) {
      found.push(`${where}: details repeats the summary verbatim`);
    }
  }
  if (entry.hasUi && !text(words.where)) {
    found.push(`${where}: the entry has a door in the browser (\`ui\`) and no \`where\` sentence`);
  }
  if (!entry.hasUi && words.where !== undefined) {
    found.push(`${where}: a \`where\` sentence for an entry without \`ui\``);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

step('Feature registry coverage (every capability is described somewhere)');

const registry = collectRegistry();
if (registry.length === 0) {
  fail(
    'No features found in packages/features',
    [],
    'The `defineFeature` scan matched nothing, which means this gate is measuring nothing. Check whether the shape of a registry entry changed.',
  );
}

const duplicateIds = registry
  .map((entry) => entry.id)
  .filter((id, index, all) => all.indexOf(id) !== index);

const toolInventory = new Map(collectTools().map((tool) => [tool.name, tool.where]));
const screenInventory = collectScreens();
for (const exemption of SCREEN_EXEMPT) screenInventory.delete(exemption.screen);

const triggerInventory = new Map(
  enumMembers('automationTriggerSchema').map((member) => [
    member,
    'packages/contracts/src/automations.ts',
  ]),
);
const actionInventory = new Map(
  enumMembers('automationActionSchema').map((member) => [
    member,
    'packages/contracts/src/automations.ts',
  ]),
);

if (toolInventory.size === 0 || triggerInventory.size === 0 || actionInventory.size === 0) {
  fail(
    'One of the inventories came back empty',
    [
      `tools: ${toolInventory.size}`,
      `automation triggers: ${triggerInventory.size}`,
      `automation actions: ${actionInventory.size}`,
    ],
    'An empty inventory passes everything. Check whether the shape of the tool definitions or of the automation enums changed.',
  );
}

const comparisons = [
  compare({
    label: 'MCP tools',
    singular: 'tool',
    exists: toolInventory,
    claimed: claimIndex(registry, 'tools'),
    hint: 'Add the tool to the `tools` of the feature it belongs to in packages/features/src/features, or write a new entry for the capability it gives somebody. Recipe: docs/features.md.',
  }),
  compare({
    label: 'browser screens',
    singular: 'screen',
    exists: screenInventory,
    claimed: claimIndex(registry, 'screens'),
    hint: 'Add the screen to `claims.screens` of the feature it serves, written the way the capability matrix writes a route (`/arbeitsbereich/:x/seite/:x`). A screen several features share may be claimed by each of them.',
  }),
  compare({
    label: 'automation triggers',
    singular: 'automation trigger',
    exists: triggerInventory,
    claimed: claimIndex(registry, 'automationTriggers'),
    hint: 'Add the trigger to `claims.automationTriggers` of the entry that describes what a person can now automate with it.',
  }),
  compare({
    label: 'automation actions',
    singular: 'automation action',
    exists: actionInventory,
    claimed: claimIndex(registry, 'automationActions'),
    hint: 'Add the action to `claims.automationActions` of the entry that describes what a rule can now do.',
  }),
];

const findings = [];
const hints = [];
for (const comparison of comparisons) {
  for (const line of comparison.unclaimed) {
    findings.push(`no feature describes the ${comparison.singular} ${line}`);
  }
  for (const line of comparison.stale) {
    findings.push(`a feature claims a ${comparison.singular} that does not exist: ${line}`);
  }
  if (comparison.unclaimed.length + comparison.stale.length > 0) hints.push(comparison.hint);
}

for (const id of new Set(duplicateIds)) {
  findings.push(`two registry entries share the id \`${id}\``);
  hints.push('An id is the anchor on the help page and has to be unique. Rename one of them.');
}

const catalogue = readNamespace(SOURCE_LOCALE, 'features') ?? {};
const registryIds = new Set(registry.map((entry) => entry.id));
for (const entry of registry) {
  const missing = wordFindings(entry, catalogue[entry.id]);
  findings.push(...missing);
  if (missing.length > 0) {
    hints.push(
      "An entry's title, summary, paragraphs (`details.p1` …) and `where` live in packages/i18n/src/messages/de/features.json under its id. Recipe: docs/features.md.",
    );
  }
}
for (const id of Object.keys(catalogue).filter((key) => !registryIds.has(key))) {
  findings.push(
    `${SOURCE_LOCALE}/features.json has words for \`${id}\`, which no registry entry has`,
  );
  hints.push(
    'Delete the catalogue entry, or rename it with the registry entry it belongs to: words for an id nobody serves are a feature that was removed and is still being described.',
  );
}

for (const exemption of SCREEN_EXEMPT) {
  if (collectScreens().has(exemption.screen)) continue;
  findings.push(`the screen exemption \`${exemption.screen}\` matches nothing`);
  hints.push(
    'Delete the exemption from SCREEN_EXEMPT in this script: one that explains nothing is a hole.',
  );
}

if (findings.length > 0) {
  const unique = [...new Set(hints)];
  fail(
    `${findings.length} capability/capabilities nobody described, or described and removed`,
    findings,
    unique.length === 1 ? unique[0] : `${unique.length} different causes; see the lines above.`,
  );
}

info(
  `${registry.length} feature(s) cover ${toolInventory.size} tool(s), ${screenInventory.size} screen(s), ` +
    `${triggerInventory.size} automation trigger(s) and ${actionInventory.size} action(s)`,
);
ok('Everything a person can do here is described in the feature registry.');
