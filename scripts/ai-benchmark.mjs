/**
 * Measures the built-in AI against the same three tasks twice over
 * (issue #122).
 *
 *   node scripts/ai-benchmark.mjs --plan
 *   node scripts/ai-benchmark.mjs --run --repeats 3 --out /tmp/bench.json
 *   node scripts/ai-benchmark.mjs --report /tmp/bench.json
 *
 * The first comparison of two models was useful as a diagnosis and was not a
 * benchmark: one model ran at the provider's default reasoning effort and the
 * other at HIGH, the concurrency contract of the narrow writes was broken
 * (#120), and every turn carried 144,285 characters of tool schema (#121). It
 * also reset nothing between runs, so each fixture was used once and then
 * rebuilt by hand -- which is exactly the part that is not reproducible.
 *
 * So this script owns the whole loop. Per measured run it creates a fresh page
 * from `BENCHMARK_FIXTURES`, opens a *new* conversation (no earlier messages,
 * no earlier tool results), sends the prompt verbatim at an explicit reasoning
 * level, waits, and then reads the pages back and evaluates the checkpoints.
 * The model order alternates between repetitions, so neither side is always
 * the one that warms the cache.
 *
 * It writes: a page per run under the test bed, a conversation per run, and an
 * `ai_run` row per run. It deletes nothing, and in particular it never touches
 * the earlier `ai_run` rows -- those are the baseline the new numbers are
 * compared against.
 *
 * It costs real money at a real provider. Nothing here runs without `--run`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPrismaClient } from '../packages/database/dist/index.js';

import { BENCHMARK_FIXTURES } from './lib/ai-benchmark-fixtures.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';

/** Loopback, past nginx and its basic auth. */
const API = 'http://127.0.0.1:3211';

/** „Mein Arbeitsbereich", Johanna's test area. Never the Second Brain. */
const WORKSPACE = 'm19i6551nw1eafb88aoisg6x';

/** The test bed the fixtures are created under. */
const TEST_BED = 'r7ffd00lcms1383j5sx26sf8';

const MODELS = [
  { key: 'Luna', slug: 'openai/gpt-5.6-luna-pro' },
  { key: 'GLM', slug: '~z-ai/glm-latest' },
  { key: 'DeepSeek', slug: 'deepseek/deepseek-v4.1-flash' },
];

/** Every model, explicitly. The first comparison differed here and nowhere else it meant to. */
const REASONING_LEVEL = 'high';

const POLL_INTERVAL_MS = 2_000;
const RUN_TIMEOUT_MS = 480_000;

const token = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers.exocortex
  .env.EXOCORTEX_API_TOKEN;

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return text.length === 0 ? null : JSON.parse(text);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page with content, created through the ordinary routes like any other. */
async function createPage({ title, parentId, markdown }) {
  const created = await api('POST', `/api/workspaces/${WORKSPACE}/documents`, {
    title,
    parentId,
    type: 'PAGE',
  });
  await api('POST', `/api/documents/${created.id}/content`, { markdown, mode: 'replace' });
  return created.id;
}

/** The page as it stands now, read the way an agent would read it. */
async function readPage(documentId) {
  const exported = await api('GET', `/api/documents/${documentId}/export/markdown`);
  return { id: documentId, title: exported.filename, markdown: exported.markdown };
}

/** Starts one run in a conversation of its own and waits for it to end. */
async function measureRun({ model, fixture, parentId, index }) {
  // The fixture is rendered per model, exactly as the first measurement had
  // it: the header names the model, and both sides otherwise get byte-for-byte
  // the same page.
  const fixtureMarkdown = fixture.markdown(model.key);
  const documentId = await createPage({
    title: `${fixture.title} (${model.key}, Lauf ${index})`,
    parentId,
    markdown: fixtureMarkdown,
  });

  const { conversation } = await api('POST', '/api/ai/conversations', {
    workspaceId: WORKSPACE,
    documentId,
    title: `${fixture.key} ${model.key} #${index}`,
    modelSlug: model.slug,
    reasoningLevel: REASONING_LEVEL,
  });

  const startedAt = Date.now();
  const posted = await api('POST', `/api/ai/conversations/${conversation.id}/messages`, {
    content: fixture.prompt,
    documentId,
    reasoningLevel: REASONING_LEVEL,
  });

  const run = await waitForRun(posted.run.id);
  return {
    test: fixture.key,
    model: model.key,
    modelSlug: model.slug,
    reasoningLevel: REASONING_LEVEL,
    repetition: index,
    runId: run.id,
    conversationId: conversation.id,
    documentId,
    fixtureMarkdown,
    status: run.status,
    errorCode: run.errorCode,
    errorDetail: run.errorDetail,
    wallClockMs: Date.now() - startedAt,
  };
}

async function waitForRun(runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // The run endpoint answers with the run itself, not with `{ run }`.
    const run = await api('GET', `/api/ai/runs/${runId}`);
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status)) return run;
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(`Run ${runId} did not finish within ${RUN_TIMEOUT_MS} ms`);
}

