#!/usr/bin/env node
/**
 * The setup check behind `/exocortex:einrichten`.
 *
 * Everything the skill needs to say is decided here rather than in prose,
 * because the useful answer is never "it does not work": it is which link of
 * the chain is broken (issue #188). The chain, in order:
 *
 *   configuration  where URL and token come from
 *   hooks          registered once, and actually seen running on this machine
 *   MCP            the tools answer
 *   memory API     recall answers with this token
 *   end to end     a capture is accepted, distilled, written and recalled
 *
 * One limit shapes the report. A token entered in the plugin's configuration
 * is handed to the hooks and the MCP server, never to a Bash command, so this
 * script cannot see it. That is why the hooks leave a state file behind
 * (`hooks/diagnostics.mjs`): the hooks section reads what they observed, and
 * for the plugin case it is the evidence that matters. The model running the
 * skill checks the MCP tools itself.
 *
 * It never prints the token, and nothing from the state file that could be
 * one: that file holds codes and counts by construction.
 *
 * `--ende-zu-ende` adds the end-to-end test. It sends a short, marked test
 * session under its own project name (`exocortex-selbsttest`), so it lands
 * next to nothing real, follows the job until the server has decided, checks
 * that recall finds the note, and archives the note again.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describeConfig } from '../../hooks/config.mjs';
import { HOOK_VERSION, readState, stateDirectory } from '../../hooks/diagnostics.mjs';

const TIMEOUT_MS = 8_000;
const SELF_TEST_PROJECT = 'exocortex-selbsttest';
const endToEnd = process.argv.includes('--ende-zu-ende');

/** One HTTP call, every failure turned into a reason a person can read. */
async function call(url, { token, method, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
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

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
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

/** What one recorded stage means, and what to do about it. */
const STAGE_TEXT = {
  disabled: 'Mitschrieb abgeschaltet, der Hook tut absichtlich nichts.',
  no_config:
    'Der Hook lief, fand aber keine Adresse und kein Token. Plugin-Konfiguration prüfen (`/plugin`, eXocortex, Konfigurieren).',
  recall_failed: 'Der Abruf der Erinnerungen ist gescheitert.',
  recalled_nothing:
    'Abruf in Ordnung, zu diesem Verzeichnis gab es nur noch nichts. Bei der ersten Sitzung normal.',
  recalled: 'Abruf in Ordnung, Erinnerungen wurden eingespielt.',
  skipped_logout: 'Beim Abmelden wird absichtlich nichts mitgeschrieben.',
  no_transcript_path: 'Claude Code hat keinen Pfad zum Mitschrieb übergeben.',
  spawn_failed: 'Der Hook konnte den Übertragungsprozess nicht starten.',
  dispatched:
    'Übergeben, die Übertragung lief danach im Hintergrund weiter. Hat sie nichts hinterlassen, wurde sie abgebrochen, bevor sie den Server erreicht hat.',
  transcript_unreadable: 'Die Mitschrift war nicht lesbar.',
  transcript_empty: 'Nach dem Herausfiltern von Werkzeugaufrufen blieb kein Text übrig.',
  capture_failed: 'Das Hochladen der Sitzung ist gescheitert.',
  capture_rejected: 'Der Server hat die Sitzung nicht angenommen.',
  queued: 'Angenommen und eingereiht. Ein Ergebnis kam noch nicht zurück.',
  still_pending:
    'Angenommen, aber nach vier Minuten noch nicht verarbeitet. Läuft der Worker (exocortex-worker)?',
  status_unavailable:
    'Angenommen. Dieser Server ist älter als der Statusabruf, mehr lässt sich hier nicht sehen.',
  processed: 'Vom Server verarbeitet.',
};

const OUTCOME_TEXT = {
  written: 'Notiz geschrieben.',
  nothing_to_remember:
    'Das Modell fand nichts Merkenswertes. Kein Fehler: kurze oder reine Plauder-Sitzungen bleiben so absichtlich leer.',
  feature_disabled: 'KI oder Gedächtnis waren auf dem Server abgeschaltet, als der Job lief.',
  service_token_missing:
    'Dem Worker fehlt SERVICE_TOKEN_SECRET, er kann für niemanden schreiben. Das ist auf dem Server zu beheben.',
  distill_failed:
    'Der Modellaufruf ist gescheitert (Anbieter, Modell oder Zeitlimit). Im Log von exocortex-worker steht der Grund.',
  write_failed: 'Das Modell hat geantwortet, aber die Notiz ließ sich nicht speichern.',
};

const REJECTED_TEXT = {
  transcript_too_short:
    'zu kurz. Alles unter `memory.captureMinChars` Zeichen (Standard 600) wird absichtlich verworfen.',
  memory_disabled: 'das Gedächtnis ist in diesem Arbeitsbereich abgeschaltet (`memory.enabled`).',
  memory_workspace_not_configured:
    'für dieses Konto gibt es keinen Memory-Arbeitsbereich. Ein Admin muss einen Arbeitsbereich als Memory markieren.',
};

function ago(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return 'zu unbekannter Zeit';
  if (seconds < 90) return `vor ${String(seconds)} s`;
  if (seconds < 5400) return `vor ${String(Math.round(seconds / 60))} min`;
  if (seconds < 129_600) return `vor ${String(Math.round(seconds / 3600))} h`;
  return `vor ${String(Math.round(seconds / 86_400))} Tagen`;
}

/** The detail lines for one recorded event, beyond its stage. */
function eventDetails(entry) {
  const details = [];
  if (entry.env !== undefined && entry.stage === 'no_config') {
    details.push(
      `Plugin-Adresse übergeben: ${entry.env.pluginOptionUrl ? 'ja' : 'nein'}, ` +
        `Plugin-Token übergeben: ${entry.env.pluginOptionToken ? 'ja' : 'nein'}`,
    );
  }
  if (typeof entry.status === 'number' && entry.status !== 200 && entry.status !== 0) {
    details.push(diagnose(entry.status, ''));
  }
  if (entry.error === 'timeout') details.push('Zeitüberschreitung beim Server.');
  if (entry.error === 'network') details.push('Keine Verbindung zur Adresse.');
  if (typeof entry.transcriptChars === 'number') {
    details.push(`Mitschrift: ${String(entry.transcriptChars)} Zeichen nach dem Filtern`);
  }
  if (entry.stage === 'capture_rejected') {
    const reason = entry.rejectedReason ?? 'ohne Grund';
    details.push(`Abgelehnt: ${REJECTED_TEXT[reason] ?? reason}`);
  }
  if (entry.stage === 'processed') details.push(processedDetail(entry));
  if (typeof entry.hits === 'number') details.push(`Treffer: ${String(entry.hits)}`);
  if (entry.lastNoteRecalled === true) {
    details.push('Die zuletzt geschriebene Notiz kam dabei zurück.');
  }
  if (entry.lastNoteRecalled === false) {
    details.push(
      'Die zuletzt geschriebene Notiz war nicht unter den Treffern zu diesem Verzeichnis.',
    );
  }
  return details;
}

function processedDetail(entry) {
  if (entry.state === 'completed') {
    return `Ergebnis: ${OUTCOME_TEXT[entry.outcome] ?? 'abgeschlossen, ohne Angabe.'}`;
  }
  if (entry.state === 'failed')
    return `Der Job ist gescheitert: ${entry.rejectedReason ?? 'ohne Grund'}`;
  return 'Der Server kennt den Job nicht mehr.';
}

const BROKEN_STAGES = new Set([
  'no_config',
  'recall_failed',
  'spawn_failed',
  'transcript_unreadable',
  'capture_failed',
  'still_pending',
  'no_transcript_path',
]);
const BROKEN_OUTCOMES = new Set([
  'feature_disabled',
  'service_token_missing',
  'distill_failed',
  'write_failed',
]);

/** True when the event stopped at a link of the chain that is broken. */
function isBroken(entry) {
  if (BROKEN_STAGES.has(entry.stage)) return true;
  if (entry.stage !== 'processed') return false;
  return entry.state === 'failed' || BROKEN_OUTCOMES.has(entry.outcome);
}

/** Reports one recorded event; returns true when it points at a fault. */
function describeEvent(say, label, entry) {
  if (entry === undefined) {
    say(`- ${label}: noch nie beobachtet.`);
    return false;
  }
  say(`- ${label}: zuletzt ${ago(entry.at)}, Version ${String(entry.version)}`);
  say(`  - ${STAGE_TEXT[entry.stage] ?? `Stand: ${String(entry.stage)}`}`);
  for (const detail of eventDetails(entry)) say(`  - ${detail}`);
  return isBroken(entry);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Settings files that register the hooks by hand, outside the plugin. */
function handRegistrations() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const candidates = [
    join(claudeDir, 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  return candidates.filter((path) => {
    const settings = readJson(path);
    return JSON.stringify(settings?.hooks ?? {}).includes('session-end.mjs');
  });
}

function pluginInstalled() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const installed = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const entries = installed?.plugins?.['exocortex@exocortex'];
  return Array.isArray(entries) && entries.length > 0 ? String(entries[0].version) : null;
}

/**
 * The token, when it lives somewhere this process can read: the environment or
 * one of the two files. Never the plugin's, which only reaches hooks and MCP.
 */
function readableToken() {
  if (process.env.EXOCORTEX_API_TOKEN) return process.env.EXOCORTEX_API_TOKEN;
  if (process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN) return process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN;
  const home = homedir();
  const ownFile = readJson(join(home, '.claude', 'exocortex-memory.json'));
  if (ownFile?.token) return String(ownFile.token);
  const fromMcp = readJson(join(home, '.claude.json'))?.mcpServers?.exocortex?.env
    ?.EXOCORTEX_API_TOKEN;
  return fromMcp ? String(fromMcp) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session long enough to pass `memory.captureMinChars`, and plainly a test. */
function selfTestTranscript(marker) {
  return [
    `user: Selbsttest ${marker} von /exocortex:einrichten. Bitte merken: Die Verbindung zwischen Claude Code und eXocortex wurde am ${new Date().toISOString().slice(0, 10)} geprüft, Kennung ${marker}.`,
    'assistant: Verstanden. Festgehalten wird: Der Mitschrieb von Claude Code nach eXocortex wurde mit einem Selbsttest geprüft. Die Sitzung lief über den SessionEnd-Weg, die Notiz soll im Memory-Arbeitsbereich landen und beim nächsten Start über den Abruf wiederkommen.',
    `user: Gut. Entscheidung: Der Selbsttest ${marker} gilt als bestanden, sobald die Notiz beim Abruf auftaucht. Danach wird sie wieder archiviert.`,
    'assistant: Notiert. Offener Punkt: keiner. Ergebnis des Selbsttests steht nach der Verdichtung fest. Die Testnotiz ist eindeutig markiert und wird nach dem Abruf archiviert, damit sie keine echten Erinnerungen verdrängt.',
  ].join('\n\n');
}

/** Step 1: hands the test session over. Returns the job id, or null after saying why not. */
async function upload(say, apiUrl, token, marker) {
  const captured = await call(`${apiUrl}/api/memory/capture`, {
    token,
    body: {
      project: SELF_TEST_PROJECT,
      client: 'claude-code',
      sessionId: marker,
      hint: 'Selbsttest der Einrichtung',
      transcript: selfTestTranscript(marker),
    },
  });
  if (captured.status < 200 || captured.status >= 300) {
    say(`1. Hochladen: ${diagnose(captured.status, captured.text)}`);
    return null;
  }
  const answer = json(captured.text);
  if (answer?.accepted !== true) {
    const reason = answer?.reason ?? 'ohne Grund';
    say(`1. Hochladen: abgelehnt, ${REJECTED_TEXT[reason] ?? reason}`);
    return null;
  }
  say(`1. Hochladen: angenommen (Job ${String(answer.jobId)}).`);
  if (typeof answer.jobId === 'string') return answer.jobId;
  say('2. Verarbeitung: der Server hat keine Job-Kennung genannt, mehr lässt sich nicht prüfen.');
  return null;
}

/** Step 2: waits for the worker. Returns the final status, or null after saying why not. */
async function awaitJob(say, apiUrl, token, jobId) {
  let status = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(3000);
    const polled = await call(`${apiUrl}/api/memory/capture/${encodeURIComponent(jobId)}`, {
      token,
    });
    if (polled.status === 404) {
      say('2. Verarbeitung: dieser Server kennt den Statusabruf noch nicht (älter als 1.1.0).');
      return null;
    }
    status = json(polled.text);
    if (['completed', 'failed', 'not_found'].includes(status?.state)) break;
  }
  if (status?.state === 'completed') {
    say(`2. Verarbeitung: ${OUTCOME_TEXT[status.outcome] ?? 'abgeschlossen, ohne Angabe.'}`);
    return status;
  }
  say(
    status?.state === 'failed'
      ? `2. Verarbeitung: der Job ist gescheitert: ${String(status.reason)}`
      : '2. Verarbeitung: nach zwei Minuten kein Ergebnis. Läuft der Worker (exocortex-worker)?',
  );
  return null;
}

/** Step 3: true once recall returns the note. The search index may lag a little. */
async function recalls(apiUrl, token, documentId) {
  const query = new URLSearchParams({ project: SELF_TEST_PROJECT, limit: '5', maxChars: '500' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const recalled = json(
      (await call(`${apiUrl}/api/memory/recall?${query.toString()}`, { token })).text,
    );
    if ((recalled?.hits ?? []).some((hit) => hit?.documentId === documentId)) return true;
    await sleep(3000);
  }
  return false;
}

async function runEndToEnd(say, apiUrl, token) {
  const jobId = await upload(say, apiUrl, token, `selbsttest-${Date.now().toString(36)}`);
  if (jobId === null) return false;
  const status = await awaitJob(say, apiUrl, token, jobId);
  if (status === null) return false;
  if (status.outcome === 'nothing_to_remember') {
    say(
      '3. Abruf: übersprungen. Die Kette bis zum Modell steht, es hat diesmal nur nichts behalten.',
    );
    return true;
  }
  if (status.outcome !== 'written' || typeof status.documentId !== 'string') return false;

  const found = await recalls(apiUrl, token, status.documentId);
  say(
    found
      ? '3. Abruf: die Notiz kommt beim Abruf zurück.'
      : '3. Abruf: geschrieben, aber nach 30 Sekunden noch nicht auffindbar. Der Suchindex hinkt hinterher oder ist ausgefallen.',
  );

  const archived = await call(`${apiUrl}/api/documents/${status.documentId}/archive`, {
    token,
    method: 'POST',
  });
  say(
    archived.status >= 200 && archived.status < 300
      ? '4. Aufräumen: Testnotiz archiviert.'
      : `4. Aufräumen: Archivieren ging nicht (${String(archived.status)}). Die Seite heißt nach dem Selbsttest und liegt unter ${SELF_TEST_PROJECT}.`,
  );
  return found;
}

const lines = [];
const say = (line) => lines.push(line);
let failed = false;

const config = describeConfig();
const token = readableToken();

say('## Konfiguration');
if (config.found) {
  say(`- Quelle: ${config.source}`);
  say(`- Adresse: ${config.apiUrl}`);
  say(`- Token: ${config.tokenPreview}`);
  say(`- Mitschrieb: ${config.memoryOff ? 'aus' : 'an'}`);
} else {
  say(
    'Für dieses Skript nicht sichtbar. Das ist beim Plugin normal: ein dort eingetragenes Token bekommen nur Hooks und MCP-Server, kein Bash-Befehl. Ob die Hooks es haben, steht im nächsten Abschnitt.',
  );
}

say('');
say('## Hooks');
const installedVersion = pluginInstalled();
const byHand = handRegistrations();
say(
  `- Plugin: ${installedVersion === null ? 'nicht installiert' : `installiert, Version ${installedVersion}`} (diese Hooks: ${HOOK_VERSION})`,
);
if (byHand.length > 0) {
  say(`- Von Hand eingetragen in: ${byHand.join(', ')}`);
}
if (installedVersion !== null && byHand.length > 0) {
  failed = true;
  say(
    '- Doppelt registriert: Plugin und settings.json. Jede Sitzung würde zweimal mitgeschrieben. Einen der beiden Wege entfernen.',
  );
}
if (installedVersion === '1.0.0') {
  failed = true;
  say(
    '- Version 1.0.0 verliert den Mitschrieb beim Beenden (Claude Code bricht Plugin-Hooks dort nach 1,5 s ab). Aktualisieren: `/plugin marketplace update exocortex`, dann `/plugin update exocortex@exocortex` und Claude Code neu starten.',
  );
}
const state = readState();
say(`- Zustandsbericht: ${join(stateDirectory(), 'state.json')}`);
if (describeEvent(say, 'Sitzungsstart', state.sessionStart)) failed = true;
if (describeEvent(say, 'Sitzungsende', state.sessionEnd)) failed = true;
if (state.sessionStart === undefined && state.sessionEnd === undefined) {
  say(
    '- Noch kein Hook-Lauf aufgezeichnet. Nach dem Installieren oder Aktualisieren einmal Claude Code neu starten, dann mit `/exit` beenden, neu starten und erneut prüfen.',
  );
}

if (token === null || !config.found) {
  say('');
  say('## MCP-Werkzeuge und Gedächtnis-API');
  say(
    'Von hier aus nicht prüfbar, das Token steckt nur in der Plugin-Konfiguration. Die Werkzeuge prüft Claude direkt; für das Gedächtnis zählt der Hook-Bericht oben.',
  );
} else {
  say('');
  say('## MCP-Werkzeuge');
  const tools = await call(`${config.apiUrl}/api/mcp`, {
    token,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  if (tools.status === 200) {
    const count = json(tools.text)?.result?.tools?.length ?? null;
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
  say('## Gedächtnis-API');
  if (config.memoryOff) {
    say('Abgeschaltet, also nichts zu prüfen. Wieder an geht es über die Plugin-Konfiguration.');
  } else {
    const project = process.cwd();
    const query = new URLSearchParams({ project, limit: '1', maxChars: '500' });
    const recall = await call(`${config.apiUrl}/api/memory/recall?${query.toString()}`, { token });
    if (recall.status === 200) {
      const hits = json(recall.text)?.hits?.length ?? null;
      say(
        hits === null || hits === 0
          ? 'Erreichbar. Zu diesem Verzeichnis gibt es noch keine Erinnerungen, das ist bei der ersten Sitzung normal.'
          : `Erreichbar, ${String(hits)} Erinnerung(en) zu diesem Verzeichnis.`,
      );
    } else {
      failed = true;
      say(diagnose(recall.status, recall.text));
      if (recall.status === 403) {
        say('Ein Token mit "Nur lesen" reicht hier nicht: der Mitschrieb schreibt.');
      }
    }

    if (endToEnd) {
      say('');
      say('## Ende zu Ende');
      if (!(await runEndToEnd(say, config.apiUrl, token))) failed = true;
    }
  }
}

say('');
say(failed ? '**Ergebnis: noch nicht fertig.**' : '**Ergebnis: fertig, soweit von hier prüfbar.**');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(failed ? 1 : 0);
