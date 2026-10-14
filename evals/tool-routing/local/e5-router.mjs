/**
 * The local embedding challenger of #206: `intfloat/multilingual-e5-small`
 * (MIT) on the CPU, through transformers.js and ONNX Runtime.
 *
 * Not a dependency of this repository on purpose. Install the library into a
 * directory of its own and point the script at it:
 *
 *   mkdir /tmp/e5 && cd /tmp/e5 && npm init -y \
 *     && npm install --ignore-scripts @huggingface/transformers@4.2.0
 *   node evals/tool-routing/local/e5-router.mjs --lib /tmp/e5
 *
 * It writes `evals/tool-routing/results/e5-small-scores.json`, which
 * `scripts/tool-routing-eval.mjs --router scores` turns into the same numbers
 * as every other router. Two variants:
 *
 * - `descriptions`: cosine similarity between the request and the same
 *   domain description Jev is asked about. No training data at all.
 * - `exemplars`: the highest similarity to any dev sentence of a group that
 *   needs the domain, or the description, whichever is higher. A case is
 *   never compared with its own group, so a dev score is leave-one-group-out
 *   and a holdout score has seen no holdout sentence.
 *
 * - `descriptionsZ`, `exemplarsZ`: the same, standardised over the 24 domains
 *   of one request (z-score). e5's similarities sit in a narrow band whose
 *   height depends on the sentence, so an absolute threshold cannot separate
 *   them; a relative one asks which domains stand out for this request.
 *
 * The context signals are not embedded; the scorer adds them deterministically.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DOMAIN_QUESTIONS,
  loadCases,
  OPTIONAL_DOMAINS,
} from '../../../scripts/lib/tool-routing-gold.mjs';

const MODEL = 'Xenova/multilingual-e5-small';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../results/e5-small-scores.json');

const libIndex = process.argv.indexOf('--lib');
if (libIndex === -1) throw new Error('Pass --lib <directory with @huggingface/transformers>');
const require = createRequire(join(process.argv[libIndex + 1], 'package.json'));
const { pipeline } = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);

const rssBefore = process.memoryUsage().rss;
const loadStarted = Date.now();
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const loadMs = Date.now() - loadStarted;

/** e5 wants its prefixes: `query:` for what is asked, `passage:` for what answers. */
async function vectors(texts, prefix) {
  const result = [];
  for (let start = 0; start < texts.length; start += 32) {
    const batch = texts.slice(start, start + 32).map((text) => `${prefix}: ${text}`);
    const output = await embed(batch, { pooling: 'mean', normalize: true });
    result.push(...output.tolist());
  }
  return result;
}

function cosine(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

const cases = loadCases('all');
const devCases = cases.filter((entry) => loadCases('dev').some((dev) => dev.id === entry.id));

const descriptions = await vectors(
  OPTIONAL_DOMAINS.map((domain) => `Tools to ${DOMAIN_QUESTIONS[domain]}`),
  'passage',
);

// One request at a time is how a router would meet them, so that is what is timed.
const latencies = [];
const caseVectors = [];
for (const entry of cases) {
  const started = performance.now();
  caseVectors.push((await vectors([entry.text], 'query'))[0]);
  latencies.push(performance.now() - started);
}
const vectorById = new Map(cases.map((entry, index) => [entry.id, caseVectors[index]]));

const variants = { descriptions: {}, exemplars: {} };
for (const entry of cases) {
  const vector = vectorById.get(entry.id);
  const byDescription = {};
  const byExemplar = {};
  OPTIONAL_DOMAINS.forEach((domain, index) => {
    const description = cosine(vector, descriptions[index]);
    byDescription[domain] = round(description);
    let best = description;
    for (const example of devCases) {
      if (example.group === entry.group || !example.expected.includes(domain)) continue;
      best = Math.max(best, cosine(vector, vectorById.get(example.id)));
    }
    byExemplar[domain] = round(best);
  });
  variants.descriptions[entry.id] = byDescription;
  variants.exemplars[entry.id] = byExemplar;
}

for (const name of ['descriptions', 'exemplars']) {
  variants[`${name}Z`] = Object.fromEntries(
    Object.entries(variants[name]).map(([id, scores]) => [id, standardised(scores)]),
  );
}

latencies.sort((a, b) => a - b);
const pick = (p) => Math.round(latencies[Math.floor(p * (latencies.length - 1))]);
const measurement = {
  model: `${MODEL} (q8 ONNX, transformers.js 4.2.0, CPU)`,
  loadMs,
  latencyMs: { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) },
  rssGrowthMb: Math.round((process.memoryUsage().rss - rssBefore) / 1_048_576),
  measuredAt: new Date().toISOString().slice(0, 10),
};
process.stdout.write(`${JSON.stringify(measurement)}\n`);
writeFileSync(OUT, `${JSON.stringify({ ...measurement, variants })}\n`);

function standardised(scores) {
  const values = Object.values(scores);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
  return Object.fromEntries(
    Object.entries(scores).map(([domain, value]) => [domain, round((value - mean) / spread)]),
  );
}

function round(value) {
  return Number(value.toFixed(4));
}
