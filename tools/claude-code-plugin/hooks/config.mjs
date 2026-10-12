/**
 * Where the hooks find the deployment and their credential.
 *
 * Four sources, in this order, so that the common case needs no setup at all:
 *
 *  1. the environment (`EXOCORTEX_API_URL`, `EXOCORTEX_API_TOKEN`)
 *  2. the plugin's own configuration (`CLAUDE_PLUGIN_OPTION_API_URL`,
 *     `CLAUDE_PLUGIN_OPTION_API_TOKEN`), which Claude Code asks for once when
 *     the plugin is enabled and keeps in its credential store
 *  3. `~/.claude/exocortex-memory.json`
 *  4. the MCP server entry in `~/.claude.json`
 *
 * Two and four matter more than they look. Whoever installs the plugin answers
 * two questions and is done; whoever wired the MCP server up by hand already
 * put a URL and a token into `~/.claude.json`, and asking for the same two
 * values a second time is where a setup gets abandoned. The hooks simply read
 * what is already there.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { record } from './diagnostics.mjs';

/** @typedef {{ apiUrl: string, token: string, disabled: boolean }} HookConfig */

/**
 * Where a configuration was found, as a code for the diagnostics (which must
 * never carry the values) and as words for the setup check.
 */
export const SOURCE_LABELS = {
  env: 'Umgebungsvariablen EXOCORTEX_API_URL und EXOCORTEX_API_TOKEN',
  plugin: 'Konfiguration des Plugins (/plugin, eXocortex, Konfigurieren)',
  file: '~/.claude/exocortex-memory.json',
  mcp_entry: 'MCP-Server-Eintrag exocortex in ~/.claude.json',
};

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A missing or unreadable file is the normal case for two of the four
    // sources, so it is not worth a word on stderr.
    return null;
  }
}

/**
 * The configuration and where it was found, or `null` when this machine has no
 * eXocortex to talk to.
 *
 * The source is carried along because it is the first thing a person needs when
 * setup went wrong: "no configuration found" and "found it in a file you forgot
 * about" look identical from the outside.
 *
 * @returns {{ config: HookConfig, source: keyof typeof SOURCE_LABELS } | null}
 */
export function locate() {
  const home = homedir();

  const fromEnv = {
    apiUrl: process.env.EXOCORTEX_API_URL,
    token: process.env.EXOCORTEX_API_TOKEN,
  };
  if (fromEnv.apiUrl && fromEnv.token) {
    return {
      config: { apiUrl: trimUrl(fromEnv.apiUrl), token: fromEnv.token, disabled: false },
      source: 'env',
    };
  }

  const fromPlugin = {
    apiUrl: process.env.CLAUDE_PLUGIN_OPTION_API_URL,
    token: process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN,
  };
  if (fromPlugin.apiUrl && fromPlugin.token) {
    return {
      config: { apiUrl: trimUrl(fromPlugin.apiUrl), token: fromPlugin.token, disabled: false },
      source: 'plugin',
    };
  }

  const ownFile = readJsonFile(join(home, '.claude', 'exocortex-memory.json'));
  if (ownFile && ownFile.apiUrl && ownFile.token) {
    return {
      config: {
        apiUrl: trimUrl(String(ownFile.apiUrl)),
        token: String(ownFile.token),
        disabled: ownFile.disabled === true,
      },
      source: 'file',
    };
  }

  const claudeConfig = readJsonFile(join(home, '.claude.json'));
  const serverEnv = claudeConfig?.mcpServers?.exocortex?.env;
  if (serverEnv?.EXOCORTEX_API_URL && serverEnv?.EXOCORTEX_API_TOKEN) {
    return {
      config: {
        apiUrl: trimUrl(String(serverEnv.EXOCORTEX_API_URL)),
        token: String(serverEnv.EXOCORTEX_API_TOKEN),
        disabled: false,
      },
      source: 'mcp_entry',
    };
  }

  return null;
}

