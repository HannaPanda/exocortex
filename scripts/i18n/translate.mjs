#!/usr/bin/env node
/**
 * Translates the German message catalogue into the other locales (issue #98).
 *
 *   pnpm i18n:translate --locale fr         one locale
 *   pnpm i18n:translate --all               every supported locale
 *   pnpm i18n:translate --all --dry-run     say what would happen, call nothing
 *   --key settings.language.title           only this key (repeatable)
 *   --accept pl:settings.language.title     a hand-written translation is right
 *                                           for today's German text
 *   --overwrite-manual <key>|all            redo hand-written translations too
 *
 * The model is the translator, never the source: German is written by a
 * person, and the tool only ever fills in what is missing or what it wrote
 * itself for an older German text. A translation somebody corrected by hand is
 * reported instead of overwritten (`translation-state.json` remembers the
 * hash of what the tool wrote; a file that differs from it was edited).
 *
 * Every answer is checked before it is written: same keys, the same ICU
 * arguments, tags and select options as the German source, every plural
 * category the target language needs, and the brand spelling intact. A key
 * that fails twice is left out and the run ends red, so a broken string never
 * reaches the catalogue.
 *
 * Provider: any OpenAI-compatible chat completions endpoint. OpenRouter by
 * default, because its key is already in `.env`; `I18N_TRANSLATE_BASE_URL`,
 * `I18N_TRANSLATE_API_KEY` and `I18N_TRANSLATE_MODEL` point it elsewhere.
 * A developer tool: it runs by hand in the commit that changes German text,
 * never in `build.sh`, and needs no running deployment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  contextDir,
  flatten,
  formatJson,
  formatState,
  generatedCatalogPath,
  generatedCatalogSource,
  glossaryPath,
  hashText,
  keyStatus,
  messagesDir,
  namespacePath,
  namespacesOf,
  readNamespace,
  readState,
  repoRoot,
  SOURCE_LOCALE,
  statePath,
  supportedLocales,
  unflatten,
} from '../lib/i18n-catalog.mjs';
import { compareIcu } from '../lib/icu.mjs';

/**
 * Pinned, and chosen against a sample (issue #98): a model change changes
 * every future diff, so it is a decision with a commit, not a default that
 * drifts with the provider's catalogue.
 */
const DEFAULT_MODEL = 'google/gemini-3.8-flash';
/**
 * Minimal thinking: on a sample of 120 translations it cost a third, ran three
 * times as fast and read as well as the default effort, which spent 73 % of
 * its output on reasoning (docs/i18n.md, "The model").
 */
const REASONING = { effort: 'minimal' };
const BATCH_SIZE = 40;

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish (Spain)',
  fr: 'French (France)',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  'pt-BR': 'Brazilian Portuguese',
};

const { values: options } = parseArgs({
  options: {
    locale: { type: 'string', multiple: true, default: [] },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    key: { type: 'string', multiple: true, default: [] },
    accept: { type: 'string', multiple: true, default: [] },
    'overwrite-manual': { type: 'string', multiple: true, default: [] },
    model: { type: 'string' },
  },
});

const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const locales = supportedLocales();
const targets = options.all ? locales.filter((locale) => locale !== SOURCE_LOCALE) : options.locale;
for (const locale of targets) {
  if (!locales.includes(locale) || locale === SOURCE_LOCALE) {
    console.error(`Not a target locale: ${locale}. Supported: ${locales.slice(1).join(', ')}`);
    process.exit(2);
  }
}
if (targets.length === 0 && options.accept.length === 0) {
  console.error('Name a locale with --locale <id>, or pass --all.');
  process.exit(2);
}

const glossary = existsSync(glossaryPath) ? JSON.parse(readFileSync(glossaryPath, 'utf8')) : {};
const state = readState();
const namespaces = namespacesOf(SOURCE_LOCALE);
const source = new Map(namespaces.map((ns) => [ns, flatten(readNamespace(SOURCE_LOCALE, ns))]));

function sourceText(fullKey) {
  const dot = fullKey.indexOf('.');
  return source.get(fullKey.slice(0, dot))?.get(fullKey.slice(dot + 1));
}

// --- --accept: a person vouches for a translation -------------------------
for (const accepted of options.accept) {
  const [locale, fullKey] = accepted.split(':');
  const german = fullKey === undefined ? undefined : sourceText(fullKey);
  if (german === undefined || !locales.includes(locale)) {
    console.error(`--accept expects <locale>:<namespace.key>, got ${accepted}`);
    process.exit(2);
  }
  state[locale] ??= {};
  state[locale][fullKey] = { source: hashText(german) };
  console.log(`Accepted ${locale}:${fullKey} as a hand-written translation.`);
}

