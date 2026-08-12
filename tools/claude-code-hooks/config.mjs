/**
 * Where the hooks find the deployment and their credential.
 *
 * Three sources, in this order, so that the common case needs no setup at all:
 *
 *  1. the environment (`EXOCORTEX_API_URL`, `EXOCORTEX_API_TOKEN`)
 *  2. `~/.claude/exocortex-memory.json`
 *  3. the MCP server entry in `~/.claude.json`
 *
 * Three matters more than it looks: whoever connects eXocortex to Claude Code
 * already put a URL and a token into the MCP server entry, and asking for the
 * same two values a second time is where a setup gets abandoned. The hooks
 * simply read what is already there.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {{ apiUrl: string, token: string, disabled: boolean }} HookConfig */

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A missing or unreadable file is the normal case for two of the three
    // sources, so it is not worth a word on stderr.
    return null;
  }
}

/**
 * Reads the configuration, or returns `null` when this machine has no
 * eXocortex to talk to. `null` is not an error: a hook that finds no
 * configuration does nothing at all.
 *
 * @returns {HookConfig | null}
 */
export function readConfig() {
  if (process.env.EXOCORTEX_MEMORY_DISABLED === '1') return null;

  const home = homedir();

  const fromEnv = {
    apiUrl: process.env.EXOCORTEX_API_URL,
    token: process.env.EXOCORTEX_API_TOKEN,
  };
  if (fromEnv.apiUrl && fromEnv.token) {
    return { apiUrl: trimUrl(fromEnv.apiUrl), token: fromEnv.token, disabled: false };
  }

  const ownFile = readJsonFile(join(home, '.claude', 'exocortex-memory.json'));
  if (ownFile && ownFile.apiUrl && ownFile.token) {
    return {
      apiUrl: trimUrl(String(ownFile.apiUrl)),
      token: String(ownFile.token),
      disabled: ownFile.disabled === true,
    };
  }

  const claudeConfig = readJsonFile(join(home, '.claude.json'));
  const serverEnv = claudeConfig?.mcpServers?.exocortex?.env;
  if (serverEnv?.EXOCORTEX_API_URL && serverEnv?.EXOCORTEX_API_TOKEN) {
    return {
      apiUrl: trimUrl(String(serverEnv.EXOCORTEX_API_URL)),
      token: String(serverEnv.EXOCORTEX_API_TOKEN),
      disabled: false,
    };
  }

  return null;
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
 * One HTTP call with a hard timeout.
 *
 * Every failure comes back as `null` rather than as an exception: a hook runs
 * inside somebody's editing session, and a memory that could not be written or
 * read is never worth interrupting that session for.
 *
 * @returns {Promise<unknown | null>}
 */
export async function callApi(config, { method, path, body, timeoutMs }) {
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
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