/**
 * Everything the database knows about a finished run.
 *
 * Read from Prisma rather than from the run endpoint because the tool sequence
 * lives on the conversation's messages, and because a benchmark that reports
 * cache and cost should read the columns those are stored in rather than a
 * rendering of them.
 */
async function collectMetrics(prisma, record) {
  const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: record.runId } });
  const messages = await prisma.aiConversationMessage.findMany({
    where: { conversationId: record.conversationId },
    orderBy: { createdAt: 'asc' },
  });

  const toolNames = messages
    .filter((message) => message.role === 'ASSISTANT' && message.toolCalls !== null)
    .flatMap((message) => message.toolCalls)
    .map((call) => call?.function?.name)
    .filter((name) => typeof name === 'string');
  const toolResults = messages
    .filter((message) => message.role === 'TOOL')
    .map((message) => message.content.length);
  const toolResultChars = toolResults.reduce((total, length) => total + length, 0);
  const answer =
    messages.filter((message) => message.role === 'ASSISTANT').at(-1)?.content ??
    row.resultText ??
    '';

  return {
    ...record,
    toolIterations: row.toolIterations,
    toolCalls: row.toolCalls,
    toolsOffered: row.toolsOffered,
    toolSchemaChars: row.toolSchemaChars,
    toolDomains: row.toolDomains,
    toolSequence: toolNames,
    toolResultChars,
    maxToolResultChars: Math.max(0, ...toolResults),
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.usage?.reasoningTokens ?? null,
    providerCostMicroUsd: row.providerCostMicroUsd,
    estimatedCostMicroUsd: row.estimatedCostMicroUsd,
    durationMs: row.durationMs,
    resolvedModel: row.usage?.model ?? null,
    resolvedProvider: row.usage?.provider ?? null,
    answer,
  };
}

/** Runs the fixture's checkpoints against the pages as they now stand. */
async function evaluate(prisma, fixture, metrics) {
  const source = await readPage(metrics.documentId);
  const childRows = await prisma.document.findMany({
    where: { parentId: metrics.documentId, archivedAt: null },
    select: { id: true, title: true },
  });
  const children = [];
  for (const child of childRows) {
    children.push({ ...(await readPage(child.id)), title: child.title });
  }
  const checkpoints = fixture.check({
    source,
    children,
    fixtureMarkdown: metrics.fixtureMarkdown,
    answer: metrics.answer,
    toolNames: metrics.toolSequence,
    toolResultChars: metrics.toolResultChars,
    maxToolResultChars: metrics.maxToolResultChars,
  });
  return {
    ...metrics,
    checkpoints,
    passed: checkpoints.every((checkpoint) => checkpoint.passed),
  };
}

/**
 * The order the models run in, rotated by one every repetition.
 *
 * A swap only balances two. With three, rotating means each model leads once
 * over three repetitions, so none is systematically the one that warms the
 * cache or the one that runs into a busy minute.
 */
