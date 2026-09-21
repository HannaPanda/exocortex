#!/usr/bin/env node
/**
 * Gate: the browser, the built-in AI and MCP can reach the same capabilities.
 *
 * ADR-025 and CLAUDE.md rule 12. The three ways into eXocortex are three
 * clients of one API, not one product with two accessories, so a capability
 * that exists for one of them exists for all three unless there is a reason
 * written down. The reason is usually a good one -- a credential is typed by a
 * human, an agent does not grant itself a role -- and the point of this gate is
 * not to forbid the exception but to make it a sentence somebody wrote rather
 * than an omission nobody noticed.
 *
 * `check-mcp-catalog.mjs` asks the neighbouring question: does every route have
 * a tool at all. This one asks which surfaces that tool is offered on, and
 * whether the browser can reach a route the agents cannot. Two things can go
 * wrong that the other gate is blind to: a tool shipped with
 * `surfaces: ['mcp']` and nothing says why, and a feature that arrives with a
 * controller and a screen while the catalogue stays where it was.
 *
 * Three ways to go red:
 *
 *   1. a tool on `mcp` but not `ai`, or the other way round, with no reason
 *      listed below,
 *   2. a route the browser calls that no `ai` tool and no `mcp` tool reaches,
 *      with no reason in `check-mcp-catalog.mjs`,
 *   3. a query hook in `apps/web/src/lib/api` that calls the API and that no
 *      screen reaches. The UI column is about what a person can do, so a hook
 *      nobody renders is a capability nobody has -- and it used to read as
 *      browser coverage here, which is how a build history and two reorder
 *      routes sat in the client for a day with no way to them. Either render
 *      it or delete it; there is deliberately no exemption list, because
 *      "later" is what this failure mode is made of.
 *   4. `docs/capability-matrix.md` no longer matching the code. It is
 *      generated from this script (`--write`), so the audit the issue asks for
 *      is a file in the repository rather than a spreadsheet that ages.
 *
 * `research` and `memory` are not paritied against anything. They are
 * deliberately tiny catalogues shaped for one foreign client each -- ChatGPT's
 * deep-research connector wants exactly `search` and `fetch` -- so a tool that
 * lives only there is the point, not a gap.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectApiRoutes,
  collectTools,
  collectWebCalls,
  deadClientExports,
  matchesRoutePattern,
  repoRoot,
} from './lib/api-surface.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';

const MATRIX_PATH = join(repoRoot, 'docs/capability-matrix.md');

/**
 * Tools offered to one kind of agent and not the other, each with the reason.
 *
 * Every entry here is the same shape of argument: the built-in AI is not a
 * client sitting outside the deployment, it is a loop running inside it, and
 * three of these are tools that observe or bill that very loop. The fourth is
 * the one operation nothing undoes.
 */
const SURFACE_EXEMPT = [
  {
    tool: 'exo_ai_run_get',
    reason:
      'Reads the state of an AI run. The built-in AI is the thing being read; a model watching its own run spends tokens on the tokens it is spending.',
  },
  {
    tool: 'exo_ai_run_cancel',
    reason:
      'Cancels an AI run. Same reason, with teeth: the run it would most easily reach is its own.',
  },
  {
    tool: 'exo_ai_usage',
    reason:
      "The deployment's AI cost ledger. Same reason again, and it is an administrator's report rather than a workspace capability.",
  },
  {
    tool: 'exo_toolbox',
    reason:
      "Names the tool domains of the catalogue and opens one (issue #121). It exists because the built-in loop is offered a subset of the catalogue rather than all of it; an MCP client is handed everything at the handshake and has nothing to open, so on that surface the tool's only honest answer would be that it does not apply. It reaches no route and is not a capability: it is how the loop is told what it was not told about.",
  },
  {
    tool: 'exo_page_delete',
    reason:
      "The one operation no snapshot brings back. The built-in AI's loop has no confirmation gate -- it is governed by `ai.mutatingToolsEnabled`, one decision for every write there is -- so this stays with the surfaces that ask twice (`packages/mcp-tools/src/confirm.ts`).",
  },
];

/** The surfaces parity is measured across. See the note at the top about the other two. */
const PARITY_SURFACES = ['mcp', 'ai'];

// ---------------------------------------------------------------------------
// Reading the reasons the neighbouring gate already holds
// ---------------------------------------------------------------------------

/**
 * The route exemptions from `check-mcp-catalog.mjs`, read out of its source.
 *
 * Duplicating the list here would mean maintaining the same thirty reasons
 * twice and, eventually, two lists that disagree. Importing the script is not
 * an option either -- it runs its own checks and exits on import -- so the
 * literal is read as text. If the shape of that list changes, this returns
 * nothing, and the count in the matrix header collapses visibly rather than
 * quietly passing everything.
 */
