/**
 * Which part of the product a tool belongs to, and which parts one task needs
 * (issue #121).
 *
 * The catalogue is 172 tools and 144,285 characters of JSON schema. An MCP
 * client pays that once, at the handshake. The built-in loop pays it *per
 * turn*: roughly 40,000 tokens of tool definitions in front of a system prompt
 * of 600 to 1,600, on every exchange, whatever the task. A run of four turns
 * therefore spent 160,000 tokens describing tools it was never going to call.
 *
 * So the worker is handed a subset. Three rules make that safe:
 *
 * 1. **This is not a permission.** Every tool stays in the catalogue, stays
 *    executable, and stays governed by the service token, the mutation policy
 *    and the workspace's settings exactly as before. A domain that is not
 *    offered is a domain the model was not *told* about. Nothing here may ever
 *    be read as a security boundary, or the day somebody widens the selection
 *    for convenience they widen an authorization too.
 * 2. **The selection is deterministic and free.** Keywords over the task text,
 *    no model call, no round trip. A wrong guess costs one extra turn, a
 *    classification call costs one request on every run.
 * 3. **There is a way back.** `exo_toolbox` is in the always-on set: it names
 *    the domains that exist and opens one, so a task the keywords missed is one
 *    call from what it needs rather than stuck.
 *
 * `core` and `pages` are always offered. Not because keywords could not
 * describe them, but because this product is a workspace of pages: reading,
 * writing and moving them is what almost every task is, and the recovery call
 * would be the common case rather than the exception.
 */

import { type AnyToolDefinition, TOOL_DOMAINS, type ToolDomain } from './tool.js';

/**
 * The domains every run is offered, whatever it was asked to do.
 *
 * Kept as small as it can be while leaving the everyday task whole: navigate,
 * search, read, write, edit, move. Everything else is a specialism that a task
 * either names or does not need.
 */
export const ALWAYS_OFFERED_DOMAINS: readonly ToolDomain[] = ['core', 'pages'];

/**
 * What each domain is, in the words the model is shown when it asks.
 *
 * German, because it is read by the model inside a German prompt and by a
 * person in the run's log line. The keywords beside it are what switch the
 * domain on; they are lowercase substrings rather than words, because German
 * compounds ("Datenbankansicht", "Freigabelink") would slip past a word
 * boundary, and because a false positive costs a few hundred tokens where a
 * false negative costs a whole turn.
 */
interface DomainSpec {
  label: string;
  keywords: readonly string[];
}