// --- plan -------------------------------------------------------------------
function wanted(fullKey) {
  return options.key.length === 0 || options.key.includes(fullKey);
}

function mayOverwriteManual(fullKey) {
  return (
    options['overwrite-manual'].includes('all') || options['overwrite-manual'].includes(fullKey)
  );
}

const plan = [];
const reviews = [];
for (const locale of targets) {
  state[locale] ??= {};
  for (const ns of namespaces) {
    const target = flatten(readNamespace(locale, ns) ?? {});
    for (const [path, german] of source.get(ns)) {
      const fullKey = `${ns}.${path}`;
      if (!wanted(fullKey)) continue;
      const current = target.get(path);
      const status = keyStatus(german, current, state[locale][fullKey]);
      if (status === 'current') continue;
      if (status === 'review' && !mayOverwriteManual(fullKey)) {
        reviews.push(`${locale}:${fullKey}`);
        continue;
      }
      plan.push({ locale, ns, path, fullKey, german, previous: current, status });
    }
  }
}

console.log(`${plan.length} translation(s) to make, ${reviews.length} hand-written to review.`);
for (const item of plan) console.log(`  ${item.status.padEnd(7)} ${item.locale}:${item.fullKey}`);

if (options['dry-run']) {
  reportReviews();
  process.exit(0);
}

// --- translate --------------------------------------------------------------
const baseUrl = process.env.I18N_TRANSLATE_BASE_URL ?? 'https://openrouter.ai/api/v1';
const apiKey = process.env.I18N_TRANSLATE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const model = options.model ?? process.env.I18N_TRANSLATE_MODEL ?? DEFAULT_MODEL;

if (plan.length > 0 && (apiKey === undefined || apiKey === '')) {
  console.error('No API key: set I18N_TRANSLATE_API_KEY or OPENROUTER_API_KEY in .env.');
  process.exit(2);
}

function glossaryFor(locale, texts) {
  const joined = texts.join('\n').toLowerCase();
  const terms = {};
  for (const [german, translations] of Object.entries(glossary.terms ?? {})) {
    if (joined.includes(german.toLowerCase()) && translations[locale] !== undefined) {
      terms[german] = translations[locale];
    }
  }
  return terms;
}

function contextFor(ns) {
  const path = join(contextDir, `${ns}.md`);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

function systemPrompt(locale) {
  const plural = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  return [
    `You translate the user interface of eXocortex, a collaborative note-taking workspace, from German into ${LANGUAGE_NAMES[locale]} (${locale}).`,
    'You receive a JSON object of message keys to German ICU MessageFormat strings. Answer with one JSON object mapping each key to its translation, and nothing else.',
    'Rules:',
    '- Keep every ICU placeholder, argument name, argument type, select key and rich-text tag exactly as in the source: {name}, {count, plural, ...}, <link>...</link>. Translate only the human text inside them.',
    `- Plural messages must list exactly these categories for ${locale}: ${plural.join(', ')}. Keep explicit =0 or =1 cases where the source has them.`,
    "- Write apostrophes as the typographic apostrophe \u2019 (l\u2019état, dell\u2019area), never as ' or '': in ICU a straight apostrophe can start a quoted section.",
    '- The gender of the reader and of anybody named by a placeholder is unknown. Prefer phrasings that need no gendered form (in Polish "Masz nowy komentarz", not "Otrzymałeś").',
    `- Never translate or respell these names: ${(glossary.doNotTranslate ?? ['eXocortex']).join(', ')}. The brand is always written eXocortex, with a lowercase e and an uppercase X.`,
    `- Tone: ${glossary.register?.[locale] ?? 'friendly and clear, informal address'}. The German addresses the reader informally (du); do the same where the language distinguishes.`,
    '- Match the length and register of the German: button labels stay short, explanations stay explanations. Do not add or drop information.',
    '- Use the glossary terms given with the request for those German words.',
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried on what is the provider's problem rather than the
 * answer's: a rate limit, a 5xx, a body that is cut off. Three tries with a
 * growing pause; a faithful-translation failure is handled a level up.
 */
async function callModel(locale, ns, batch, feedback) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(2000 * 2 ** attempt);
    try {
      return await requestModel(locale, ns, batch, feedback);
    } catch (error) {
      lastError = error;
      if (error.permanent === true) break;
    }
  }
  throw lastError;
}

async function requestModel(locale, ns, batch, feedback) {
  const payload = {
    namespace: ns,
    context: contextFor(ns),
    glossary: glossaryFor(
      locale,
      batch.map((item) => item.german),
    ),
    messages: Object.fromEntries(batch.map((item) => [item.fullKey, item.german])),
  };
  if (feedback !== undefined) payload.problemsWithYourLastAnswer = feedback;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-title': 'eXocortex i18n:translate',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      seed: 0,
      response_format: { type: 'json_object' },
      reasoning: REASONING,
      messages: [
        { role: 'system', content: systemPrompt(locale) },
        { role: 'user', content: JSON.stringify(payload, null, 2) },
      ],
    }),
  });
  if (!response.ok) {
    const error = new Error(
      `${response.status} from ${baseUrl}: ${(await response.text()).slice(0, 300)}`,
    );
    error.permanent = response.status !== 429 && response.status < 500;
    throw error;
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content ?? '';
  const json = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(json);
}