/** True when something switched the memory off before any source was read. */
export function switchedOff() {
  if (process.env.EXOCORTEX_MEMORY_DISABLED === '1') return true;
  // The plugin's own off switch, for somebody who wants the MCP server the
  // plugin brings but not the note at the end of every session. `false` is what
  // Claude Code writes for a boolean option that was answered with no.
  return process.env.CLAUDE_PLUGIN_OPTION_MEMORY === 'false';
}

/**
 * The configuration a hook runs with, or `null` after recording why there is
 * none: switched off, or nothing found. The record names which variables were
 * present, never their values (issue #188).
 *
 * @returns {{ config: HookConfig, base: Record<string, unknown> } | null}
 */
export function configForHook(event) {
  const off = switchedOff();
  const located = off ? null : locate();
  const base = { env: environmentPresence(), configSource: located?.source ?? null };
  if (off || located?.config.disabled === true) {
    record(event, { ...base, memory: 'off', stage: 'disabled' });
    return null;
  }
  if (located === null) {
    record(event, { ...base, memory: 'on', stage: 'no_config' });
    return null;
  }
  return { config: located.config, base: { ...base, memory: 'on' } };
}

/**
 * Reads the configuration, or returns `null` when this machine has no
 * eXocortex to talk to. `null` is not an error: a hook that finds no
 * configuration does nothing at all.
 *
 * @returns {HookConfig | null}
 */
export function readConfig() {
  if (switchedOff()) return null;
  return locate()?.config ?? null;
}

/**
 * What the setup skill reports back to a person. The token is never part of it:
 * a check that prints the secret it is checking is a check that leaks it into a
 * transcript.
 *
 * @returns {{ found: boolean, source: string | null, apiUrl: string | null,
 *   memoryOff: boolean, tokenPreview: string | null }}
 */
export function describeConfig() {
  const located = locate();
  return {
    found: located !== null,
    source: located === null ? null : SOURCE_LABELS[located.source],
    apiUrl: located?.config.apiUrl ?? null,
    memoryOff: switchedOff() || located?.config.disabled === true,
    tokenPreview: located === null ? null : maskToken(located.config.token),
  };
}

/**
 * Which of the variables a hook could be configured by are set, as booleans.
 *
 * Never the values. This is what tells "Claude Code did not hand the plugin's
 * token to the hook" (issue #188) apart from "nothing was configured at all".
 */
export function environmentPresence() {
  const present = (name) => typeof process.env[name] === 'string' && process.env[name].length > 0;
  return {
    pluginRoot: present('CLAUDE_PLUGIN_ROOT'),
    pluginOptionUrl: present('CLAUDE_PLUGIN_OPTION_API_URL'),
    pluginOptionToken: present('CLAUDE_PLUGIN_OPTION_API_TOKEN'),
    envUrl: present('EXOCORTEX_API_URL'),
    envToken: present('EXOCORTEX_API_TOKEN'),
  };
}

/** Enough of a token to recognize it, never enough to use it. */
function maskToken(token) {
  if (token.length <= 10) return '…';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function trimUrl(url) {
  return url.replace(/\/+$/, '');
}

/** Reads the hook's JSON payload from stdin. Returns `{}` when there is none. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * One HTTP call with a hard timeout, and what became of it.
 *
 * Every failure comes back as a value rather than as an exception: a hook runs
 * inside somebody's editing session, and a memory that could not be written or
 * read is never worth interrupting that session for. The failure is named by
 * class only (`timeout`, `network`, `http`, `invalid_json`), because an error
 * message can quote a URL, and the diagnostics must not.
 *
 * @returns {Promise<{ ok: boolean, status: number, data: unknown,
 *   error: 'timeout' | 'network' | 'http' | 'invalid_json' | null }>}
 */
export async function requestApi(config, { method, path, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, data: null, error: 'http' };
    try {
      return { ok: true, status: response.status, data: await response.json(), error: null };
    } catch {
      return { ok: false, status: response.status, data: null, error: 'invalid_json' };
    }
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === 'AbortError';
    return { ok: false, status: 0, data: null, error: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** `requestApi` for callers that only want the answer, or `null`. */
export async function callApi(config, request) {
  const result = await requestApi(config, request);
  return result.ok ? result.data : null;
}
