#!/usr/bin/env node
/**
 * Gate: the central documents still describe the system that exists.
 *
 * Issue #58. Documentation drift is not a cosmetic problem here. Claude Code,
 * Codex and every other agent read `README.md`, `CLAUDE.md`, `AGENTS.md` and
 * `docs/` as their picture of the deployment before they touch anything, so a
 * README that still calls semantic search "deferred" does not merely look old:
 * it actively produces wrong decisions. Nobody files a bug about a paragraph,
 * which is why this has to be a gate rather than a habit.
 *
 * A gate cannot read prose and decide whether it is true. It can do two things
 * that catch the drift that actually happened:
 *
 *   1. **Inventory coverage.** Everything the repository enumerates in code --
 *      workspace packages, queues, maintenance tasks, compose services,
 *      systemd units, the documents in `docs/` -- has to be named in the
 *      document that claims to list it. Adding a queue without a line in
 *      `docs/background-jobs.md` is then a red build, not a discovery three
 *      months later. This half needs no maintenance: the lists come from the
 *      source, so a new entry protects itself.
 *
 *   2. **Claims the tree contradicts.** A sentence that was true once and is
 *      false now, paired with the file whose existence disproves it. The pair
 *      is the point: when a feature is removed the evidence path disappears
 *      and the claim becomes sayable again, so this list cannot rot into a
 *      set of phrases nobody may write any more.
 *
 * What it deliberately does not do: check that prose is complete, accurate or
 * well written. That is what reading it is for. This gate only guarantees that
 * no document silently stopped mentioning a moving part of the system.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');
const exists = (relativePath) => existsSync(join(repoRoot, relativePath));

/**
 * Directory entries, directories only, sorted, without the dotfiles.
 */
