/**
 * The hooks, run the way Claude Code runs them: as a process, with the hook
 * input on stdin and the configuration in the environment, against a fake API
 * (issue #188). Plain `node:test`, because the plugin has no dependencies and
 * should not grow any for its tests.
 *
 * Every case gets an empty home directory and a scrubbed environment, so a
 * real `~/.claude.json` or `EXOCORTEX_API_TOKEN` on the machine running the
 * tests can never be what made one pass.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_DEBUG_LOG_BYTES, redact, sanitize } from '../hooks/diagnostics.mjs';

import { startFakeApi, VALID_TOKEN } from './fake-api.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function api(options) {
  const fake = await startFakeApi(options);
  cleanups.push(fake.close);
  return fake;
}

/** A home directory, a state directory and a transcript, all empty and private to one case. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'exocortex-hooks-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  mkdirSync(home);
  return { root, home, state };
}

function transcriptFile(root, entries, name = 'transcript.jsonl') {
  const path = join(root, name);
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

/** A conversation long enough to be worth sending, with tool traffic that must not be. */
function conversation() {
  const said = (role, text, timestamp) => ({ timestamp, message: { role, content: text } });
  return [
    said(
      'user',
      'Bitte richte das Gedächtnis ein und prüfe, ob es nach dem Beenden schreibt.',
      '2026-10-12T10:00:00Z',
    ),
    {
      timestamp: '2026-10-12T10:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Ich prüfe zuerst die Konfiguration der Hooks.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'cat ~/.secret' } },
        ],
      },
    },
    {
      timestamp: '2026-10-12T10:00:06Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'GEHEIMER-TOOL-OUTPUT' }],
      },
    },
    said(
      'assistant',
      'Die Hooks sind eingerichtet, der Mitschrieb läuft beim Beenden.',
      '2026-10-12T10:01:00Z',
    ),
  ];
}

/** Environment with nothing from the machine except PATH. */
function environment(box, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: box.home,
    USERPROFILE: box.home,
    EXOCORTEX_MEMORY_STATE_DIR: box.state,
    ...extra,
  };
}

function pluginEnv(url, token = VALID_TOKEN) {
  return {
    CLAUDE_PLUGIN_ROOT: join(HOOKS, '..'),
    CLAUDE_PLUGIN_OPTION_API_URL: url,
    ...(token === null ? {} : { CLAUDE_PLUGIN_OPTION_API_TOKEN: token }),
  };
}

/** Runs one hook to its exit and reports how long it took. */
function runHook(name, input, env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(HOOKS, name)], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - startedAt }));
    child.stdin.end(JSON.stringify(input));
  });
}

