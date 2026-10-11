#!/usr/bin/env node
// Firefox WebSocket regression harness (issue #166). Started by run.sh, which
// owns the containers, the migrations and the test account; this script owns
// the processes, the browser, the fault schedule and the report.
//
//   node harness.mjs --label baseline --web baseline --cycles 30 [--tabs 1]
//                    [--no-exo] [--max-ws N] [--headful] [--scenarios a,b]
//
// See README.md for what every scenario does and how to read the results.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CONTROL_ORIGIN, HARNESS_DIR, ORIGIN, ROOT_DIR } from './lib/config.mjs';
import { createControlOrigin } from './lib/control-origin.mjs';
import { launchFirefox } from './lib/firefox.mjs';
import { createProxy } from './lib/proxy.mjs';
import { createScenarios } from './lib/scenarios.mjs';
import { createServices } from './lib/services.mjs';

const Y = createRequire(path.join(ROOT_DIR, 'apps/collaboration/package.json'))('yjs');

const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    web: { type: 'string', default: 'baseline' },
    cycles: { type: 'string', default: '30' },
    tabs: { type: 'string', default: '1' },
    'no-exo': { type: 'boolean', default: false },
    'max-ws': { type: 'string' },
    headful: { type: 'boolean', default: false },
    scenarios: { type: 'string' },
    password: { type: 'string', default: process.env.HARNESS_PASSWORD },
    email: { type: 'string', default: process.env.HARNESS_EMAIL },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.label}`;
const OUT = path.join(HARNESS_DIR, 'results', runId);
fs.mkdirSync(OUT, { recursive: true });
const metricsFile = fs.createWriteStream(path.join(OUT, 'metrics.jsonl'));
const eventsFile = fs.createWriteStream(path.join(OUT, 'events.jsonl'));
const log = (message, extra = {}) => {
  const line = { t: now(), message, ...extra };
  eventsFile.write(`${JSON.stringify(line)}\n`);
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] ${message}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`,
  );
};

const withExo = !args['no-exo'];
const tabCount = Math.max(1, Number(args.tabs));

// --- the stack ------------------------------------------------------------

const proxy = createProxy();
const control = createControlOrigin();
const services = createServices({ logDir: path.join(OUT, 'services'), webLabel: args.web });

/** A tiny async mutex: classic WebDriver commands must not interleave window switches. */
let chain = Promise.resolve();
const locked = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const init = {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${ORIGIN}${pathname}`, init);
}

async function signIn() {
  const res = await api('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: args.email, password: args.password },
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { cookie: cookies.join('; '), cookies };
}

async function createDocument(cookie) {
  const workspaces = await (await api('/api/workspaces', { cookie })).json();
  const list = Array.isArray(workspaces)
    ? workspaces
    : (workspaces.workspaces ?? workspaces.items ?? []);
  const workspace = list.find((w) => !w.isMemory) ?? list[0];
  if (!workspace) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`);
  const res = await api(`/api/workspaces/${workspace.id}/import/markdown`, {
    method: 'POST',
    cookie,
    body: { markdown: '# Harness\n\nStart.\n', title: `Harness ${runId}` },
  });
  if (!res.ok) throw new Error(`document create failed: ${res.status} ${await res.text()}`);
  const { document } = await res.json();
  return { workspaceId: workspace.id, documentId: document.id };
}

/** The canonical state: the binary Yjs update in Postgres, decoded here. */
function canonicalText(documentId) {
  const out = execFileSync('docker', [
    'exec',
    'exocortex-ffharness-postgres',
    'psql',
    '-U',
    'ffharness',
    '-d',
    'ffharness',
    '-At',
    '-c',
    `select encode("yjsState", 'base64') from document_content where "documentId" = '${documentId.replace(/[^a-z0-9]/g, '')}'`,
  ])
    .toString()
    .replace(/\s+/g, '');
  if (!out) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(out, 'base64'));
  return doc.getXmlFragment('default').toString();
}

// --- browser state --------------------------------------------------------

let fx;
const exoTabs = [];
let controlHandle;

