#!/usr/bin/env node
/**
 * SessionEnd hook: hands the finished session to eXocortex to be distilled into
 * one memory (issue #34, AP1).
 *
 * Deliberately `SessionEnd` and not `Stop`. `Stop` fires every time the agent
 * finishes a reply, which would mean a model call and a page per turn; a
 * memory is worth writing once, when there is a session to look back on.
 *
 * Nothing is stored raw. This sends the conversation, the API stores none of
 * it, and the worker writes only the summary a model made of it. Tool calls and
 * their output are dropped here, before anything leaves the machine: they are
 * the bulk of a transcript and almost none of its meaning.
 */

import { readFileSync } from 'node:fs';

import { callApi, readConfig, readHookInput } from './config.mjs';

/** Upper bound on what is sent. The worker cuts it down again for the model. */
const MAX_TRANSCRIPT_CHARS = 80_000;
/** Longest single message kept whole. Longer ones are cut in the middle. */
const MAX_MESSAGE_CHARS = 4_000;
/** The session has ended and nobody is waiting, but a hook must not hang either. */
const TIMEOUT_MS = 10_000;

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
 * Reads the JSONL transcript into a plain conversation.
 *
 * Every line is parsed on its own and a broken one is skipped: a transcript is
 * appended to while the session runs, so the last line can be half written.
 */
function readTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }

  const parts = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
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
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  // The end of a session is the part worth remembering: what was decided, what
  // was left open.
  return joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
}

async function main() {
  const config = readConfig();
  if (config === null || config.disabled) return;

  const input = await readHookInput();
  // `logout` ends a session nobody was in, so there is nothing to look back on.
  // `clear` is not in this list on purpose: it looks like an interruption but is
  // how most people finish one piece of work and start the next, which is
  // exactly the boundary a memory wants. A cleared session that carried nothing
  // is turned away later anyway, by `memory.captureMinChars`.
  if (input.reason === 'logout') return;

  const path = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  if (path === null) return;

  const transcript = readTranscript(path);
  if (transcript.length === 0) return;

  const project = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();

  await callApi(config, {
    method: 'POST',
    path: '/api/memory/capture',
    body: {
      project,
      client: 'claude-code',
      ...(typeof input.session_id === 'string' ? { sessionId: input.session_id } : {}),
      transcript,
    },
    timeoutMs: TIMEOUT_MS,
  });
}

main().catch(() => {
  // Deliberately silent, deliberately successful: a failed capture is a memory
  // that was not written, never a reason to colour somebody's exit red.
  process.exit(0);
});