function readState(box) {
  try {
    return JSON.parse(readFileSync(join(box.state, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Waits for the detached capture process to record a stage it settles on. */
async function settledEnd(box, stages, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const entry = readState(box).sessionEnd;
    if (entry !== undefined && stages.includes(entry.stage)) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`sessionEnd never reached ${stages.join('/')}: ${JSON.stringify(readState(box))}`);
}

function endInput(box, overrides = {}) {
  return {
    session_id: 'session-abc',
    transcript_path: transcriptFile(box.root, conversation()),
    cwd: '/home/someone/projects/secret-client',
    hook_event_name: 'SessionEnd',
    reason: 'prompt_input_exit',
    ...overrides,
  };
}

void describe('SessionEnd', () => {
  void it('returns at once and leaves the capture to a detached process', async () => {
    // The fake never answers, so a hook that waited for the upload would sit
    // here for its whole timeout. Claude Code kills it after 1.5 s.
    const fake = await api({ hang: ['POST /api/memory/capture'] });
    const box = sandbox();
    const result = await runHook(
      'session-end.mjs',
      endInput(box),
      environment(box, pluginEnv(fake.url)),
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.ms < 1_000, `hook took ${String(result.ms)} ms`);
    assert.equal(readState(box).sessionEnd.stage, 'dispatched');
  });

  void it('sends the full payload, without tool traffic, and follows the job to its note', async () => {
    const fake = await api({ pollsUntilDone: 2 });
    const box = sandbox();
    await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url)));

    const entry = await settledEnd(box, ['processed']);
    assert.equal(entry.outcome, 'written');
    assert.equal(entry.documentId, 'doc-12345');
    assert.equal(entry.configSource, 'plugin');
    assert.equal(entry.reason, 'prompt_input_exit');
    assert.deepEqual(
      [entry.hasCwd, entry.hasTranscriptPath, entry.hasSessionId],
      [true, true, true],
    );

    const capture = fake.requests.find((request) => request.route === 'POST /api/memory/capture');
    assert.ok(capture.authorized);
    assert.equal(capture.body.project, '/home/someone/projects/secret-client');
    assert.equal(capture.body.sessionId, 'session-abc');
    assert.equal(capture.body.client, 'claude-code');
    assert.equal(capture.body.endedAt, '2026-10-12T10:01:00Z');
    assert.match(capture.body.transcript, /Hooks sind eingerichtet/);
    assert.doesNotMatch(capture.body.transcript, /GEHEIMER-TOOL-OUTPUT|cat ~\/\.secret/);
    assert.equal(
      fake.requests.filter((request) => request.route === 'GET /api/memory/capture/:id').length,
      2,
    );
  });

  void it('captures on /clear as on /exit', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook(
      'session-end.mjs',
      endInput(box, { reason: 'clear' }),
      environment(box, pluginEnv(fake.url)),
    );
    const entry = await settledEnd(box, ['processed']);
    assert.equal(entry.reason, 'clear');
    assert.equal(entry.outcome, 'written');
  });

  void it('sends nothing on logout', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook(
      'session-end.mjs',
      endInput(box, { reason: 'logout' }),
      environment(box, pluginEnv(fake.url)),
    );
    assert.equal(readState(box).sessionEnd.stage, 'skipped_logout');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fake.requests.length, 0);
  });

  void it('records a transcript with no conversation in it, and sends nothing', async () => {
    const fake = await api();
    const box = sandbox();
    const onlyTools = transcriptFile(
      box.root,
      [{ message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }],
      'tools-only.jsonl',
    );
    await runHook(
      'session-end.mjs',
      endInput(box, { transcript_path: onlyTools }),
      environment(box, pluginEnv(fake.url)),
    );
    const entry = await settledEnd(box, ['transcript_empty']);
    assert.equal(entry.transcriptChars, 0);
    assert.equal(fake.requests.length, 0);
  });

  void it('records an unreadable transcript', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook(
      'session-end.mjs',
      endInput(box, { transcript_path: join(box.root, 'gone.jsonl') }),
      environment(box, pluginEnv(fake.url)),
    );
    const entry = await settledEnd(box, ['transcript_unreadable']);
    assert.equal(entry.transcriptReadable, false);
  });

  void it('records the reason when the server turns a short session away', async () => {
    const fake = await api({
      captureAnswer: { accepted: false, jobId: null, reason: 'transcript_too_short' },
    });
    const box = sandbox();
    await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url)));
    const entry = await settledEnd(box, ['capture_rejected']);
    assert.equal(entry.rejectedReason, 'transcript_too_short');
  });

  for (const status of [401, 403, 500]) {
    void it(`records HTTP ${String(status)} from the capture`, async () => {
      const fake = await api({ status: { 'POST /api/memory/capture': status } });
      const box = sandbox();
      await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url)));
      const entry = await settledEnd(box, ['capture_failed']);
      assert.equal(entry.status, status);
      assert.equal(entry.error, 'http');
    });
  }

  void it('records a model that found nothing as a processed session, not a failure', async () => {
    const fake = await api({ outcome: { outcome: 'nothing_to_remember', documentId: null } });
    const box = sandbox();
    await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url)));
    const entry = await settledEnd(box, ['processed']);
    assert.equal(entry.outcome, 'nothing_to_remember');
  });

  void it('says a server without the status route is older, not broken', async () => {
    const fake = await api({ status: { 'GET /api/memory/capture/:id': 404 } });
    const box = sandbox();
    await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url)));
    await settledEnd(box, ['status_unavailable']);
  });
});

void describe('where the configuration comes from', () => {
  void it('reports a plugin that handed over the address but no token', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook('session-end.mjs', endInput(box), environment(box, pluginEnv(fake.url, null)));

    const entry = readState(box).sessionEnd;
    assert.equal(entry.stage, 'no_config');
    assert.deepEqual(entry.env, {
      pluginRoot: true,
      pluginOptionUrl: true,
      pluginOptionToken: false,
      envUrl: false,
      envToken: false,
    });
  });

  void it('runs without any plugin environment at all', async () => {
    const box = sandbox();
    const result = await runHook('session-start.mjs', { cwd: '/x' }, environment(box));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(readState(box).sessionStart.stage, 'no_config');
  });

  const sources = [
    ['env', (url) => ({ EXOCORTEX_API_URL: url, EXOCORTEX_API_TOKEN: VALID_TOKEN })],
    ['plugin', (url) => pluginEnv(url)],
    [
      'file',
      (url, box) => {
        mkdirSync(join(box.home, '.claude'), { recursive: true });
        writeFileSync(
          join(box.home, '.claude', 'exocortex-memory.json'),
          JSON.stringify({ apiUrl: url, token: VALID_TOKEN }),
        );
        return {};
      },
    ],
    [
      'mcp_entry',
      (url, box) => {
        writeFileSync(
          join(box.home, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              exocortex: { env: { EXOCORTEX_API_URL: url, EXOCORTEX_API_TOKEN: VALID_TOKEN } },
            },
          }),
        );
        return {};
      },
    ],
  ];
  for (const [source, prepare] of sources) {
    void it(`finds the credential in ${String(source)}`, async () => {
      const fake = await api();
      const box = sandbox();
      const extra = prepare(fake.url, box);
      await runHook('session-start.mjs', { cwd: '/x' }, environment(box, extra));
      const entry = readState(box).sessionStart;
      assert.equal(entry.configSource, source);
      assert.equal(entry.stage, 'recalled_nothing');
      assert.ok(fake.requests[0].authorized);
    });
  }

  void it('stays silent when the plugin option switches the memory off', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook(
      'session-end.mjs',
      endInput(box),
      environment(box, { ...pluginEnv(fake.url), CLAUDE_PLUGIN_OPTION_MEMORY: 'false' }),
    );
    assert.equal(readState(box).sessionEnd.stage, 'disabled');
    assert.equal(fake.requests.length, 0);
  });
});