const DOMAIN_SPECS: Readonly<Record<ToolDomain, DomainSpec>> = {
  core: {
    label: 'Navigieren, suchen, lesen, Regeln laden. Immer verfügbar.',
    keywords: [],
  },
  pages: {
    label: 'Seiten anlegen, schreiben, gezielt ändern, umbenennen, verschieben. Immer verfügbar.',
    keywords: [],
  },
  history: {
    label: 'Snapshots, Versionsvergleich, Änderungsverlauf, Wiederherstellen.',
    keywords: [
      'snapshot',
      'version',
      'wiederherstell',
      'zurückroll',
      'zurückgeroll',
      'rückgängig',
      'verlauf',
      'historie',
      'vergleich',
      'diff',
      'restore',
      'revert',
      'vorheriger stand',
    ],
  },
  lifecycle: {
    label: 'Archivieren, in den Papierkorb legen, endgültig löschen.',
    keywords: [
      'archiv',
      'papierkorb',
      'lösch',
      'loesch',
      'delete',
      'trash',
      'entsorg',
      'endgültig weg',
    ],
  },
  appearance: {
    label: 'Titelbild, Layout, KI-Regel einer Seite, Übersichtsseiten.',
    keywords: [
      'titelbild',
      'cover',
      'layout',
      'übersichtsseite',
      'uebersichtsseite',
      'overview',
      'ki-regel',
      'seitenbreite',
      'darstellung',
    ],
  },
  inbox: {
    label: 'Eingang, schnelles Erfassen, Web-Clips.',
    keywords: ['eingang', 'inbox', 'erfass', 'capture', 'clip', 'lesezeichen', 'bookmark'],
  },
  comments: {
    label: 'Kommentare an Seiten und Blöcken.',
    keywords: ['kommentar', 'comment', 'anmerkung', 'rückmeldung an der stelle'],
  },
  databases: {
    label: 'Datenbanken: Spalten, Optionen, Ansichten, Zeilen, Abfragen.',
    keywords: [
      'datenbank',
      'database',
      'datensatz',
      'rollup',
      'formelspalte',
      'kanban',
      'notion',
      'collection',
      'datenbankzeile',
      'datenbankansicht',
      'eigenschaft der zeile',
    ],
  },
  attachments: {
    label: 'Dateien hochladen, ihren Text lesen und korrigieren.',
    keywords: [
      'anhang',
      'anhäng',
      'anhaeng',
      'datei',
      'hochlad',
      'upload',
      'attachment',
      'pdf lesen',
      'eingescannt',
      'extrahiert',
    ],
  },
  templates: {
    label: 'Seitenvorlagen anlegen und anwenden.',
    keywords: ['vorlage', 'template'],
  },
  savedQueries: {
    label: 'Gespeicherte Suchen, Smart Views, Abfrageblöcke.',
    keywords: ['gespeicherte suche', 'smart view', 'abfrage', 'saved query', 'suchblock'],
  },
  workItems: {
    label:
      'Aufträge: delegierte Arbeit mit Ziel, Status, Bearbeiter, Ergebnis, Läufen und Arbeitsständen.',
    keywords: [
      'auftrag',
      'arbeitsstand',
      'arbeitsständ',
      'aufträg',
      'auftraeg',
      'delegier',
      'akzeptanzkriter',
      'work item',
      'work_item',
      'workitem',
    ],
  },
  attention: {
    label: 'Was auf einen Menschen wartet: Rückfragen, Entscheidungen, Freigaben, Prüfungen.',
    keywords: [
      'aufmerksamkeit',
      'rückfrag',
      'rueckfrag',
      'nachfragen',
      'entscheidung',
      'wartet auf mich',
      'wartet auf dich',
      'braucht mich',
      'exo_attention',
      'attention',
    ],
  },
  changesets: {
    label:
      'Änderungsvorschläge: Seitenänderungen vorschlagen statt schreiben, einreichen und nachsehen, was übernommen wurde.',
    keywords: [
      'vorschlag',
      'vorschläg',
      'vorschlaeg',
      'vorschlagen',
      'changeset',
      'exo_changeset',
      'zur prüfung',
      'zur freigabe',
    ],
  },
  shares: {
    label: 'Freigaben und öffentliche Links.',
    keywords: ['freigab', 'freigeb', 'teilen', 'geteilt', 'share', 'öffentlicher link', 'zugriff'],
  },
  entities: {
    label: 'Entitäten: Personen, Organisationen und ihre Verknüpfungen.',
    keywords: ['entität', 'entitaet', 'entity', 'kontakt', 'organisation', 'personenprofil'],
  },
  memory: {
    label: 'Agenten-Gedächtnis, Fakten, Postfach zwischen Agenten, Sitzungen.',
    keywords: [
      'gedächtnis',
      'gedaechtnis',
      'erinner',
      'memory',
      'merk dir',
      'postfach',
      'agentensitzung',
      'faktenschicht',
    ],
  },
  chats: {
    label: 'Frühere Unterhaltungen, KI-Läufe und ihr Verbrauch.',
    keywords: [
      'unterhaltung',
      'konversation',
      'chatverlauf',
      'ki-lauf',
      'ai run',
      'verbrauch',
      'kosten',
      'token',
    ],
  },
  automations: {
    label: 'Automationen: Auslöser, Aktionen, Zeitpläne, Läufe.',
    keywords: [
      'automatis',
      'automation',
      'auslöser',
      'trigger',
      'zeitplan',
      'geplant',
      'cron',
      'webhook',
      'regelmäßig',
    ],
  },
  notifications: {
    label: 'Push-Geräte, Benachrichtigungen und die Sprache der Oberfläche.',
    keywords: ['benachricht', 'push', 'notification', 'gerät', 'sprache', 'language', 'englisch'],
  },
  projects: {
    label: 'LaTeX-Projekte: Dateien, Übersetzungsläufe, Diagnosen, Archive.',
    keywords: ['projekt', 'latex', 'bibtex', 'kompilier', 'übersetzungslauf', 'quelldatei', '.tex'],
  },
  render: {
    label: 'Seiten als PDF rendern, Rendervorlagen.',
    keywords: ['render', 'pdf erzeugen', 'pdf export', 'drucken', 'veröffentlichen als'],
  },
  web: {
    label: 'Im Web suchen und Webseiten lesen.',
    keywords: [
      'recherch',
      'internet',
      'im web',
      'online',
      'suchmaschine',
      'webseite',
      'website',
      'http',
      'url',
    ],
  },
  admin: {
    label: 'Einladungen, Benutzerkonten, Arbeitsbereich umbenennen.',
    keywords: [
      'einlad',
      'einladung',
      'benutzerkonto',
      'nutzerkonto',
      'konto sperren',
      'deaktivier',
      'arbeitsbereich umbenennen',
      'workspace umbenennen',
    ],
  },
};