async function readExo(handle) {
  try {
    return await fx.evalJson(
      handle,
      `(() => {
      const el = document.querySelector('[data-testid="connection-status"]');
      const h = window.__harness ? window.__harness() : null;
      const entries = window.exocortex ? window.exocortex.entries() : [];
      return {
        app: el ? el.dataset.appSocket : null,
        collab: el ? el.dataset.collaboration : null,
        page: h,
        providerLive: (() => { for (let i = entries.length - 1; i >= 0; i--) { const d = entries[i].detail; if (d && typeof d.live === 'number') return d.live; } return null; })(),
        logEntries: entries.length,
      };
    })()`,
    );
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

let controlCursor = 0;
async function readControl() {
  const state = await fx.evalJson(
    controlHandle,
    `(() => { const c = window.__control; if (!c) return null;
    return { fresh: c.fresh.slice(-60), beats: c.beats.slice(-60), drops: c.drops, persistentOpen: c.persistentOpen }; })()`,
  );
  if (!state) return null;
  const fresh = state.fresh.filter((f) => f.t > controlCursor);
  if (fresh.length) controlCursor = fresh.at(-1).t;
  const beats = state.beats.slice(-5).map((b) => b.rtt);
  return {
    freshOk: fresh.filter((f) => f.ok).length,
    freshFail: fresh.filter((f) => !f.ok).length,
    freshWhy: [...new Set(fresh.filter((f) => !f.ok).map((f) => f.why))],
    freshMaxMs: Math.max(0, ...fresh.map((f) => f.ms)),
    rttMax: Math.max(0, ...beats),
    drops: state.drops,
    persistentOpen: state.persistentOpen,
  };
}

// --- sampling -------------------------------------------------------------

let phase = 'setup';
let cycle = 0;
let scenario = null;
const samples = [];
let sampling = true;

async function sample() {
  const record = { t: now(), phase, cycle, scenario };
  try {
    record.control = await readControl();
    record.exo = [];
    for (const handle of exoTabs) record.exo.push(await readExo(handle));
    record.browser = await locked(() => fx.dashboard());
    record.process = fx.processMetrics();
    record.proxy = proxy.snapshot();
    record.controlServer = control.snapshot();
  } catch (error) {
    record.error = String(error).slice(0, 300);
  }
  samples.push(record);
  metricsFile.write(`${JSON.stringify(record)}\n`);
  return record;
}

async function samplerLoop() {
  while (sampling) {
    const started = now();
    await sample();
    await sleep(Math.max(0, 2000 - (now() - started)));
  }
}

// --- recovery and integrity checks ---------------------------------------

async function waitRecovered(timeoutMs = 180_000) {
  const started = now();
  while (now() - started < timeoutMs) {
    if (!withExo) return { ok: true, ms: 0 };
    const states = [];
    for (const handle of exoTabs) states.push(await readExo(handle));
    if (states.every((s) => s.app === 'connected' && s.collab === 'connected'))
      return { ok: true, ms: now() - started };
    await sleep(500);
  }
  return { ok: false, ms: now() - started };
}

let docIds = [];
async function typeMarker(tabIndex, marker) {
  return locked(async () => {
    await fx.driver.switchTo().window(exoTabs[tabIndex]);
    const editor = await fx.driver.findElement({ css: '.ProseMirror' });
    await fx.driver.executeScript(
      `
      const el = arguments[0];
      el.focus();
      const sel = window.getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
    `,
      editor,
    );
    await editor.sendKeys(`\n${marker}`);
  });
}

async function verifyMarker(documentId, marker, timeoutMs = 60_000) {
  const started = now();
  while (now() - started < timeoutMs) {
    const text = canonicalText(documentId);
    if (text.includes(marker)) return { ok: true, ms: now() - started };
    await sleep(1000);
  }
  return { ok: false, ms: now() - started };
}

// --- scenarios ------------------------------------------------------------

const regressionResults = [];
const SCENARIOS = createScenarios({
  services,
  proxy,
  locked,
  readExo,
  log,
  regressionResults,
  withExo,
  get fx() {
    return fx;
  },
  get exoTabs() {
    return exoTabs;
  },
  get cycle() {
    return cycle;
  },
  backgroundHandle: null,
});

const ORDER = args.scenarios ? args.scenarios.split(',') : Object.keys(SCENARIOS);
for (const name of ORDER) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}`);

// --- main -----------------------------------------------------------------

async function openExoTabs(cookies, workspaceId, documentIds) {
  const driver = fx.driver;
  await driver.get(`${ORIGIN}/anmelden`);
  for (const c of cookies) {
    const [name, ...rest] = c.split('=');
    await driver.manage().addCookie({ name, value: rest.join('='), path: '/' });
  }
  for (let i = 0; i < tabCount; i += 1) {
    if (i > 0) await driver.switchTo().newWindow('window');
    await driver.get(`${ORIGIN}/arbeitsbereich/${workspaceId}/seite/${documentIds[i]}`);
    exoTabs.push(await driver.getWindowHandle());
  }
}

const summary = {
  runId,
  args: { ...args, password: undefined },
  startedAt: new Date().toISOString(),
  cycles: [],
};

/** Reloads every eXocortex tab (F5) and waits for them to connect again. */
async function reloadTabs() {
  log('not recovered, reloading the eXocortex tabs');
  await locked(async () => {
    for (const handle of exoTabs) {
      await fx.driver.switchTo().window(handle);
      await fx.driver.navigate().refresh();
    }
  });
  return waitRecovered(90_000);
}

/** Types the cycle's marker into the first tab; a failure is logged, not thrown. */
async function tryTypeMarker(marker) {
  try {
    await typeMarker(0, marker);
    return true;
  } catch (error) {
    log('typing failed', { error: String(error).slice(0, 200) });
    return false;
  }
}

async function runCycle(cycles) {
  scenario = ORDER[(cycle - 1) % ORDER.length];
  const spec = SCENARIOS[scenario];
  phase = 'fault';
  const started = now();
  const marker = `harness-${cycle}-${Math.random().toString(36).slice(2, 8)}`;
  log(`cycle ${cycle}/${cycles}: ${scenario}`);
  const faultRun = spec.run();
  let typed = false;
  if (withExo && spec.offline) {
    await sleep(1500);
    typed = await tryTypeMarker(marker);
  }
  await faultRun;
  phase = 'recovery';
  const recovered = await waitRecovered();
  // A tab that never came back is the finding; the reload is what a person
  // would do next, and it keeps the remaining cycles meaningful instead of
  // timing out on the same dead tab.
  const reloaded = !recovered.ok && withExo ? await reloadTabs() : null;
  let integrity = null;
  if (withExo) {
    if (!typed) typed = await tryTypeMarker(marker);
    integrity = typed
      ? await verifyMarker(docIds[0], marker)
      : { ok: false, ms: 0, reason: 'not typed' };
  }
  await sleep(5000);
  const after = summarize(await sample());
  summary.cycles.push({
    cycle,
    scenario,
    durationMs: now() - started,
    recovered,
    reloaded,
    integrity,
    offlineEdit: Boolean(spec.offline),
    after,
  });
  log(`cycle ${cycle} done`, {
    recovered: recovered.ok,
    recoverMs: recovered.ms,
    reloaded: reloaded?.ok,
    yjs: integrity?.ok,
    live: after.exoLive,
    connecting: after.exoConnecting,
    browserSockets: after.browserSockets,
  });
  phase = 'settle';
  await sleep(5000);
}

/** What makes the run a failure, so it can stand unattended in a loop. */
function failures(v) {
  const fresh = v.freshTabAfterRun;
  return [
    v.controlFresh.failedInCooldown > 0 &&
      'control origin refused fresh handshakes after the faults stopped',
    fresh &&
      fresh.ok < fresh.attempts &&
      'a new tab could not open WebSockets to the control origin',
    v.exo.cyclesNotRecovered > 0 && `${v.exo.cyclesNotRecovered} cycle(s) did not reconnect`,
    v.exo.yjsChecksFailed > 0 &&
      `${v.exo.yjsChecksFailed} offline edit(s) missing from the canonical state`,
    v.exo.maxProviders > 1 && `provider count in one page reached ${v.exo.maxProviders}`,
    ...v.regression
      .filter((r) => !r.ok)
      .map(
        (r) =>
          `${r.scenario} in cycle ${r.cycle}: ${r.maxLiveCollabSockets} live collaboration sockets`,
      ),
  ].filter(Boolean);
}

async function main() {
  log('starting stack');
  await proxy.listen();
  await control.listen();
  await services.startAll();

  const { cookie, cookies } = await signIn();
  const first = await createDocument(cookie);
  docIds = [first.documentId];
  for (let i = 1; i < tabCount; i += 1) docIds.push((await createDocument(cookie)).documentId);
  log('document ready', { workspaceId: first.workspaceId, documents: docIds });

  const maxWs = args['max-ws'] === undefined ? undefined : Number(args['max-ws']);
  fx = await launchFirefox({
    headless: !args.headful,
    maxWebSockets: maxWs,
    logFile: path.join(OUT, 'geckodriver.log'),
  });
  summary.firefox = {
    version: fx.version,
    pid: fx.pid,
    maxWebSockets: maxWs ?? 'default',
    headless: !args.headful,
  };
  summary.host = {
    os: fs.readFileSync('/etc/os-release', 'utf8').match(/PRETTY_NAME="([^"]+)"/)?.[1],
    kernel: execFileSync('uname', ['-r']).toString().trim(),
  };
  log('firefox', summary.firefox);

  await locked(async () => {
    if (withExo) await openExoTabs(cookies, first.workspaceId, docIds);
    else await fx.driver.get('about:blank');
    await fx.driver.switchTo().newWindow('window');
    await fx.driver.get(control.url);
    controlHandle = await fx.driver.getWindowHandle();
  });

  const initial = await waitRecovered(120_000);
  if (!initial.ok)
    throw new Error('eXocortex never connected in the first place; see services/*.log');
  log('connected', initial);

  void samplerLoop();
  phase = 'warmup';
  await sleep(30_000);
  const baselineSample = await sample();

  const cycles = Number(args.cycles);
  for (cycle = 1; cycle <= cycles; cycle += 1) await runCycle(cycles);

  phase = 'cooldown';
  scenario = null;
  await sleep(60_000);
  const finalSample = await sample();

  // A brand-new tab on the unrelated origin, after everything: the user's
  // actual complaint is that a *new* connection anywhere fails.
  const freshTab = await locked(async () => {
    await fx.driver.switchTo().newWindow('tab');
    await fx.driver.get(CONTROL_ORIGIN + '/');
    const handle = await fx.driver.getWindowHandle();
    await sleep(12_000);
    const state = await fx.evalJson(handle, 'window.__control.fresh');
    await fx.driver.close();
    await fx.driver.switchTo().window(controlHandle);
    return { attempts: state.length, ok: state.filter((f) => f.ok).length };
  });

  sampling = false;
  summary.baseline = summarize(baselineSample);
  summary.final = summarize(finalSample);
  summary.freshTab = freshTab;
  summary.finishedAt = new Date().toISOString();
  summary.verdict = verdict();
  summary.failures = failures(summary.verdict);
  if (withExo) {
    summary.dump = await fx
      .evalJson(exoTabs[0], 'window.exocortex ? window.exocortex.dump() : null')
      .catch(() => null);
  }
}

function summarize(s) {
  const exo = s?.exo ?? [];
  return {
    t: s?.t,
    exoLive: exo.reduce((a, e) => a + (e.page?.live ?? 0), 0),
    exoConnecting: exo.reduce((a, e) => a + (e.page?.byState?.connecting ?? 0), 0),
    exoCreated: exo.reduce((a, e) => a + (e.page?.created ?? 0), 0),
    providerLive: exo.map((e) => e.providerLive),
    listeners: exo.map((e) => e.page?.listeners ?? null),
    timeouts: exo.map((e) => e.page?.timeouts ?? null),
    intervals: exo.map((e) => e.page?.intervals ?? null),
    browserSockets: s?.browser?.sockets,
    browserWebsockets: s?.browser?.websockets,
    rssMb: s?.process?.rssMb,
    fds: s?.process?.fds,
    threads: s?.process?.threads,
    proxyActive: s?.proxy?.activeUpgraded,
  };
}

const sumOver = (list, pick) => list.reduce((a, item) => a + (pick(item) ?? 0), 0);
const delta = (pick) => (pick(summary.final) ?? 0) - (pick(summary.baseline) ?? 0);

function exoMaxima() {
  const perSample = samples.map((s) => s.exo ?? []);
  const maxLiveByPath = {};
  for (const tab of perSample.flat()) {
    for (const [p, n] of Object.entries(tab.page?.liveByPath ?? {}))
      maxLiveByPath[p] = Math.max(maxLiveByPath[p] ?? 0, n);
  }
  return {
    maxLiveSockets: Math.max(0, ...perSample.map((tabs) => sumOver(tabs, (e) => e.page?.live))),
    maxLiveByPath,
    maxConnectingSockets: Math.max(
      0,
      ...perSample.map((tabs) => sumOver(tabs, (e) => e.page?.byState?.connecting)),
    ),
    maxProviders: Math.max(0, ...perSample.flat().map((e) => e.providerLive ?? 0)),
    cyclesNotRecovered: summary.cycles.filter((c) => !c.recovered.ok).length,
    yjsChecksFailed: summary.cycles.filter((c) => c.integrity && !c.integrity.ok).length,
  };
}

function verdict() {
  const controlSamples = samples.filter((s) => s.control);
  return {
    controlFresh: {
      ok: sumOver(controlSamples, (s) => s.control.freshOk),
      failed: sumOver(controlSamples, (s) => s.control.freshFail),
      failedInCooldown: sumOver(
        controlSamples.filter((s) => s.phase === 'cooldown'),
        (s) => s.control.freshFail,
      ),
    },
    freshTabAfterRun: summary.freshTab,
    exo: exoMaxima(),
    regression: regressionResults,
    growth: {
      exoLive: delta((x) => x?.exoLive),
      browserSockets: delta((x) => x?.browserSockets),
      rssMb: delta((x) => x?.rssMb),
      fds: delta((x) => x?.fds),
      timeouts: delta((x) => x?.timeouts?.[0]),
      intervals: delta((x) => x?.intervals?.[0]),
    },
  };
}

let exitCode = 0;
let finishing = false;

async function finish() {
  if (finishing) return;
  finishing = true;
  sampling = false;
  try {
    if (fx) {
      fs.writeFileSync(
        path.join(OUT, 'console.jsonl'),
        fx.consoleLines.map((l) => JSON.stringify(l)).join('\n'),
      );
      await fx.quit();
    }
  } catch {
    // A browser that already died; the results below are written regardless.
  }
  fs.writeFileSync(
    path.join(OUT, 'proxy-events.jsonl'),
    proxy.events.map((e) => JSON.stringify(e)).join('\n'),
  );
  await services.stopAll().catch(() => {});
  await proxy.close().catch(() => {});
  await control.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  if (summary.dump) fs.writeFileSync(path.join(OUT, 'exocortex-dump.txt'), summary.dump);
  metricsFile.end();
  eventsFile.end();
  console.log(`\nresults: ${OUT}`);
  if (summary.verdict) console.log(JSON.stringify(summary.verdict, null, 2));
  if (summary.failures?.length) {
    console.log(`\nFAILED:\n  ${summary.failures.join('\n  ')}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

// Ctrl-C or a kill must not leave the harness's API, collaboration server,
// web server and Firefox running on their ports.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    summary.error = `interrupted by ${signal}`;
    exitCode = 130;
    void finish();
  });
}

try {
  await main();
} catch (error) {
  exitCode = 1;
  summary.error = String(error?.stack ?? error);
  log('FAILED', { error: String(error).slice(0, 500) });
} finally {
  await finish();
}
