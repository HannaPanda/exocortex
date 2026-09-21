import {
  aiRuleListResponseSchema,
  markdownExportResponseSchema,
  workspaceListResponseSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient } from './client.js';

/**
 * What a client is told about this server before it calls anything.
 *
 * MCP's `initialize` carries an `instructions` string, and every client that
 * reads it puts it where a model cannot miss it: in the system prompt. Until
 * now this server sent none, which had one concrete consequence. The workspace
 * rule pages an owner writes (`aiRuleMode: ALWAYS`) reached the built-in AI's
 * system prompt and nothing else, so the deployment's own filing rules were
 * invisible to exactly the clients that file the most pages. An external agent
 * was not ignoring the rules; it had never been shown them.
 *
 * The text below is the part that is true of every deployment. The rule pages
 * are appended per workspace, which is what makes the policy something an owner
 * edits in a page rather than something a maintainer edits in this file.
 */
export const BASE_INSTRUCTIONS = `eXocortex ist ein Arbeitsbereich aus verschachtelten Seiten. Struktur ist hier Inhalt: wo eine Seite hängt, ist Teil ihrer Aussage.

Bevor du eine Seite anlegst:
- Sieh nach, was es schon gibt. exo_search findet Seiten zum Thema und nennt ihren Pfad; exo_page_tree mit parentId zeigt, was unter einer Seite hängt (ohne parentId ist der Baum gekürzt und damit keine vollständige Antwort).
- Lege sie unter die tiefste passende Seite, nicht daneben. Der häufigste Fehler ist eine Ebene zu hoch: die Seite landet direkt unter dem Oberbereich, obwohl darunter der Unterbereich liegt, in den sie gehört.
- Wenn du unsicher bist, frag exo_page_suggest_parent mit Titel und kurzer Zusammenfassung. Das Werkzeug antwortet mit Kandidaten und nennt die vorhandenen Seiten, die dort schon liegen.
- Für eine bestehende Seite, die falsch einsortiert ist, gilt dasselbe Werkzeug mit documentId; verschoben wird mit exo_page_move.

Beim Lesen: exo_page_read gibt kleine Seiten als Text aus. Eine große Seite antwortet stattdessen mit ihrer Karte: den Abschnitten mit Überschrift, Größe und Blockkennung. Das ist kein Anfang und kein Auszug, sondern die Gliederung; lies den Abschnitt, den du brauchst, mit exo_page_block_read und seiner Kennung. Ist der selbst zu groß, kommt wieder eine Karte, und hat ein Teil keine Überschriften mehr, nennt sie Blockfenster (blockId und toBlockId zusammen lesen). Du musst eine Seite nie von vorne durchlesen, um an ihr Ende zu kommen.

Beim Schreiben: exo_page_write mit mode "append" ergänzt, "replace" ersetzt die ganze Seite (und gilt auch, wenn mode fehlt). Für eine einzelne Stelle einer langen Seite gibt es exo_page_block_update, exo_page_patch und exo_page_section_write; die lassen den Rest der Seite unangetastet. Ist ein Abschnitt zu einem eigenen Thema geworden, verschiebt ihn exo_page_extract_section mit einem Aufruf auf eine eigene Seite, statt die Seite weiter wachsen zu lassen. Vor jedem Schreibvorgang wird ein Snapshot angelegt.`;

/** Total characters of rule-page text the handshake may carry. */
const MAX_RULE_CHARS = 8_000;

/** How many workspaces are described before the listing stops. */
const MAX_WORKSPACES = 5;

/** How long the whole assembly may take before the handshake goes on without it. */
const BUILD_TIMEOUT_MS = 5_000;

/**
 * Builds the `instructions` string for this connection: the text above, plus
 * every workspace's own rule pages.
 *
 * Never throws and never hangs: a handshake that fails because the rule pages
 * could not be read would trade a small loss for a total one, so anything that
 * goes wrong leaves the base text standing.
 */
export async function buildServerInstructions(client: ExocortexApiClient): Promise<string> {
  const timeout = new Promise<string>((resolve) => {
    setTimeout(() => resolve(BASE_INSTRUCTIONS), BUILD_TIMEOUT_MS).unref?.();
  });
  return Promise.race([collectInstructions(client), timeout]).catch(() => BASE_INSTRUCTIONS);
}

async function collectInstructions(client: ExocortexApiClient): Promise<string> {
  let workspaces;
  try {
    const list = await client.request({
      method: 'GET',
      path: '/api/workspaces',
      responseSchema: workspaceListResponseSchema,
    });
    workspaces = list.workspaces.slice(0, MAX_WORKSPACES);
  } catch {
    return BASE_INSTRUCTIONS;
  }

  const sections: string[] = [];
  let budget = MAX_RULE_CHARS;
  for (const workspace of workspaces) {
    const section = await describeWorkspace(client, workspace, budget);
    if (section === null) continue;
    budget -= section.length;
    sections.push(section);
    if (budget <= 0) break;
  }

  if (sections.length === 0) return BASE_INSTRUCTIONS;
  return [BASE_INSTRUCTIONS, '', ...sections].join('\n');
}

/**
 * One workspace's rules: the ALWAYS pages in full, the ON_DEMAND ones as their
 * trigger sentence and an id to load them with.
 *
 * ALWAYS pages are inlined rather than pointed at, because "always" is the
 * whole claim: a rule that only takes effect when the client remembers to fetch
 * it is an ON_DEMAND rule wearing the wrong label.
 */
async function describeWorkspace(
  client: ExocortexApiClient,
  workspace: { id: string; name: string },
  budget: number,
): Promise<string | null> {
  let rules;
  try {
    rules = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspace.id}/ai-rules`,
      responseSchema: aiRuleListResponseSchema,
    });
  } catch {
    return null;
  }
  if (rules.rules.length === 0) return null;

  const parts: string[] = [`## Regeln im Arbeitsbereich „${workspace.name}" (${workspace.id})`];
  let remaining = budget;

  for (const rule of rules.rules.filter((entry) => entry.mode === 'always')) {
    const body = await loadRule(client, rule.documentId);
    if (body === null) continue;
    if (body.length > remaining) {
      parts.push(
        `### ${rule.title}\n(zu lang für den Handshake, lade sie mit exo_rules_load und documentId ${rule.documentId})`,
      );
      continue;
    }
    remaining -= body.length;
    parts.push(`### ${rule.title}\n${body}`);
  }

  const onDemand = rules.rules
    .filter((entry) => entry.mode === 'on_demand' && entry.trigger !== null)
    .map((entry) => `- ${entry.trigger} (exo_rules_load mit documentId ${entry.documentId})`);
  if (onDemand.length > 0) {
    parts.push(['### Regeln auf Anfrage', ...onDemand].join('\n'));
  }

  return parts.length === 1 ? null : parts.join('\n\n');
}

async function loadRule(client: ExocortexApiClient, documentId: string): Promise<string | null> {
  try {
    const page = await client.request({
      method: 'GET',
      path: `/api/documents/${documentId}/export/markdown`,
      responseSchema: markdownExportResponseSchema,
    });
    const body = stripFrontmatter(page.markdown).trim();
    return body.length === 0 ? null : body;
  } catch {
    return null;
  }
}

/**
 * Drops the export's YAML header.
 *
 * The Markdown export carries ids, schema versions and timestamps so a file can
 * be imported back. A rule that a model is supposed to follow gains nothing
 * from them, and they arrive first, which is the most expensive place in a
 * prompt for something nobody reads.
 */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown;
  const end = markdown.indexOf('\n---', 4);
  return end === -1 ? markdown : markdown.slice(end + 4);
}