/** What a domain is, for the toolbox listing and for a log line. */
export function domainLabel(domain: ToolDomain): string {
  return DOMAIN_SPECS[domain].label;
}

export interface ToolSelectionInput {
  /**
   * What the run was asked to do: the user's own words, nothing else. The
   * system prompt is deliberately not part of it -- it names every ON_DEMAND
   * rule page in the workspace, so it would switch half the domains on for
   * every run and the selection would stop selecting.
   */
  text: string;
  /**
   * Domains the caller already knows are needed, whatever the words say. The
   * one that exists today is an open database view: the page on screen *is* a
   * database, so the tools for it are needed before anybody mentions one.
   */
  required?: readonly ToolDomain[];
}

/**
 * The domains one run is offered, always including `ALWAYS_OFFERED_DOMAINS`.
 *
 * Returned in `TOOL_DOMAINS` order rather than in the order they matched, so
 * two runs of the same task produce the same list and a stored one can be
 * compared with another.
 */
export function selectToolDomains(input: ToolSelectionInput): ToolDomain[] {
  const haystack = input.text.toLowerCase();
  const chosen = new Set<ToolDomain>([...ALWAYS_OFFERED_DOMAINS, ...(input.required ?? [])]);
  for (const domain of TOOL_DOMAINS) {
    if (chosen.has(domain)) continue;
    if (DOMAIN_SPECS[domain].keywords.some((keyword) => haystack.includes(keyword))) {
      chosen.add(domain);
    }
  }
  return TOOL_DOMAINS.filter((domain) => chosen.has(domain));
}

/** The tools of `tools` that belong to one of `domains`. */
export function toolsInDomains(
  tools: readonly AnyToolDefinition[],
  domains: readonly ToolDomain[],
): AnyToolDefinition[] {
  const wanted = new Set(domains);
  return tools.filter((tool) => wanted.has(tool.domain));
}

/**
 * The domain an `exo_toolbox` call asked for, or `null`.
 *
 * Here rather than beside the tool, because the caller that has to act on it
 * is the worker's loop: the catalogue can describe a domain, only the loop can
 * offer one (issue #121).
 */
export function openedDomain(argumentsJson: string): ToolDomain | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return null;
  }
  const domain = (parsed as { domain?: unknown } | null)?.domain;
  return TOOL_DOMAINS.find((known) => known === domain) ?? null;
}
