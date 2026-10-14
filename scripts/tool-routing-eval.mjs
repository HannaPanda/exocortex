/**
 * Measures how the built-in agent's tool domains are chosen, router against
 * router, on the versioned gold standard in `evals/tool-routing/gold.json`
 * (issue #206, phase 0).
 *
 *   node scripts/tool-routing-eval.mjs --router keyword --split dev
 *   node scripts/tool-routing-eval.mjs --router context --split dev
 *   node scripts/tool-routing-eval.mjs --router jev --split dev --threshold 0.5
 *   node scripts/tool-routing-eval.mjs --router jev+context --split holdout --out /tmp/r.json
 *   node scripts/tool-routing-eval.mjs --router jev --split dev --sweep
 *   node scripts/tool-routing-eval.mjs --router scores --scores evals/tool-routing/results/e5-small-scores.json \\
 *     --variant exemplars --split dev --sweep --grid 0.80:0.95:0.01
 *
 * Routers:
 *
 * - `keyword`: `selectToolDomains` exactly as the worker calls it today, with
 *   the one context signal the worker has (an open database view).
 * - `context`: `keyword` plus what a run could know without a model call and
 *   does not use yet: the page on screen carries a picture or a PDF.
 * - `jev`: one yes/no question per optional domain, asked of TypeSafe's Jev
 *   through OpenRouter's Decisions API, plus the deterministic context.
 * - `jev+context`: the union of `jev` and `context`.
 * - `scores`: a score per case and domain computed elsewhere, by a router that
 *   cannot run inside this repository's dependencies (a local model, see
 *   `evals/tool-routing/local/`), with the deterministic context added.
 *
 * What it sends to OpenRouter is the gold standard's own sentences and the
 * domain descriptions below, never workspace content. Every answer is cached
 * by the hash of everything that shaped it, in a file that is committed as the
 * raw evidence, so a rerun, a threshold sweep or
 * a report costs nothing; `--no-cache` asks again. Nothing here starts a run
 * of the built-in AI, so `exo_toolbox` recovery is not part of these numbers.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEV_DECISION_MODEL, OpenRouterDecisionProvider } from '../packages/ai/dist/index.js';
import { createLogger } from '../packages/logger/dist/index.js';
import {
  ALWAYS_OFFERED_DOMAINS,
  EXOCORTEX_TOOLS,
  selectToolDomains,
  toolSchemaChars,
  toolsInDomains,
} from '../packages/mcp-tools/dist/index.js';

import {
  DOMAIN_QUESTIONS,
  loadCases,
  OPTIONAL_DOMAINS,
  PRODUCT,
  UNROUTED,
} from './lib/tool-routing-gold.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'evals/tool-routing/results/jev-answers.json');

function parseArgs(argv) {
  const args = { router: 'keyword', split: 'dev', threshold: 0.5, concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[(index += 1)];
    if (flag === '--router') args.router = next();
    else if (flag === '--split') args.split = next();
    else if (flag === '--threshold') args.threshold = Number(next());
    else if (flag === '--concurrency') args.concurrency = Number(next());
    else if (flag === '--out') args.out = next();
    else if (flag === '--sweep') args.sweep = true;
    else if (flag === '--grid') args.grid = next();
    else if (flag === '--scores') args.scores = next();
    else if (flag === '--variant') args.variant = next();
    else if (flag === '--no-cache') args.noCache = true;
    else if (flag === '--help') args.help = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  return args;
}

/** What the worker passes as `required` today (`processors/ai-run.ts`). */
function workerRequired(context) {
  return context.databaseViewOpen === true ? ['databases'] : [];
}

/** What a run could know for free and does not use yet. */
function contextRequired(context) {
  const domains = workerRequired(context);
  if ((context.pageAttachments ?? []).length > 0) domains.push('attachments');
  return domains;
}

function optional(domains) {
  return domains.filter((domain) => !UNROUTED.has(domain));
}

function keywordRouter(entry) {
  return optional(selectToolDomains({ text: entry.text, required: workerRequired(entry.context) }));
}

function contextRouter(entry) {
  return optional(
    selectToolDomains({ text: entry.text, required: contextRequired(entry.context) }),
  );
}

// ---------------------------------------------------------------- Jev