function routeExemptions() {
  const source = readFileSync(join(repoRoot, 'scripts/check-mcp-catalog.mjs'), 'utf8');
  const list = source.slice(source.indexOf('const EXEMPT = ['), source.indexOf('\n];'));
  return [...list.matchAll(/route:\s*'([^']+)'/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** Every route the browser calls, with the surfaces that can reach it. */
function buildRows(tools, webCalls, apiRoutes) {
  const byRoute = new Map();
  for (const tool of tools) {
    for (const route of tool.routes) {
      if (!byRoute.has(route)) byRoute.set(route, []);
      byRoute.get(route).push(tool);
    }
  }

  const rows = [];
  for (const route of [...new Set([...webCalls.keys(), ...byRoute.keys()])].sort()) {
    const reaching = byRoute.get(route) ?? [];
    rows.push({
      route,
      ui: webCalls.has(route),
      ai: reaching.some((tool) => tool.surfaces.includes('ai')),
      mcp: reaching.some((tool) => tool.surfaces.includes('mcp')),
      tools: reaching.map((tool) => tool.name).sort(),
      where: apiRoutes.get(route) ?? null,
    });
  }
  return rows;
}

function renderMatrix(rows, exemptions, surfaceGaps) {
  const mark = (value) => (value ? '✓' : '·');
  const full = rows.filter((row) => row.ui && row.ai && row.mcp).length;

  const lines = [
    '<!-- Generated by scripts/check-capability-parity.mjs. Do not edit by hand:',
    '     run `node scripts/check-capability-parity.mjs --write` instead. -->',
    '',
    '# Capability matrix',
    '',
    'Which of the three clients of the API can reach which route: the browser',
    '(`apps/web`), the built-in AI, and an external MCP client. The rule behind it',
    'is ADR-025, and the gate that keeps this file honest is',
    '`scripts/check-capability-parity.mjs`.',
    '',
    'A `·` in the UI column is not a gap. Plenty of capabilities exist for agents',
    'and have no screen: an agent asks for a page as Markdown, a person opens the',
    'editor. A `·` under AI or MCP where the browser has a `✓` is the one that',
    'needs a reason, and every one of them has an entry in the exemption list of',
    '`scripts/check-mcp-catalog.mjs` or in `SURFACE_EXEMPT` here.',
    '',
    'A `✓` in the UI column means a screen reaches the route, not that a hook',
    'exists for it: a query hook in `apps/web/src/lib/api` that nothing imports',
    'counts for nothing here, and the gate goes red until it is rendered or',
    'deleted. It used to count, which is how a project build history and two',
    'reorder routes shipped with no way to them in the browser.',
    '',
    `${rows.length} routes are reachable from at least one client; ${full} from all three.`,
    '',
    '| Route | UI | AI | MCP | Tools |',
    '| --- | :-: | :-: | :-: | --- |',
  ];

  for (const row of rows) {
    const tools = row.tools.length === 0 ? '—' : row.tools.map((name) => `\`${name}\``).join(', ');
    lines.push(
      `| \`${row.route}\` | ${mark(row.ui)} | ${mark(row.ai)} | ${mark(row.mcp)} | ${tools} |`,
    );
  }

  lines.push('', '## Routes the browser reaches and agents do not', '');
  const uiOnly = rows.filter((row) => row.ui && (!row.ai || !row.mcp));
  if (uiOnly.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      `${uiOnly.length} of them. Each is covered by a documented exemption; the reasons`,
      'are in `scripts/check-mcp-catalog.mjs`, next to the route.',
      '',
    );
    for (const row of uiOnly) {
      const reached = [row.ai ? 'AI' : null, row.mcp ? 'MCP' : null].filter((one) => one !== null);
      const suffix = reached.length === 0 ? '' : ` (reachable from ${reached.join(' and ')})`;
      lines.push(`- \`${row.route}\`${suffix}`);
    }
  }

  lines.push('', '## Tools offered to one kind of agent only', '');
  if (surfaceGaps.length === 0) {
    lines.push('None.');
  } else {
    for (const gap of surfaceGaps) {
      lines.push(`- \`${gap.tool}\` — ${gap.surfaces.join(', ')}: ${gap.reason}`);
    }
  }

  lines.push('', '---', '', `Counted against ${exemptions} documented route exemptions.`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

step('Capability parity (browser ↔ built-in AI ↔ MCP)');

const write = process.argv.includes('--write');
const apiRoutes = collectApiRoutes();
const tools = collectTools();
const webCalls = collectWebCalls();
const exemptions = routeExemptions();

if (tools.length === 0) {
  fail(
    'No tools found in packages/mcp-tools',
    [],
    'The `defineTool` scan matched nothing, which means this gate is measuring nothing. Check whether the shape of a tool definition changed.',
  );
}
if (exemptions.length === 0) {
  fail(
    'Could not read the route exemptions from check-mcp-catalog.mjs',
    [],
    'That list is what tells this gate which UI-only routes are deliberate. Check whether the shape of its EXEMPT literal changed.',
  );
}

// -- 1. a tool on one agent surface and not the other ------------------------

const surfaceGaps = [];
const unexplained = [];
for (const tool of tools) {
  const on = PARITY_SURFACES.filter((surface) => tool.surfaces.includes(surface));
  if (on.length === 0 || on.length === PARITY_SURFACES.length) continue;
  const exemption = SURFACE_EXEMPT.find((entry) => entry.tool === tool.name);
  if (exemption === undefined) {
    unexplained.push(`${tool.name}  (only ${on.join(', ')} — ${tool.where})`);
    continue;
  }
  surfaceGaps.push({ tool: tool.name, surfaces: on, reason: exemption.reason });
}

const staleSurface = SURFACE_EXEMPT.filter(
  (entry) => !surfaceGaps.some((gap) => gap.tool === entry.tool),
).map((entry) => `${entry.tool} — is not a one-surface tool any more`);

// -- 2. a route the browser reaches and no agent does ------------------------

// A route that has a tool but is missing one agent surface belongs to the first
// check, which knows the tool's name and holds the reason; reporting it twice
// would put the same gap under two hints that say different things.
const rows = buildRows(tools, webCalls, apiRoutes);
const uiOnly = rows
  .filter((row) => row.ui && row.tools.length === 0)
  .filter((row) => !exemptions.some((pattern) => matchesRoutePattern(row.route, pattern)))
  .map((row) => `${row.route}  (${row.where ?? 'route not found in apps/api'})`);

// -- 3. a client hook no screen reaches -------------------------------------

const dead = [...deadClientExports().entries()].map(([name, file]) => `${name}  (${file})`);

// -- 4. the matrix in the repository -----------------------------------------

const rendered = renderMatrix(rows, exemptions.length, surfaceGaps);
let current = null;
try {
  current = readFileSync(MATRIX_PATH, 'utf8');
} catch {
  current = null;
}

if (write) {
  writeFileSync(MATRIX_PATH, rendered, 'utf8');
  info(`docs/capability-matrix.md written (${rows.length} routes)`);
}

// -- reporting ---------------------------------------------------------------

if (unexplained.length > 0) {
  fail(
    `${unexplained.length} tool(s) are offered to one kind of agent and not the other`,
    unexplained,
    'Add the missing surface to the tool, or add it to SURFACE_EXEMPT in this script with the reason the built-in AI and an external client should differ here.',
  );
}

if (staleSurface.length > 0) {
  fail(
    `${staleSurface.length} surface exemption(s) in this script match nothing`,
    staleSurface,
    'The tool gained the surface back, or was renamed or removed. Delete the entry — an exemption that explains nothing is a hole the next tool slips through.',
  );
}

if (uiOnly.length > 0) {
  fail(
    `${uiOnly.length} route(s) the browser calls cannot be reached by both kinds of agent`,
    uiOnly,
    'Add the tool in packages/mcp-tools on both surfaces (recipe: docs/mcp.md), or add the route to EXEMPT in scripts/check-mcp-catalog.mjs with the reason a person has to do this by hand.',
  );
}

if (dead.length > 0) {
  fail(
    `${dead.length} client hook(s) call the API and no screen reaches them`,
    dead,
    'Render it where a person would look for it, or delete it. A hook in lib/api that nothing imports is a capability the browser was given and never offered to anybody, and it used to count as browser coverage in the matrix.',
  );
}

if (!write && current !== rendered) {
  fail(
    'docs/capability-matrix.md is out of date',
    current === null ? ['the file is missing'] : ['the generated matrix differs from the file'],
    'Run `node scripts/check-capability-parity.mjs --write` and commit the result. The matrix is the audit ADR-025 asks for, and one nobody regenerates is worse than none.',
  );
}

const full = rows.filter((row) => row.ui && row.ai && row.mcp).length;
info(
  `${tools.length} tool(s), ${rows.length} reachable route(s): ${full} from all three clients, ` +
    `${surfaceGaps.length} tool(s) on one agent surface through a documented reason`,
);
ok('The browser, the built-in AI and MCP reach the same capabilities.');