void describe('SessionStart', () => {
  void it('injects what was recalled and notices the last note among it', async () => {
    const fake = await api({ recallHits: [{ documentId: 'doc-12345' }] });
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    writeFileSync(
      join(box.state, 'state.json'),
      JSON.stringify({ sessionEnd: { stage: 'processed', documentId: 'doc-12345' } }),
    );

    const result = await runHook(
      'session-start.mjs',
      { cwd: '/x', source: 'startup' },
      environment(box, pluginEnv(fake.url)),
    );
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /Gedächtnis aus eXocortex/);

    const entry = readState(box).sessionStart;
    assert.equal(entry.stage, 'recalled');
    assert.equal(entry.hits, 1);
    assert.equal(entry.lastNoteRecalled, true);
    assert.equal(entry.source, 'startup');
  });

  void it('prints nothing and records the status when the token is refused', async () => {
    const fake = await api({ status: { 'GET /api/memory/recall': 403 } });
    const box = sandbox();
    const result = await runHook(
      'session-start.mjs',
      { cwd: '/x' },
      environment(box, pluginEnv(fake.url)),
    );
    assert.equal(result.stdout, '');
    assert.equal(result.code, 0);
    assert.deepEqual(
      [readState(box).sessionStart.stage, readState(box).sessionStart.status],
      ['recall_failed', 403],
    );
  });

  void it('gives up on a hanging server inside its own timeout', async () => {
    const fake = await api({ hang: ['GET /api/memory/recall'] });
    const box = sandbox();
    const result = await runHook(
      'session-start.mjs',
      { cwd: '/x' },
      environment(box, pluginEnv(fake.url)),
    );
    assert.equal(result.code, 0);
    assert.ok(result.ms < 8_000, `hook took ${String(result.ms)} ms`);
    assert.equal(readState(box).sessionStart.error, 'timeout');
  });
});

void describe('diagnostics', () => {
  void it('writes no debug log unless asked', async () => {
    const fake = await api();
    const box = sandbox();
    await runHook('session-start.mjs', { cwd: '/x' }, environment(box, pluginEnv(fake.url)));
    assert.equal(existsSync(join(box.state, 'debug.log')), false);
  });

  for (const [label, extra] of [
    ['EXOCORTEX_MEMORY_DEBUG=1', { EXOCORTEX_MEMORY_DEBUG: '1' }],
    ['the plugin option', { CLAUDE_PLUGIN_OPTION_DEBUG: 'true' }],
  ]) {
    void it(`writes a debug log with ${String(label)}, and nothing secret in it or in the state`, async () => {
      const fake = await api();
      const box = sandbox();
      const env = environment(box, { ...pluginEnv(fake.url), ...extra });
      await runHook('session-end.mjs', endInput(box), env);
      await settledEnd(box, ['processed']);

      const log = readFileSync(join(box.state, 'debug.log'), 'utf8');
      const state = readFileSync(join(box.state, 'state.json'), 'utf8');
      assert.ok(log.split('\n').filter(Boolean).length >= 2);
      for (const text of [log, state]) {
        assert.doesNotMatch(text, new RegExp(VALID_TOKEN));
        assert.doesNotMatch(text, /secret-client|\/home\/someone|transcript\.jsonl/);
        assert.doesNotMatch(text, /Gedächtnis ein und prüfe|Hooks sind eingerichtet/);
        assert.doesNotMatch(text, /127\.0\.0\.1/);
      }
    });
  }

  void it('keeps only allowlisted fields and blanks anything shaped like a credential', () => {
    const clean = sanitize({
      stage: 'capture_failed',
      rejectedReason: `token ${VALID_TOKEN} and Bearer abc.def`,
      transcript: 'the whole conversation',
      authorization: `Bearer ${VALID_TOKEN}`,
      env: { pluginOptionToken: true, CLAUDE_PLUGIN_OPTION_API_TOKEN: VALID_TOKEN },
    });
    assert.deepEqual(Object.keys(clean).sort(), ['env', 'rejectedReason', 'stage']);
    assert.deepEqual(clean.env, { pluginOptionToken: true });
    assert.doesNotMatch(clean.rejectedReason, /exo_|abc\.def/);
    assert.ok(redact('x'.repeat(500)).length <= 121);
  });

  void it('rotates the debug log instead of letting it grow', async () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    writeFileSync(join(box.state, 'debug.log'), 'x'.repeat(MAX_DEBUG_LOG_BYTES + 10));
    await runHook(
      'session-start.mjs',
      { cwd: '/x' },
      environment(box, { EXOCORTEX_MEMORY_DEBUG: '1' }),
    );
    assert.ok(existsSync(join(box.state, 'debug.log.1')));
    assert.ok(readFileSync(join(box.state, 'debug.log'), 'utf8').length < 2_000);
  });
});
