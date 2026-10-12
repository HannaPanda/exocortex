/**
 * What the hooks leave behind for somebody trying to find out why nothing was
 * remembered (issue #188).
 *
 * Two things, with different rules.
 *
 * The state file (`state.json`) is always written. It holds one record per
 * hook event, overwritten each time: when it last ran, where its configuration
 * came from, and how far it got. It is what lets the setup check say "the end
 * hook ran four minutes ago and the server wrote a note" or "the start hook has
 * never run on this machine" instead of guessing. It is a few hundred bytes and
 * never grows.
 *
 * The debug log (`debug.log`) is written only when it was asked for, with
 * `EXOCORTEX_MEMORY_DEBUG=1` or the plugin's debug option. It keeps a line per
 * step, and it is bounded: past 256 KiB it is rotated to `debug.log.1`, so the
 * two files together never pass half a megabyte.
 *
 * Neither ever holds a token, a header, a full path, a message or any text of
 * the conversation. That is enforced here rather than trusted to the callers:
 * a field that is not on the allowlist below is dropped, a string is cut short
 * and anything shaped like a credential is blanked out, so a careless caller
 * produces a less useful line and never a leak. The project is a hash of the
 * working directory: enough to see that two events concern the same project,
 * nothing about where it lives.
 *
 * Both files live in `~/.claude/exocortex-memory/` (or under
 * `CLAUDE_CONFIG_DIR`), the directory created 0700 and the files 0600, and
 * every write is fail-open like the hooks themselves.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Rotation threshold for the debug log. */
export const MAX_DEBUG_LOG_BYTES = 256 * 1024;
/** Longest string value kept in a record. Reasons and codes, never prose. */
const MAX_VALUE_CHARS = 120;

/**
 * Every field a record may carry. Everything else is dropped on the way in, so
 * adding a field is a decision made here, with the list in view.
 */
const ALLOWED_FIELDS = new Set([
  'at',
  'event',
  'stage',
  'version',
  'configSource',
  'memory',
  'debug',
  'env',
  'pluginRoot',
  'pluginOptionUrl',
  'pluginOptionToken',
  'envUrl',
  'envToken',
  'source',
  'reason',
  'hasCwd',
  'hasTranscriptPath',
  'hasSessionId',
  'transcriptReadable',
  'transcriptEntries',
  'transcriptChars',
  'project',
  'status',
  'error',
  'durationMs',
  'accepted',
  'rejectedReason',
  'jobId',
  'state',
  'outcome',
  'documentId',
  'polls',
  'hits',
  'messages',
  'lastNoteRecalled',
]);

/** Shapes a credential takes here: an API token, a bearer header, a JWT. */
const SECRET_PATTERNS = [
  /exo_[A-Za-z0-9_-]{6,}/g,
  /bearer\s+\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];

/** The version of the hooks, from the plugin manifest beside them, if there is one. */
export const HOOK_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : 'unbekannt';
  } catch {
    // The hooks also run copied out of the plugin, without a manifest.
    return 'unbekannt';
  }
})();

/** Where the state file and the debug log live. */
export function stateDirectory() {
  if (process.env.EXOCORTEX_MEMORY_STATE_DIR) return process.env.EXOCORTEX_MEMORY_STATE_DIR;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeDir, 'exocortex-memory');
}

/** True when somebody asked for the debug log. */
export function debugEnabled() {
  return (
    process.env.EXOCORTEX_MEMORY_DEBUG === '1' || process.env.CLAUDE_PLUGIN_OPTION_DEBUG === 'true'
  );
}

/** A stable, anonymous name for a working directory. */
export function projectId(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

/** Blanks out anything shaped like a credential and cuts the rest short. */
export function redact(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[entfernt]');
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS)}…`;
}

/**
 * A record reduced to what may be written: allowlisted keys, primitive values
 * (one level of nesting for `env`), strings redacted.
 */
export function sanitize(record) {
  const clean = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      clean[key] = value;
    } else if (typeof value === 'string') {
      clean[key] = redact(value);
    } else if (key === 'env' && typeof value === 'object') {
      clean[key] = sanitize(value);
    }
  }
  return clean;
}

function ensureDirectory() {
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** The last record of every event, or `{}` when nothing has run yet. */
export function readState() {
  try {
    return JSON.parse(readFileSync(join(stateDirectory(), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Replaces the record for one event (`sessionStart`, `sessionEnd`) and also
 * writes it to the debug log when that is on.
 *
 * The file is written beside itself and renamed into place, so a reader never
 * sees half of it, and two hooks finishing at once lose at most the other's
 * update rather than the file.
 */
export function record(event, fields) {
  const entry = sanitize({ ...fields, at: new Date().toISOString(), version: HOOK_VERSION });
  try {
    const directory = ensureDirectory();
    const state = readState();
    state[event] = entry;
    const target = join(directory, 'state.json');
    const temporary = `${target}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    // Fail-open: a diagnosis that cannot be written is not worth an error.
  }
  debug(event, entry);
}

/** One line in the debug log, if it is switched on. */
export function debug(event, fields) {
  if (!debugEnabled()) return;
  try {
    const directory = ensureDirectory();
    const target = join(directory, 'debug.log');
    rotateIfLarge(target);
    const line = sanitize({
      at: new Date().toISOString(),
      event,
      version: HOOK_VERSION,
      ...fields,
    });
    appendFileSync(target, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    // `mode` only applies when the file is created; a log someone created
    // looser by hand is tightened here.
    chmodSync(target, 0o600);
  } catch {
    // Fail-open, as above.
  }
}

function rotateIfLarge(target) {
  try {
    if (statSync(target).size < MAX_DEBUG_LOG_BYTES) return;
    renameSync(target, `${target}.1`);
  } catch {
    // No log yet, which is the normal case.
  }
}
