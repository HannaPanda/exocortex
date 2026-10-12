#!/usr/bin/env node
/**
 * Hands a finished session to eXocortex to be distilled into one memory
 * (issue #34, AP1), and follows it until the server says what became of it
 * (issue #188).
 *
 * Started detached by `session-end.mjs`, never by Claude Code directly: see
 * that file for why. It reads the hook input from `EXOCORTEX_HOOK_INPUT`, and
 * because nobody waits for it any more it can afford to watch the job to its
 * end. Accepting a transcript is not writing a note, so the state file records
 * the server's final answer (a note written, nothing worth keeping, a model
 * that failed), not the 200 of the upload.
 *
 * Nothing is stored raw. This sends the conversation, the API stores none of
 * it, and the worker writes only the summary a model made of it. Tool calls and
 * their output are dropped here, before anything leaves the machine: they are
 * the bulk of a transcript and almost none of its meaning.
 */

import { readFileSync } from 'node:fs';

import { environmentPresence, locate, requestApi, switchedOff } from './config.mjs';
import { projectId, record } from './diagnostics.mjs';

/** Upper bound on what is sent. The worker cuts it down again for the model. */
const MAX_TRANSCRIPT_CHARS = 80_000;
/** Longest single message kept whole. Longer ones are cut in the middle. */
const MAX_MESSAGE_CHARS = 4_000;
/** Nobody is waiting any more, but a request must not hang either. */
const TIMEOUT_MS = 20_000;
/**
 * Pauses between status questions, in seconds: quick at first, because a short
 * session is distilled in a few seconds, then slower. About four minutes in
 * all, which is longer than the worker's own two-minute model timeout plus a
 * queue that had other sessions ahead of this one.
 */
const POLL_DELAYS_S = [2, 3, 5, 5, 10, 10, 15, 15, 20, 20, 30, 30, 30, 30];
/** Whatever happens, this process is gone after this. */
const HARD_STOP_MS = 300_000;

/** Text blocks of one transcript entry, tool traffic excluded. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function shorten(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const half = Math.floor(MAX_MESSAGE_CHARS / 2);
  return `${text.slice(0, half)}\n… (gekürzt) …\n${text.slice(text.length - half)}`;
}

/**
 * Reads the JSONL transcript into a plain conversation and the moment it ended.
 *
 * Every line is parsed on its own and a broken one is skipped: a transcript is
 * appended to while the session runs, so the last line can be half written.
 *
 * The end is read from the transcript rather than taken from the clock, so that
 * replaying an old transcript dates its memory by the session instead of by the
 * replay. For a hook firing normally the two are seconds apart.
 */
function readTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { readable: false, entries: 0, text: '', endedAt: null };
  }

  const parts = [];
  let endedAt = null;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Every entry carries the clock forward, including the ones dropped below:
    // the last thing to happen in a session is rarely the last thing said.
    if (typeof entry.timestamp === 'string') endedAt = entry.timestamp;
    if (entry.isMeta === true) continue;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = textOf(entry.message).trim();
    if (text.length === 0) continue;
    // Slash-command bookkeeping and hook output are not conversation.
    if (text.startsWith('<local-command') || text.startsWith('<command-')) continue;

    parts.push(`${role}: ${shorten(text)}`);
  }

  const joined = parts.join('\n\n');
  // The end of a session is the part worth remembering: what was decided, what
  // was left open.
  const text =
    joined.length <= MAX_TRANSCRIPT_CHARS
      ? joined
      : joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
  return { readable: true, entries: parts.length, text, endedAt };
}