function jevQuestions() {
  return Object.fromEntries(
    Object.entries(DOMAIN_QUESTIONS).map(([domain, capability]) => [
      domain,
      {
        kind: 'yesNo',
        instructions: `Does fulfilling the \`request\` require tools to ${capability}?`,
      },
    ]),
  );
}

function jevState(entry) {
  const context = {};
  if (entry.context.databaseViewOpen) context.openPage = 'a database view';
  if ((entry.context.pageAttachments ?? []).length > 0) {
    context.pageCarries = entry.context.pageAttachments.map((kind) =>
      kind === 'image' ? 'pictures' : 'PDF files',
    );
  }
  return {
    product: PRODUCT,
    request: entry.text,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

function cacheKey(state, questions) {
  return createHash('sha256')
    .update(JSON.stringify({ model: JEV_DECISION_MODEL, state, questions }))
    .digest('hex');
}

function loadCache() {
  return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
}

function saveCache(cache) {
  mkdirSync(dirname(CACHE), { recursive: true });
  // One entry per line, sorted, so a rerun that changes three answers is a
  // diff of three lines.
  const lines = Object.keys(cache)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(cache[key])}`);
  writeFileSync(CACHE, `{\n${lines.join(',\n')}\n}\n`);
}

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const line = readFileSync(join(ROOT, '.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m);
  return (line?.[1] ?? '').replace(/^"|"$/g, '');
}

/** Asks Jev about every case not cached yet, a few at a time. */
async function jevAnswers(cases, args) {
  const provider = new OpenRouterDecisionProvider({
    apiKey: apiKey(),
    baseUrl: 'https://openrouter.ai/api/v1',
    logger: createLogger({ name: 'tool-routing-eval', level: 'silent' }),
    appUrl: 'https://exocortex.app',
  });
  const questions = jevQuestions();
  const cache = args.noCache ? {} : loadCache();
  const pending = cases.filter(
    (entry) => cache[cacheKey(jevState(entry), questions)] === undefined,
  );
  if (pending.length > 0)
    console.error(`Jev: ${pending.length} of ${cases.length} not cached, asking`);

  let cursor = 0;
  let failures = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[(cursor += 1) - 1];
      const state = jevState(entry);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const result = await provider.decide({
            model: JEV_DECISION_MODEL,
            state,
            questions,
            correlationId: `tool-routing-eval:${entry.id}`,
            signal: AbortSignal.timeout(15_000),
          });
          cache[cacheKey(state, questions)] = {
            probabilities: Object.fromEntries(
              Object.entries(result.answers).map(([domain, answer]) => [
                domain,
                answer.probability,
              ]),
            ),
            model: result.model,
            latencyMs: result.latencyMs,
            inputTokens: result.inputTokens,
            costMicroUsd: result.costMicroUsd,
          };
          break;
        } catch (error) {
          if (attempt === 3) {
            failures += 1;
            console.error(`Jev failed for ${entry.id}: ${error.message}`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  saveCache(cache);
  if (failures > 0) throw new Error(`${failures} Jev requests failed`);
  return new Map(cases.map((entry) => [entry.id, cache[cacheKey(jevState(entry), questions)]]));
}

function jevRouter(answer, entry, threshold) {
  const chosen = new Set(contextRequired(entry.context));
  for (const [domain, probability] of Object.entries(answer.probabilities)) {
    if (probability >= threshold) chosen.add(domain);
  }
  return OPTIONAL_DOMAINS.filter((domain) => chosen.has(domain));
}

// ---------------------------------------------------------------- scoring

/** A case is covered when every domain it needs was offered. */
function score(cases, predictions) {
  const rows = cases.map((entry) => {
    const predicted = new Set(predictions.get(entry.id));
    const allowed = new Set([...entry.expected, ...entry.acceptable]);
    const missing = entry.expected.filter((domain) => !predicted.has(domain));
    const unnecessary = [...predicted].filter((domain) => !allowed.has(domain));
    const offered = [...ALWAYS_OFFERED_DOMAINS, ...predicted];
    return {
      ...entry,
      predicted: [...predicted],
      missing,
      unnecessary,
      covered: missing.length === 0,
      exact: missing.length === 0 && unnecessary.length === 0,
      schemaChars: toolSchemaChars(toolsInDomains(EXOCORTEX_TOOLS, offered)),
    };
  });
  return rows;
}

function summarise(rows) {
  const needed = rows.reduce((sum, row) => sum + row.expected.length, 0);
  const found = rows.reduce((sum, row) => sum + row.expected.length - row.missing.length, 0);
  const offeredOptional = rows.reduce((sum, row) => sum + row.predicted.length, 0);
  const correctOffers = rows.reduce(
    (sum, row) => sum + row.predicted.length - row.unnecessary.length,
    0,
  );
  return {
    cases: rows.length,
    covered: rows.filter((row) => row.covered).length,
    coverage: ratio(rows.filter((row) => row.covered).length, rows.length),
    exact: ratio(rows.filter((row) => row.exact).length, rows.length),
    microRecall: ratio(found, needed),
    precision: ratio(correctOffers, offeredOptional),
    unnecessaryPerCase: ratio(
      rows.reduce((sum, row) => sum + row.unnecessary.length, 0),
      rows.length,
    ),
    schemaCharsMean: Math.round(rows.reduce((sum, row) => sum + row.schemaChars, 0) / rows.length),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(3));
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    for (const name of Array.isArray(value) ? value : [value]) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
  }
  return groups;
}

/** Recall per needed domain: of the cases that need it, how many were offered it. */
function perDomain(rows) {
  const result = {};
  for (const domain of OPTIONAL_DOMAINS) {
    const needing = rows.filter((row) => row.expected.includes(domain));
    const offeredWrongly = rows.filter((row) => row.unnecessary.includes(domain)).length;
    if (needing.length === 0 && offeredWrongly === 0) continue;
    result[domain] = {
      needed: needing.length,
      recall: ratio(needing.filter((row) => !row.missing.includes(domain)).length, needing.length),
      falsePositives: offeredWrongly,
    };
  }
  return result;
}

function report(rows, extra = {}) {
  const byLanguage = Object.fromEntries(
    [...groupBy(rows, (row) => row.language)].map(([language, part]) => [
      language,
      summarise(part),
    ]),
  );
  const byKind = Object.fromEntries(
    [...groupBy(rows, (row) => row.kind)].map(([kind, part]) => [kind, summarise(part)]),
  );
  return {
    overall: summarise(rows),
    byLanguage,
    byKind,
    byDomain: perDomain(rows),
    misses: rows
      .filter((row) => !row.covered)
      .map((row) => ({
        id: row.id,
        text: row.text,
        missing: row.missing,
        predicted: row.predicted,
      })),
    ...extra,
  };
}

function printReport(name, result) {
  const pct = (value) => (value === null ? '  -  ' : `${(value * 100).toFixed(1).padStart(5)}%`);
  const o = result.overall;
  console.log(`\n${name}: ${o.cases} cases`);
  console.log(
    `  coverage ${pct(o.coverage)}  exact ${pct(o.exact)}  recall ${pct(o.microRecall)}  precision ${pct(o.precision)}  unnecessary/case ${o.unnecessaryPerCase}  schema chars ${o.schemaCharsMean}`,
  );
  console.log('  by language    coverage  recall  precision  unnecessary');
  for (const [language, s] of Object.entries(result.byLanguage)) {
    console.log(
      `    ${language.padEnd(8)}     ${pct(s.coverage)}  ${pct(s.microRecall)}  ${pct(s.precision)}    ${s.unnecessaryPerCase}`,
    );
  }
  console.log('  by kind        coverage  unnecessary');
  for (const [kind, s] of Object.entries(result.byKind)) {
    console.log(`    ${kind.padEnd(12)} ${pct(s.coverage)}    ${s.unnecessaryPerCase}`);
  }
  console.log('  by domain      needed  recall  false positives');
  for (const [domain, s] of Object.entries(result.byDomain)) {
    console.log(
      `    ${domain.padEnd(14)} ${String(s.needed).padStart(4)}  ${pct(s.recall)}  ${s.falsePositives}`,
    );
  }
  if (result.jev) {
    const j = result.jev;
    console.log(
      `  jev: ${j.model}, latency p50 ${j.latencyP50} ms / p95 ${j.latencyP95} ms, ${j.inputTokensMean} input tokens, ${j.costUsdTotal.toFixed(5)} USD in total`,
    );
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const cases = loadCases(args.split);

  let predictionsFor;
  let extra = {};
  if (args.router === 'keyword' || args.router === 'context') {
    const router = args.router === 'keyword' ? keywordRouter : contextRouter;
    predictionsFor = () => new Map(cases.map((entry) => [entry.id, router(entry)]));
  } else if (args.router === 'jev' || args.router === 'jev+context') {
    const answers = await jevAnswers(cases, args);
    const values = [...answers.values()];
    extra = {
      jev: {
        model: [...new Set(values.map((value) => value.model))].join(', '),
        latencyP50: percentile(
          values.map((value) => value.latencyMs),
          50,
        ),
        latencyP95: percentile(
          values.map((value) => value.latencyMs),
          95,
        ),
        inputTokensMean: Math.round(
          values.reduce((sum, value) => sum + value.inputTokens, 0) / values.length,
        ),
        costUsdTotal: values.reduce((sum, value) => sum + (value.costMicroUsd ?? 0), 0) / 1_000_000,
      },
    };
    predictionsFor = (threshold) =>
      new Map(
        cases.map((entry) => {
          const domains = jevRouter(answers.get(entry.id), entry, threshold);
          return [
            entry.id,
            args.router === 'jev' ? domains : [...new Set([...domains, ...contextRouter(entry)])],
          ];
        }),
      );
    extra.calibration = calibration(cases, answers);
  } else if (args.router === 'scores') {
    // Similarity or probability per case and domain from a router run
    // elsewhere (`evals/tool-routing/local/`), scored exactly like Jev's.
    if (!args.scores) throw new Error('--router scores needs --scores <file>');
    const file = JSON.parse(readFileSync(args.scores, 'utf8'));
    const variant = file.variants[args.variant ?? Object.keys(file.variants)[0]];
    if (variant === undefined) throw new Error(`No variant ${args.variant} in ${args.scores}`);
    extra = {
      scores: { model: file.model, variant: args.variant ?? Object.keys(file.variants)[0] },
    };
    predictionsFor = (threshold) =>
      new Map(
        cases.map((entry) => {
          const probabilities = variant[entry.id];
          if (probabilities === undefined) throw new Error(`${args.scores} has no ${entry.id}`);
          return [entry.id, jevRouter({ probabilities }, entry, threshold)];
        }),
      );
  } else {
    throw new Error(`Unknown router ${args.router}`);
  }

  if (args.sweep) {
    const [from, to, step] = (args.grid ?? '0.2:0.8:0.1').split(':').map(Number);
    console.log('threshold  coverage  recall  precision  unnecessary/case  schema chars');
    for (let threshold = from; threshold <= to + 1e-9; threshold += step) {
      const s = summarise(score(cases, predictionsFor(threshold)));
      console.log(
        `  ${threshold.toFixed(2)}      ${s.coverage}     ${s.microRecall}   ${s.precision}      ${s.unnecessaryPerCase}            ${s.schemaCharsMean}`,
      );
    }
    return;
  }
  extra.threshold = args.threshold;

  const result = report(score(cases, predictionsFor(args.threshold)), {
    router: args.router,
    split: args.split,
    ...extra,
  });
  printReport(`${args.router} on ${args.split}`, result);
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
}

/**
 * How well Jev's yes-probability matches how often the domain is really
 * needed, in five bins over every (case, domain) pair. A well-calibrated
 * engine says 0.8 for domains that are needed about 80 % of the time.
 * `acceptable` domains are left out: neither answer is wrong for them.
 */
function calibration(cases, answers) {
  const bins = Array.from({ length: 5 }, () => ({ count: 0, needed: 0, sum: 0 }));
  let brier = 0;
  let pairs = 0;
  for (const entry of cases) {
    const { probabilities } = answers.get(entry.id);
    for (const [domain, probability] of Object.entries(probabilities)) {
      if (entry.acceptable.includes(domain)) continue;
      const needed = entry.expected.includes(domain) ? 1 : 0;
      const bin = bins[Math.min(4, Math.floor(probability * 5))];
      bin.count += 1;
      bin.needed += needed;
      bin.sum += probability;
      brier += (probability - needed) ** 2;
      pairs += 1;
    }
  }
  return {
    brier: Number((brier / pairs).toFixed(4)),
    bins: bins.map((bin, index) => ({
      range: `${(index / 5).toFixed(1)}-${((index + 1) / 5).toFixed(1)}`,
      pairs: bin.count,
      meanProbability: bin.count === 0 ? null : Number((bin.sum / bin.count).toFixed(3)),
      neededRate: bin.count === 0 ? null : Number((bin.needed / bin.count).toFixed(3)),
    })),
  };
}

await main();
