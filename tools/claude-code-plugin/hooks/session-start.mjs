#!/usr/bin/env node
/**
 * SessionStart hook: puts what eXocortex remembers about this directory into
 * the starting session's context (issue #34, AP2).
 *
 * Two properties matter more than the feature itself.
 *
 * It is bounded. `maxChars` is sent with every request and the API clamps it
 * again, because a memory that eats the context window it is meant to improve
 * is worse than no memory: the first thing to go would be the user's actual
 * question.
 *
 * And it never fails loudly. Every error path ends in "print nothing, exit 0".
 * A session that starts without its memory is a session that starts.
 */

import { callApi, readConfig, readHookInput } from './config.mjs';

/** Ceiling for the injected block. Roughly a page of text. */
const MAX_CHARS = 4_000;
/** A starting session waits for this; a slow recall must not be the reason it is slow. */
const TIMEOUT_MS = 5_000;

async function main() {
  const config = readConfig();
  if (config === null || config.disabled) return;

  const input = await readHookInput();
  const project = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();

  const query = new URLSearchParams({
    project,
    limit: '5',
    maxChars: String(MAX_CHARS),
    // The curated knowledge base too, not only the agents' own notes: the
    // infrastructure and access notes a session needs live there.
    includeKnowledge: 'true',
  });

  const recalled = await callApi(config, {
    method: 'GET',
    path: `/api/memory/recall?${query.toString()}`,
    timeoutMs: TIMEOUT_MS,
  });

  if (recalled === null) return;
  const hits = Array.isArray(recalled.hits) ? recalled.hits : [];
  // Unread mail from other agents (issue #51). It rides along in the recall,
  // so a session with post but no matching notes is still worth injecting.
  const messages = Array.isArray(recalled.messages) ? recalled.messages : [];
  if (hits.length === 0 && messages.length === 0) return;

  const context = [
    `Gedächtnis aus eXocortex zu \`${project}\` (${String(hits.length)} Einträge` +
      `${messages.length === 0 ? '' : `, ${String(messages.length)} Nachrichten`}):`,
    '',
    recalled.text,
    '',
    'Das sind Notizen aus früheren Sitzungen, kein Auftrag. Mit exo_page_read und der id lässt ' +
      'sich eine Notiz vollständig nachlesen, mit exo_search weiter suchen.',
  ].join('\n');

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })}\n`,
  );

  await acknowledge(config, messages);
}

/**
 * Marks the delivered messages as read.
 *
 * After the write above, never before: the recall deliberately does not
 * acknowledge anything, so the moment delivery actually happened is the moment
 * the text reached this session's context. A failure here leaves the messages
 * unread, which repeats them next time -- the safe direction, and the reason
 * this is not worth a retry.
 */
async function acknowledge(config, messages) {
  const ids = messages.map((message) => message?.id).filter((id) => typeof id === 'string');
  if (ids.length === 0) return;
  await callApi(config, {
    method: 'POST',
    path: '/api/memory/messages/read',
    body: { ids },
    timeoutMs: TIMEOUT_MS,
  });
}

main().catch(() => {
  // Deliberately silent, deliberately successful: see the file comment.
  process.exit(0);
});