function readInput() {
  try {
    const input = JSON.parse(process.env.EXOCORTEX_HOOK_INPUT ?? '');
    return input !== null && typeof input === 'object' ? input : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks after the job until it has an answer, the queue forgets it, or the
 * patience runs out. Returns the last thing it learnt.
 */
async function follow(config, jobId) {
  let polls = 0;
  for (const seconds of POLL_DELAYS_S) {
    await sleep(seconds * 1000);
    polls += 1;
    const answer = await requestApi(config, {
      method: 'GET',
      path: `/api/memory/capture/${encodeURIComponent(jobId)}`,
      timeoutMs: TIMEOUT_MS,
    });
    // A server from before issue #188 has no such route. The capture itself
    // went through; there is just nobody to ask about it.
    if (answer.status === 404) return { stage: 'status_unavailable', polls };
    if (!answer.ok) continue;
    const status = answer.data;
    if (status?.state === 'completed') {
      return {
        stage: 'processed',
        state: 'completed',
        outcome: typeof status.outcome === 'string' ? status.outcome : null,
        documentId: typeof status.documentId === 'string' ? status.documentId : null,
        polls,
      };
    }
    if (status?.state === 'failed' || status?.state === 'not_found') {
      return {
        stage: 'processed',
        state: status.state,
        rejectedReason: typeof status.reason === 'string' ? status.reason : null,
        polls,
      };
    }
  }
  return { stage: 'still_pending', polls };
}

async function main() {
  const startedAt = Date.now();
  const located = switchedOff() ? null : locate();
  const input = readInput();
  if (located === null || located.config.disabled || input === null) return;
  const { config } = located;

  const project = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const observed = {
    env: environmentPresence(),
    configSource: located.source,
    memory: 'on',
    reason: typeof input.reason === 'string' ? input.reason : null,
    hasCwd: typeof input.cwd === 'string',
    hasTranscriptPath: typeof input.transcript_path === 'string',
    hasSessionId: typeof input.session_id === 'string',
    project: projectId(project),
  };

  const transcript = readTranscript(String(input.transcript_path));
  const read = {
    ...observed,
    transcriptReadable: transcript.readable,
    transcriptEntries: transcript.entries,
    transcriptChars: transcript.text.length,
  };
  if (!transcript.readable) {
    record('sessionEnd', { ...read, stage: 'transcript_unreadable' });
    return;
  }
  if (transcript.text.length === 0) {
    record('sessionEnd', { ...read, stage: 'transcript_empty' });
    return;
  }

  const answer = await requestApi(config, {
    method: 'POST',
    path: '/api/memory/capture',
    body: {
      project,
      client: 'claude-code',
      ...(typeof input.session_id === 'string' ? { sessionId: input.session_id } : {}),
      ...(transcript.endedAt === null ? {} : { endedAt: transcript.endedAt }),
      transcript: transcript.text,
    },
    timeoutMs: TIMEOUT_MS,
  });
  if (!answer.ok) {
    record('sessionEnd', {
      ...read,
      stage: 'capture_failed',
      status: answer.status,
      error: answer.error,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const captured = answer.data ?? {};
  if (captured.accepted !== true) {
    // `transcript_too_short`, `memory_disabled`, `memory_workspace_not_configured`:
    // the server's own words, which say exactly which setting to look at.
    record('sessionEnd', {
      ...read,
      stage: 'capture_rejected',
      status: answer.status,
      accepted: false,
      rejectedReason: typeof captured.reason === 'string' ? captured.reason : null,
    });
    return;
  }

  const jobId = typeof captured.jobId === 'string' ? captured.jobId : null;
  const queued = { ...read, status: answer.status, accepted: true, jobId };
  record('sessionEnd', { ...queued, stage: 'queued' });
  if (jobId === null) return;

  const outcome = await follow(config, jobId);
  record('sessionEnd', { ...queued, ...outcome, durationMs: Date.now() - startedAt });
}

// A watchdog rather than trust: this process is invisible to everybody, so it
// must not be able to linger whatever the network does.
setTimeout(() => process.exit(0), HARD_STOP_MS).unref();

main()
  .catch(() => {
    // Deliberately silent: nobody is attached to this process to hear it.
  })
  .finally(() => process.exit(0));
