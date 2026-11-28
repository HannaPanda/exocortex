import { describe, expect, it } from 'vitest';

import {
  COMPACT_ENDPOINT_DOMAINS,
  COMPACT_ENDPOINT_EXECUTABLE,
  rankTools,
  toolsFor,
} from '@exocortex/mcp-tools';

import { toolSearchWords } from './tool-search-words';

/**
 * A small gold standard for `exo_tool_search` (issue #265): what a person or
 * a chat model would type, in German and in English, and the tool it has to
 * find among the ones `/api/mcp/compact` does not list. Searched exactly as
 * the endpoint searches: the hidden part of the `mcp` surface, with the
 * feature registry's words, preferring what the dispatchers may run.
 *
 * The bar is the default result size of five, because that is what a client
 * sees when it names no limit. A query that needs a reworded description to
 * pass is a finding about the description, not a reason to loosen the bar.
 */

const listed = new Set(
  toolsFor('mcp', { domains: COMPACT_ENDPOINT_DOMAINS }).map((tool) => tool.name),
);
const hidden = toolsFor('mcp').filter((tool) => !listed.has(tool.name));
const prefer = new Set(COMPACT_ENDPOINT_EXECUTABLE);
const searchText = toolSearchWords();

function topNames(query: string, limit = 5): string[] {
  return rankTools({ tools: hidden, query, searchText, prefer })
    .slice(0, limit)
    .map((entry) => entry.tool.name);
}

const GOLD: readonly (readonly [string, string])[] = [
  // German
  ['Seitenbreite', 'exo_page_set_layout'],
  ['Seite auf volle Breite stellen', 'exo_page_set_layout'],
  ['Titelbild setzen', 'exo_page_set_cover'],
  ['Titelbild erzeugen lassen', 'exo_page_generate_cover'],
  ['Entitäten auflisten', 'exo_entity_list'],
  ['Personen und Organisationen', 'exo_entity_list'],
  ['neue Entität anlegen', 'exo_entity_create'],
  ['Seite mit einer Person verknüpfen', 'exo_entity_link_page'],
  ['Auftrag anlegen', 'exo_work_item_create'],
  ['offene Aufträge', 'exo_work_item_list'],
  ['Arbeitsstand festhalten', 'exo_work_item_checkpoint'],
  ['Änderungsvorschlag machen', 'exo_changeset_propose'],
  ['Rückfrage an einen Menschen stellen', 'exo_attention_request'],
  ['Was wartet auf mich', 'exo_attention_list'],
  ['gespeicherte Suche anlegen', 'exo_saved_query_create'],
  ['Übersichtsseite lesen', 'exo_page_overview_read'],
  ['KI-Regel einer Seite', 'exo_page_set_ai_rule'],
  ['LaTeX-Projekt kompilieren', 'exo_project_build'],
  ['Datei im Projekt lesen', 'exo_project_read_file'],
  ['Seite als PDF rendern', 'exo_render_start'],
  ['frühere Unterhaltungen durchsuchen', 'exo_chat_search'],
  ['Workflow entwerfen', 'exo_workflow_create'],
  ['Sprache der Oberfläche ändern', 'exo_me_preferences_set'],
  ['Text aus einem PDF-Anhang lesen', 'exo_attachment_read_text'],
  ['Nachricht an einen anderen Agenten', 'exo_agent_message_send'],
  ['Freigaben einer Seite', 'exo_share_list'],
  ['Benutzer einladen', 'exo_invitation_create'],
  // English
  ['page width', 'exo_page_set_layout'],
  ['set a cover image', 'exo_page_set_cover'],
  ['list entities', 'exo_entity_list'],
  ['create a work item', 'exo_work_item_create'],
  ['propose a change for review', 'exo_changeset_propose'],
  ['saved searches', 'exo_saved_query_list'],
  ['compile latex project', 'exo_project_build'],
  ['render page to pdf', 'exo_render_start'],
  ['search past chats', 'exo_chat_search'],
  ['notification settings', 'exo_notification_preferences'],
  ['who is the page shared with', 'exo_share_list'],
];

describe('exo_tool_search gold standard', () => {
  it('names a word for every hidden tool from the feature registry', () => {
    const missing = hidden.filter((tool) => (searchText.get(tool.name) ?? '').length === 0);
    expect(missing.map((tool) => tool.name)).toEqual([]);
  });

  it.each(GOLD)('„%s“ finds %s among the first five', (query, expected) => {
    expect(topNames(query)).toContain(expected);
  });

  it('finds the layout tool first for the compound the spike missed', () => {
    expect(topNames('Seitenbreite', 1)).toEqual(['exo_page_set_layout']);
  });
});