const BRAND = `eX${'ocortex'}`;

function problemsOf(item, translation, locale) {
  if (typeof translation !== 'string' || translation.trim() === '') return ['no translation given'];
  const problems = compareIcu(item.german, translation, locale);
  if (item.german.includes(BRAND) && !translation.includes(BRAND)) {
    problems.push(`the brand must stay written exactly ${BRAND}`);
  }
  return problems;
}

async function translateBatch(locale, ns, batch) {
  const results = new Map();
  let pending = batch;
  let feedback;
  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt += 1) {
    let answer;
    try {
      answer = await callModel(locale, ns, pending, feedback);
    } catch (error) {
      console.error(`  ${locale}/${ns}: request failed (${error.message})`);
      answer = {};
    }
    const failed = [];
    feedback = {};
    for (const item of pending) {
      const translation = answer[item.fullKey];
      const problems = problemsOf(item, translation, locale);
      if (problems.length === 0) {
        results.set(item, translation);
      } else {
        failed.push(item);
        feedback[item.fullKey] = problems;
      }
    }
    pending = failed;
  }
  return { results, failed: pending };
}

const failures = [];
const byTarget = new Map();
for (const item of plan) {
  const key = `${item.locale}\u0000${item.ns}`;
  if (!byTarget.has(key)) byTarget.set(key, []);
  byTarget.get(key).push(item);
}

for (const [key, items] of byTarget) {
  const [locale, ns] = key.split('\u0000');
  const translated = new Map();
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    const { results, failed } = await translateBatch(locale, ns, batch);
    for (const [item, text] of results) translated.set(item.path, text);
    for (const item of failed) failures.push(`${locale}:${item.fullKey}`);
    process.stdout.write(
      `  ${locale}/${ns}: ${Math.min(start + BATCH_SIZE, items.length)}/${items.length}\n`,
    );
  }
  for (const item of items) {
    const text = translated.get(item.path);
    if (text !== undefined) {
      state[locale][item.fullKey] = { source: hashText(item.german), output: hashText(text) };
    }
  }
  writeNamespace(locale, ns, translated);
  // After every namespace, not once at the end: a run stopped halfway would
  // otherwise leave translations on disk with no state behind them, and the
  // next run would take them for hand-written ones and never touch them.
  writeFileSync(statePath, formatState(state), 'utf8');
}

// Namespaces nobody needed to translate still get written, which is what
// drops keys the German no longer has.
for (const locale of targets) {
  for (const ns of namespaces) {
    if (!byTarget.has(`${locale}\u0000${ns}`)) writeNamespace(locale, ns, new Map());
  }
}

/**
 * Writes one target namespace in the German key order: new translations
 * where they were made, the existing text everywhere else, and nothing for
 * a key the German dropped.
 */
function writeNamespace(locale, ns, translated) {
  const existing = flatten(readNamespace(locale, ns) ?? {});
  const entries = [];
  for (const path of source.get(ns).keys()) {
    const text = translated.get(path) ?? existing.get(path);
    if (text !== undefined) entries.push([path, text]);
  }
  for (const path of existing.keys()) {
    if (!source.get(ns).has(path)) delete state[locale]?.[`${ns}.${path}`];
  }
  mkdirSync(join(messagesDir, locale), { recursive: true });
  writeFileSync(namespacePath(locale, ns), formatJson(unflatten(entries)), 'utf8');
}

writeFileSync(statePath, formatState(state), 'utf8');
writeFileSync(generatedCatalogPath, generatedCatalogSource(locales, namespaces), 'utf8');

reportReviews();
if (failures.length > 0) {
  console.error(
    `\n${failures.length} key(s) could not be translated faithfully and were left out:`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nDone. Run `node scripts/check-i18n.mjs` to see the catalogue the gate sees.');

function reportReviews() {
  if (reviews.length === 0) return;
  console.log('\nHand-written translations whose German text changed since:');
  for (const review of reviews) console.log(`  ${review}`);
  console.log(
    'Correct the file and confirm with --accept <locale>:<key>, or let the tool redo it with --overwrite-manual <key>.',
  );
}
