#!/usr/bin/env node
/**
 * SessionEnd hook: hands the finished session to `capture.mjs` and leaves
 * (issue #34, AP1; issue #188).
 *
 * Deliberately `SessionEnd` and not `Stop`. `Stop` fires every time the agent
 * finishes a reply, which would mean a model call and a page per turn; a
 * memory is worth writing once, when there is a session to look back on.
 *
 * Why this file does almost nothing: Claude Code gives all `SessionEnd` hooks
 * together a budget of 1.5 seconds and then kills them. A `timeout` in
 * `settings.json` raises that budget, a `timeout` in a plugin's `hooks.json`
 * does not (measured with Claude Code 2.1.296: the plugin hook was killed
 * after 1.5 s despite `"timeout": 15`, the identical hook from `--settings` ran
 * to the end). Starting Node, reading a long transcript and posting it does
 * not reliably fit in that, so on every machine that had the hooks from the
 * plugin, the capture was cut off on `/exit` and nothing was ever remembered.
 *
 * So the work runs in a detached process of its own, which outlives this one
 * and the session: this hook reads its input, starts `capture.mjs` in a new
 * process group, and exits within a few milliseconds. The hook input travels
 * in that process's environment, which only the same user can read, and holds
 * paths and ids, never conversation; the credential is inherited the same way
 * it reached this hook, and never written anywhere.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configForHook, readHookInput } from './config.mjs';
import { projectId, record } from './diagnostics.mjs';

async function main() {
  const hook = configForHook('sessionEnd');
  if (hook === null) return;

  const input = await readHookInput();
  const observed = {
    ...hook.base,
    reason: typeof input.reason === 'string' ? input.reason : null,
    hasCwd: typeof input.cwd === 'string',
    hasTranscriptPath: typeof input.transcript_path === 'string',
    hasSessionId: typeof input.session_id === 'string',
    project: projectId(typeof input.cwd === 'string' ? input.cwd : process.cwd()),
  };

  // `logout` ends a session nobody was in, so there is nothing to look back on.
  // `clear` is not in this list on purpose: it looks like an interruption but is
  // how most people finish one piece of work and start the next, which is
  // exactly the boundary a memory wants. A cleared session that carried nothing
  // is turned away later anyway, by `memory.captureMinChars`.
  if (input.reason === 'logout') {
    record('sessionEnd', { ...observed, stage: 'skipped_logout' });
    return;
  }
  if (typeof input.transcript_path !== 'string') {
    record('sessionEnd', { ...observed, stage: 'no_transcript_path' });
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, 'capture.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      EXOCORTEX_HOOK_INPUT: JSON.stringify({
        transcript_path: input.transcript_path,
        cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
        session_id: typeof input.session_id === 'string' ? input.session_id : null,
        reason: observed.reason,
      }),
    },
  });
  // Asynchronous, and unhandled it would crash this hook with a stack trace.
  child.on('error', () => record('sessionEnd', { ...observed, stage: 'spawn_failed' }));
  child.unref();
  record('sessionEnd', { ...observed, stage: 'dispatched' });
}

main().catch(() => {
  // Deliberately silent, deliberately successful: a failed capture is a memory
  // that was not written, never a reason to colour somebody's exit red.
  process.exit(0);
});