function directories(relativePath) {
  return readdirSync(join(repoRoot, relativePath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** The workspace's applications and packages, as the paths a document writes. */
function workspacePaths() {
  return [
    ...directories('apps').map((name) => `apps/${name}`),
    ...directories('packages').map((name) => `packages/${name}`),
  ];
}

/** Every document under `docs/`, excluding the ADRs, which have their own index. */
function docFiles() {
  return readdirSync(join(repoRoot, 'docs'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `docs/${entry.name}`)
    .sort();
}

/**
 * The queue names, read out of the one object that defines them.
 *
 * Parsed rather than imported: a gate has to run before anything is built, and
 * `packages/contracts` is TypeScript source.
 */
function queueNames() {
  const source = read('packages/contracts/src/jobs.ts');
  const block = /export const QUEUE_NAMES = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (block === null) throw new Error('QUEUE_NAMES not found in packages/contracts/src/jobs.ts');
  return [...block[1].matchAll(/:\s*'([a-z-]+)'/g)].map((match) => match[1]).sort();
}

/** The maintenance task names, from the enum in the job contract. */
function maintenanceTasks() {
  const source = read('packages/contracts/src/jobs.ts');
  const block =
    /export const maintenanceJobSchema[\s\S]*?task: z\.enum\(\[([\s\S]*?)\n {2}\]\)/.exec(source);
  if (block === null) throw new Error('maintenanceJobSchema task enum not found');
  return [...block[1].matchAll(/^\s*'([a-z-]+)',/gm)].map((match) => match[1]).sort();
}

/** The service names from the compose file: the keys one level under `services:`. */
function composeServices() {
  const source = read('docker-compose.yml');
  const block = /^services:\n([\s\S]*?)^volumes:/m.exec(source);
  if (block === null) throw new Error('services block not found in docker-compose.yml');
  return [...block[1].matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]).sort();
}

/** The unit files this repository installs, template units collapsed to their stem. */
function systemdUnits() {
  return readdirSync(join(repoRoot, 'deploy/systemd'))
    .filter((name) => name.endsWith('.service') || name.endsWith('.timer'))
    .map((name) => name.replace(/@?\.(service|timer)$/, ''))
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
}

/**
 * The inventories, each with the document that has to name every entry.
 *
 * `label` and `singular` are what the finding says; `hint` is the one sentence
 * that tells whoever hit it what to write and where.
 */
const INVENTORIES = [
  {
    label: 'workspace packages',
    singular: 'workspace package',
    entries: workspacePaths,
    documents: ['README.md', 'CLAUDE.md'],
    hint: 'Add the package to the repository layout in README.md and to the repository map in CLAUDE.md, with one line on what it owns.',
  },
  {
    label: 'documents under docs/',
    singular: 'document',
    entries: docFiles,
    documents: ['README.md'],
    hint: 'Add the document to the documentation table in README.md. A document nobody links to is a document nobody reads.',
  },
  {
    label: 'queues',
    singular: 'queue',
    entries: queueNames,
    documents: ['docs/background-jobs.md'],
    hint: 'Add the queue to the table in docs/background-jobs.md: what enqueues it, which processor runs it, and what happens when it fails.',
  },
  {
    label: 'maintenance tasks',
    singular: 'maintenance task',
    entries: maintenanceTasks,
    documents: ['docs/background-jobs.md'],
    hint: 'Add the task to docs/background-jobs.md, including its schedule and whether it is a sweep or event-driven.',
  },
  {
    label: 'compose services',
    singular: 'compose service',
    entries: composeServices,
    documents: ['docs/local-development.md'],
    hint: 'Add the service to docs/local-development.md with its host port and what it is for.',
  },
  {
    label: 'systemd units',
    singular: 'systemd unit',
    entries: systemdUnits,
    documents: ['deploy/README.md'],
    hint: 'Add the unit to deploy/README.md: what it runs, when, and how to tell whether it did.',
  },
];

/**
 * Sentences the tree disproves.
 *
 * Each entry pairs a claim with the file whose existence makes it false. The
 * claim is only forbidden while that file is there, so removing a feature
 * removes the rule with it rather than leaving a phrase banned for reasons
 * nobody remembers.
 */
const CONTRADICTED = [
  {
    claim: /no embeddings are generated|future semantic\s+search/i,
    evidence: 'packages/database/src/semantic-search.ts',
    reason: 'Semantic search is live (ADR-020): the hybrid adapter writes a vector per document.',
  },
  {
    claim: /adapter skeleton|skeleton only/i,
    evidence: 'packages/ai/src/openrouter-provider.ts',
    reason:
      'The OpenRouter provider makes real requests; it refuses to run without a key, which is not the same as being a skeleton.',
  },
  {
    claim: /COLLECTION` document type exists but has no behaviour/i,
    evidence: 'packages/database/src/database-query.ts',
    reason:
      'Databases are built (ADR-011): properties, four view types and a validated query engine.',
  },
  {
    claim: /comments and activity views \(/i,
    evidence: 'apps/web/src/components/shell/comments-panel.tsx',
    reason: 'Comments and the activity panel ship in the context panel.',
  },
  {
    claim: /a complete version-history UI/i,
    evidence: 'apps/web/src/components/shell/activity-panel.tsx',
    reason: 'The activity panel lists snapshots and restores them.',
  },
  {
    claim: /deliberately no CI|there is no CI|without a CI/i,
    evidence: '.github/workflows/build.yml',
    reason:
      'The workflow runs `bash scripts/build.sh` on every push and pull request, so the gates run somewhere other than the deployment host.',
  },
  {
    claim: /covered by the Playwright suite|only by Playwright|no frontend unit tests/i,
    evidence: 'apps/web/vitest.config.mts',
    reason:
      'The frontend has a Vitest suite of its own (issue #59) beside the Playwright one: pure state and transformation logic is tested without a browser.',
  },
  {
    claim: /only the packages are tested|hand-picked list of packages|apps are not covered by CI/i,
    evidence: 'scripts/check-test-split.mjs',
    reason:
      'Every workspace with tests runs in the default set since issue #93, and the test-split gate is what keeps it that way.',
  },
  {
    claim: /streams from a local mock provider/i,
    evidence: 'packages/ai/src/registry.ts',
    reason:
      'The mock provider is the offline default, not the only provider: models are configured in the admin area.',
  },
];

/** Every document this gate reads claims about. */
const CENTRAL_DOCUMENTS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docker-compose.yml',
  'deploy/README.md',
  ...docFiles().filter((file) => file !== 'docs/capability-matrix.md'),
];

step('Documentation currency (central documents describe the system that exists)');

const findings = [];
let covered = 0;

for (const inventory of INVENTORIES) {
  const entries = inventory.entries();
  covered += entries.length;
  for (const document of inventory.documents) {
    const source = read(document);
    const missing = entries.filter((entry) => !source.includes(entry));
    for (const entry of missing) {
      findings.push({
        line: `${document}: never mentions the ${inventory.singular} \`${entry}\``,
        hint: inventory.hint,
      });
    }
  }
}

for (const document of CENTRAL_DOCUMENTS) {
  const source = read(document);
  for (const entry of CONTRADICTED) {
    if (!entry.claim.test(source)) continue;
    if (!exists(entry.evidence)) continue;
    const index = source.split('\n').findIndex((line) => entry.claim.test(line));
    findings.push({
      line: `${document}:${index + 1}: a claim ${entry.evidence} disproves — ${entry.reason}`,
      hint: 'Rewrite the sentence to describe what is there now. If the feature really was removed, delete its entry from CONTRADICTED in this script in the same commit.',
    });
  }
}

if (findings.length > 0) {
  const hints = [...new Set(findings.map((finding) => finding.hint))];
  fail(
    `${findings.length} place(s) where a central document has fallen behind the repository`,
    findings.map((finding) => finding.line),
    hints.length === 1 ? hints[0] : `${hints.length} different causes; see the lines above.`,
  );
}

info(`${covered} inventory entries checked across ${CENTRAL_DOCUMENTS.length} documents`);
ok('The central documents name every moving part the repository defines.');