function modelOrder(repetition) {
  const offset = (repetition - 1) % MODELS.length;
  return [...MODELS.slice(offset), ...MODELS.slice(0, offset)];
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarize(results) {
  const rows = [];
  for (const fixture of BENCHMARK_FIXTURES) {
    for (const model of MODELS) {
      const group = results.filter(
        (result) => result.test === fixture.key && result.model === model.key,
      );
      if (group.length === 0) continue;
      const cost = group.map(
        (result) => result.providerCostMicroUsd ?? result.estimatedCostMicroUsd ?? 0,
      );
      rows.push({
        test: fixture.key,
        model: model.key,
        runs: group.length,
        passed: group.filter((result) => result.passed).length,
        medianIterations: median(group.map((result) => result.toolIterations)),
        medianCalls: median(group.map((result) => result.toolCalls)),
        medianInput: median(group.map((result) => result.inputTokens)),
        medianCached: median(group.map((result) => result.cachedInputTokens)),
        medianOutput: median(group.map((result) => result.outputTokens)),
        medianDurationMs: median(group.map((result) => result.durationMs ?? result.wallClockMs)),
        medianCostMicroUsd: median(cost),
        minCostMicroUsd: Math.min(...cost),
        maxCostMicroUsd: Math.max(...cost),
        toolsOffered: group[0].toolsOffered,
        toolSchemaChars: group[0].toolSchemaChars,
      });
    }
  }
  return rows;
}

function printReport(results) {
  step('Ergebnisse je Lauf');
  for (const result of results) {
    const failed = result.checkpoints.filter((checkpoint) => !checkpoint.passed);
    info(
      `${result.test} ${result.model} #${result.repetition}  ${result.runId}  ` +
        `${result.status}  ${failed.length === 0 ? 'alle Prüfpunkte' : `offen: ${failed.map((c) => c.id).join(', ')}`}`,
    );
    info(
      `   Runden ${result.toolIterations}, Aufrufe ${result.toolCalls}, ` +
        `Werkzeuge ${result.toolsOffered} (${result.toolSchemaChars} Zeichen), ` +
        `rein ${result.inputTokens} (Cache ${result.cachedInputTokens}), raus ${result.outputTokens}, ` +
        `${result.durationMs ?? result.wallClockMs} ms, ` +
        `${((result.providerCostMicroUsd ?? result.estimatedCostMicroUsd ?? 0) / 10_000).toFixed(2)} ct`,
    );
    info(`   ${result.toolSequence.join(' → ') || '(keine Werkzeugaufrufe)'}`);
  }

  step('Mediane je Test und Modell');
  for (const row of summarize(results)) {
    info(
      `${row.test} ${row.model}: ${row.passed}/${row.runs} bestanden, Runden ${row.medianIterations}, ` +
        `Aufrufe ${row.medianCalls}, rein ${row.medianInput} (Cache ${row.medianCached}), ` +
        `raus ${row.medianOutput}, ${row.medianDurationMs} ms, ` +
        `${(row.medianCostMicroUsd / 10_000).toFixed(2)} ct ` +
        `(${(row.minCostMicroUsd / 10_000).toFixed(2)} bis ${(row.maxCostMicroUsd / 10_000).toFixed(2)})`,
    );
  }
}

function parseArgs(argv) {
  const args = {
    plan: false,
    run: false,
    repeats: 3,
    out: null,
    report: null,
    recheck: null,
    only: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan') args.plan = true;
    else if (argv[i] === '--run') args.run = true;
    else if (argv[i] === '--repeats') args.repeats = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
    // One test only, for checking the harness itself without paying for six runs.
    else if (argv[i] === '--only') args.only = argv[++i];
    // Evaluate the checkpoints again against the pages the runs left behind.
    else if (argv[i] === '--recheck') args.recheck = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.recheck !== null) {
    // A checkpoint that turns out to be wrong must not cost eighteen runs: the
    // pages are still there, so the evaluation is repeated against them rather
    // than the measurement.
    const prisma = createPrismaClient();
    const stored = JSON.parse(readFileSync(args.recheck, 'utf8'));
    const results = [];
    for (const record of stored.results) {
      const fixture = BENCHMARK_FIXTURES.find((entry) => entry.key === record.test);
      const metrics = await collectMetrics(prisma, record);
      results.push(
        await evaluate(prisma, fixture, {
          ...metrics,
          fixtureMarkdown: fixture.markdown(record.model),
        }),
      );
    }
    await prisma.$disconnect();
    if (args.out !== null) {
      const cleaned = results.map(({ fixtureMarkdown: _unused, ...rest }) => rest);
      writeFileSync(args.out, `${JSON.stringify({ ...stored, results: cleaned }, null, 2)}\n`);
    }
    printReport(results);
    return;
  }

  if (args.report !== null) {
    printReport(JSON.parse(readFileSync(args.report, 'utf8')).results);
    return;
  }

  if (!args.run) {
    step('Was gemessen würde');
    info(`${BENCHMARK_FIXTURES.length} Tests × ${MODELS.length} Modelle × ${args.repeats} Läufe`);
    info(`Denkstufe für alle: ${REASONING_LEVEL}`);
    for (const fixture of BENCHMARK_FIXTURES) {
      info(
        `${fixture.key}: „${fixture.prompt}" (${fixture.markdown('Luna').length} Zeichen Fixture)`,
      );
    }
    ok('Trockenlauf. Mit --run messen; das kostet echtes Geld.');
    return;
  }

  const prisma = createPrismaClient();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const parentId = await createPage({
    title: `Benchmark ${stamp}`,
    parentId: TEST_BED,
    markdown: `Messläufe zu Issue #122, ${stamp}. Jede Unterseite hier ist eine frische Fixture für genau einen Lauf.\n`,
  });
  step(`Fixtures unter ${parentId}`);

  const fixtures =
    args.only === null
      ? BENCHMARK_FIXTURES
      : BENCHMARK_FIXTURES.filter((fixture) => fixture.key === args.only);

  const results = [];
  for (let repetition = 1; repetition <= args.repeats; repetition += 1) {
    for (const fixture of fixtures) {
      for (const model of modelOrder(repetition)) {
        const record = await measureRun({ model, fixture, parentId, index: repetition });
        const metrics = await collectMetrics(prisma, record);
        const evaluated = await evaluate(prisma, fixture, metrics);
        results.push(evaluated);
        info(
          `${evaluated.test} ${evaluated.model} #${repetition}: ${evaluated.status}, ` +
            `${evaluated.passed ? 'alle Prüfpunkte' : 'Prüfpunkte offen'}, ${evaluated.runId}`,
        );
      }
    }
  }

  await prisma.$disconnect();
  if (args.out !== null) {
    const stored = results.map(({ fixtureMarkdown: _unused, ...rest }) => rest);
    writeFileSync(args.out, `${JSON.stringify({ parentId, results: stored }, null, 2)}\n`);
    info(`Rohdaten: ${args.out}`);
  }
  printReport(results);
  ok(`${results.length} Läufe gemessen.`);
}

main().catch((error) => {
  fail('Benchmark abgebrochen', [error instanceof Error ? error.message : String(error)]);
  process.exitCode = 1;
});
