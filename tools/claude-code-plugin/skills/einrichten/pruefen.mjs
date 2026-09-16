#!/usr/bin/env node
/**
 * The setup check behind `/exocortex:einrichten`.
 *
 * Everything the skill needs to say is decided here rather than in prose,
 * because the useful answer is never "it does not work": it is which of four
 * things is wrong. The script prints a report a person can read on its own and
 * a model can act on, and it never prints the token.
 *
 * Unlike the hooks it is loud: this is the one moment where a failure is the
 * point of running it.
 */

import { describeConfig } from '../../hooks/config.mjs';

const TIMEOUT_MS = 8_000;

/** One HTTP call, every failure turned into a reason a person can read. */
async function call(url, { token, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    const reason =
      error?.name === 'AbortError' ? 'Zeitüberschreitung' : String(error?.cause ?? error);
    return { status: 0, text: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** What a status code means here, in the words of the thing that has to change. */
function diagnose(status, text) {
  if (status === 0) return `Keine Verbindung: ${text}. Stimmt die Adresse, läuft der Dienst?`;
  if (status === 401 || status === 403) {
    return 'Das Token wird abgelehnt. Es ist abgelaufen, widerrufen, oder es gehört zu einer anderen Adresse. Ein neues gibt es unter Einstellungen, Verbindungen.';
  }
  if (status === 404) {
    return 'Die Adresse antwortet, kennt den Pfad aber nicht. Meist steht in der Adresse ein Pfad zu viel: sie endet ohne /api und ohne Schrägstrich.';
  }
  if (status >= 500)
    return `Der Dienst antwortet mit ${String(status)}. Das ist ein Fehler auf der Gegenseite, nicht in der Einrichtung.`;
  return `Unerwartete Antwort ${String(status)}: ${text.slice(0, 200)}`;
}

const lines = [];
const say = (line) => lines.push(line);
let failed = false;

const config = describeConfig();

say('## Konfiguration');
if (!config.found) {
  failed = true;
  say('Keine gefunden.');
  say('');
  say(
    'Zu tun: `/plugin` öffnen, eXocortex auswählen, Konfigurieren, dann Adresse und Token eintragen.',
  );
  say(
    'Ein Token gibt es in der Oberfläche unter Einstellungen, Verbindungen, mit dem Recht "Lesen und schreiben".',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(1);
}

say(`- Quelle: ${config.source}`);
say(`- Adresse: ${config.apiUrl}`);
say(`- Token: ${config.tokenPreview}`);
say(`- Mitschrieb: ${config.memoryOff ? 'aus' : 'an'}`);

const token = process.env.EXOCORTEX_API_TOKEN ?? process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? null;
// `describeConfig` deliberately hides the token, so the one case it cannot
// check is a token that lives in a file. Reading it here would duplicate the
// lookup; instead the check runs against what the process was given.
const secret = token ?? (await readTokenFromSources());

say('');
say('## MCP-Werkzeuge');
const tools = await call(`${config.apiUrl}/api/mcp`, {
  token: secret,
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
});
if (tools.status === 200) {
  let count = null;
  try {
    count = JSON.parse(tools.text)?.result?.tools?.length ?? null;
  } catch {
    count = null;
  }
  if (count === null) {
    failed = true;
    say(`Antwort verstanden, aber keine Werkzeugliste darin: ${tools.text.slice(0, 200)}`);
  } else {
    say(`${String(count)} Werkzeuge erreichbar.`);
  }
} else {
  failed = true;
  say(diagnose(tools.status, tools.text));
}

say('');
say('## Gedächtnis');
if (config.memoryOff) {
  say('Abgeschaltet, also nichts zu prüfen. Wieder an geht es über die Plugin-Konfiguration.');
} else {
  const project = process.cwd();
  const query = new URLSearchParams({ project, limit: '1', maxChars: '500' });
  const recall = await call(`${config.apiUrl}/api/memory/recall?${query.toString()}`, {
    token: secret,
  });
  if (recall.status === 200) {
    let hits = null;
    try {
      hits = JSON.parse(recall.text)?.hits?.length ?? null;
    } catch {
      hits = null;
    }
    say(
      hits === null || hits === 0
        ? `Erreichbar. Zu ${project} gibt es noch keine Erinnerungen, das ist bei der ersten Sitzung normal.`
        : `Erreichbar, ${String(hits)} Erinnerung(en) zu ${project}.`,
    );
  } else {
    failed = true;
    say(diagnose(recall.status, recall.text));
    if (recall.status === 403) {
      say('Ein Token mit "Nur lesen" reicht hier nicht: der Mitschrieb schreibt.');
    }
  }
}

say('');
say(failed ? '**Ergebnis: noch nicht fertig.**' : '**Ergebnis: fertig, die Verbindung steht.**');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(failed ? 1 : 0);

/**
 * The token when it lives in a file rather than in the environment. Kept at the
 * bottom because it is the uncommon case, and kept separate from
 * `describeConfig` so that the masked report stays the only thing that is
 * printed.
 */
async function readTokenFromSources() {
  const { readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };
  const home = homedir();
  const ownFile = read(join(home, '.claude', 'exocortex-memory.json'));
  if (ownFile?.token) return String(ownFile.token);
  const claudeConfig = read(join(home, '.claude.json'));
  const fromMcp = claudeConfig?.mcpServers?.exocortex?.env?.EXOCORTEX_API_TOKEN;
  return fromMcp ? String(fromMcp) : '';
}
