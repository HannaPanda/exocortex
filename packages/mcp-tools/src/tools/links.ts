import { z } from 'zod';

import {
  type DocumentLinkKind,
  type DocumentLinksResponse,
  documentLinksResponseSchema,
  idSchema,
  type KnowledgeMapEdge,
  knowledgeMapEdgeKindSchema,
  type KnowledgeMapResponse,
  knowledgeMapResponseSchema,
  type RelatedDocumentsResponse,
  relatedDocumentsResponseSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/** Cap on the rendered text, so a heavily linked hub page cannot flood a tool loop. */
const MAX_LINKS_TEXT_CHARS = 8_000;

const KIND_LABEL: Record<DocumentLinkKind, string> = {
  pageLink: 'Seitenlink',
  mention: 'Erwähnung',
  wikiMark: 'Wiki-Link',
};

function renderIncoming(result: DocumentLinksResponse): string {
  if (result.incoming.length === 0) return 'Keine Seite verweist auf diese Seite.';
  const lines = result.incoming.map(
    (link) =>
      `- ${link.source.title} (id: ${link.source.id}, ${KIND_LABEL[link.kind]}` +
      `${link.source.archivedAt === null ? '' : ', archiviert'})` +
      `${link.context.length > 0 ? `: „${link.context}"` : ''}`,
  );
  return [`Verweise auf diese Seite (${result.incoming.length}):`, ...lines].join('\n');
}

/**
 * Why a reference resolved to nothing, said so an agent can act on it.
 *
 * `[[#Überschrift]]` is Obsidian's section link; here it is a reference to a
 * page titled "#Überschrift". Reported as just another missing page, it taught
 * an agent that sections cannot be linked at all (issue #197).
 */
function unresolvedReason(targetTitle: string): string {
  // The same reading as `sectionLinkHeading` in `@exocortex/editor`, which this
  // package may not import (it reaches only the contracts).
  const heading = targetTitle.startsWith('#') ? targetTitle.slice(1).trim() : '';
  if (heading.length === 0) return 'nicht auflösbar: keine Seite mit diesem Titel';
  return (
    'nicht auflösbar: [[#…]] ist kein Abschnittslink. Einen Abschnitt derselben Seite ' +
    `verlinkt [${heading}](#blockId) mit der Blockkennung der Überschrift`
  );
}

function renderOutgoing(result: DocumentLinksResponse): string {
  if (result.outgoing.length === 0) {
    return result.pending
      ? 'Die ausgehenden Verweise dieser Seite wurden noch nicht erfasst.'
      : 'Diese Seite verweist auf keine andere Seite.';
  }
  const lines = result.outgoing.map((link) =>
    link.target === null
      ? `- ${link.targetTitle} (${KIND_LABEL[link.kind]}, ${unresolvedReason(link.targetTitle)})`
      : `- ${link.target.title} (id: ${link.target.id}, ${KIND_LABEL[link.kind]})`,
  );
  const unresolved = result.outgoing.filter((link) => link.target === null).length;
  return [
    `Diese Seite verweist auf (${result.outgoing.length}` +
      `${unresolved > 0 ? `, davon ${unresolved} unaufgelöst` : ''}):`,
    ...lines,
  ].join('\n');
}

export const pageBacklinksTool: AnyToolDefinition = defineTool({
  name: 'exo_page_backlinks',
  description:
    'Liest den Verweisindex einer Seite: welche Seiten auf sie verweisen (mit der Textstelle) ' +
    'und auf welche Seiten sie selbst verweist. Unaufgelöste Verweise (ein Titel, zu dem es ' +
    'keine Seite gibt) werden ausdrücklich mitgeliefert. Mit "direction" lässt sich eine ' +
    'Richtung auswählen.',
  inputSchema: z.object({
    documentId: idSchema,
    direction: z
      .enum(['incoming', 'outgoing', 'both'])
      .default('both')
      .describe('incoming: wer verweist hierher. outgoing: worauf verweist diese Seite.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'pages',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/links`,
      responseSchema: documentLinksResponseSchema,
    });

    const sections: string[] = [];
    if (input.direction !== 'outgoing') sections.push(renderIncoming(result));
    if (input.direction !== 'incoming') sections.push(renderOutgoing(result));

    const rendered = truncateText(sections.join('\n\n'), MAX_LINKS_TEXT_CHARS);
    return { text: rendered.text, data: result };
  },
});

function renderRelated(result: RelatedDocumentsResponse): string {
  if (result.state === 'disabled') {
    return 'Verwandte Seiten stehen nicht zur Verfügung: die semantische Suche ist abgeschaltet.';
  }
  if (result.state === 'pending') {
    return 'Diese Seite wurde noch nicht für die semantische Suche erfasst. Sobald das passiert ist, lassen sich verwandte Seiten bestimmen.';
  }
  if (result.related.length === 0) {
    return 'Keine andere Seite dieses Arbeitsbereichs ähnelt dieser Seite deutlich genug.';
  }

  const lines = result.related.map((entry) => {
    const location = entry.path.map((step) => step.title).join(' / ');
    return (
      `- ${entry.document.title} (id: ${entry.document.id}, ` +
      `Ähnlichkeit ${entry.similarity.toFixed(2)}` +
      `${entry.linked ? ', bereits verlinkt' : ''})` +
      `${location.length > 0 ? `\n  Pfad: ${location}` : ''}` +
      `${entry.snippet.length > 0 ? `\n  ${entry.snippet}` : ''}`
    );
  });
  return [`Verwandte Seiten (${result.related.length}):`, ...lines].join('\n');
}

export const pageRelatedTool: AnyToolDefinition = defineTool({
  name: 'exo_page_related',
  description:
    'Findet Seiten, die inhaltlich zu einer Seite passen, ohne dass jemand sie verlinkt hat ' +
    '(semantische Ähnlichkeit über die gespeicherten Embeddings). Ergänzt exo_page_backlinks: ' +
    'dort stehen die gesetzten Verweise, hier die ungeschriebenen. Seiten, die bereits verlinkt ' +
    'sind, werden als solche gekennzeichnet statt weggelassen.',
  inputSchema: z.object({
    documentId: idSchema,
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'pages',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/related`,
      responseSchema: relatedDocumentsResponseSchema,
    });

    const rendered = truncateText(renderRelated(result), MAX_LINKS_TEXT_CHARS);
    return { text: rendered.text, data: result };
  },
});

/** How many entries each list of the map summary names. */
const MAP_LIST_LIMIT = 12;

/**
 * The knowledge map as text (issue #189). The browser draws every point; a
 * model cannot read 800 points, so the text answers the questions the picture
 * answers at a glance: where the hubs are, which branches are big, what stands
 * alone, and which pages resemble each other without any line between them.
 * The last list is the useful one for an agent: it is the work of linking.
 */
export function renderKnowledgeMap(map: KnowledgeMapResponse): string {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const name = (id: string): string => `${byId.get(id)?.title ?? '?'} [id: ${id}]`;
  const count = (kind: KnowledgeMapEdge['kind']): number =>
    map.edges.filter((edge) => edge.kind === kind).length;

  const meaningful = new Map<string, number>();
  for (const edge of map.edges) {
    if (edge.kind === 'tree') continue;
    meaningful.set(edge.source, (meaningful.get(edge.source) ?? 0) + 1);
    meaningful.set(edge.target, (meaningful.get(edge.target) ?? 0) + 1);
  }
  const entities = map.nodes.filter((node) => node.kind === 'entity').length;
  const semanticNote =
    map.semantic === 'disabled'
      ? ' Ähnlichkeiten fehlen: diese Installation hat keine semantische Suche.'
      : map.semantic === 'partial'
        ? ' Einige Seiten haben noch keinen Suchvektor und stehen ohne Ähnlichkeitslinien da.'
        : '';

  const sections: string[] = [
    `${map.nodes.length} Seiten, davon ${entities} Entitäten. Linien: ${count('link')} Verweise, ` +
      `${count('similar')} Ähnlichkeiten ohne Verweis, ${count('entity')} Entitäts-Erwähnungen, ` +
      `${count('tree')} Eltern-Kind-Beziehungen.${semanticNote}`,
  ];

  const hubs = [...meaningful.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAP_LIST_LIMIT);
  if (hubs.length > 0) {
    sections.push(
      ['Knotenpunkte (meiste Verbindungen ohne den Seitenbaum):']
        .concat(hubs.map(([id, degree]) => `- ${name(id)}: ${degree}`))
        .join('\n'),
    );
  }

  const branchSize = new Map<string, number>();
  for (const node of map.nodes) branchSize.set(node.rootId, (branchSize.get(node.rootId) ?? 0) + 1);
  const branches = [...branchSize.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAP_LIST_LIMIT);
  if (branches.length > 0) {
    sections.push(
      ['Größte Bereiche (Seiten im Zweig):']
        .concat(branches.map(([id, size]) => `- ${name(id)}: ${size}`))
        .join('\n'),
    );
  }

  const alone = map.nodes.filter((node) => !meaningful.has(node.id) && node.type === 'PAGE');
  if (alone.length > 0) {
    sections.push(
      [`Ohne Verbindung außer dem Seitenbaum: ${alone.length} Seiten, zum Beispiel:`]
        .concat(alone.slice(0, MAP_LIST_LIMIT).map((node) => `- ${name(node.id)}`))
        .join('\n'),
    );
  }

  const unlinked = map.edges
    .filter((edge) => edge.kind === 'similar')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAP_LIST_LIMIT);
  if (unlinked.length > 0) {
    sections.push(
      ['Ähnlich, aber nicht verlinkt (stärkste zuerst):']
        .concat(unlinked.map((edge) => `- ${name(edge.source)} ↔ ${name(edge.target)}`))
        .join('\n'),
    );
  }

  return sections.join('\n\n');
}

export const knowledgeMapTool: AnyToolDefinition = defineTool({
  name: 'exo_knowledge_map',
  description:
    'Liest die Wissenskarte eines Arbeitsbereichs: alle Seiten als Punkte und jede Art von ' +
    'Verbindung als Linie (Verweise, inhaltliche Ähnlichkeit, Entitäts-Erwähnungen, Seitenbaum). ' +
    'Der Text nennt Knotenpunkte, die größten Bereiche, Seiten ohne Verbindung und Seitenpaare, ' +
    'die sich ähneln, aber nicht verlinkt sind; das strukturierte Ergebnis enthält alle Punkte ' +
    'und Linien. Mit exclude lassen sich Linienarten weglassen, z. B. "tree,similar".',
  inputSchema: z.object({
    workspaceId: idSchema,
    exclude: z.array(knowledgeMapEdgeKindSchema).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'pages',
  mutating: false,
  async execute(client, input) {
    const query =
      input.exclude !== undefined && input.exclude.length > 0
        ? `?exclude=${encodeURIComponent(input.exclude.join(','))}`
        : '';
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/map${query}`,
      responseSchema: knowledgeMapResponseSchema,
    });
    return {
      text: truncateText(renderKnowledgeMap(result), MAX_LINKS_TEXT_CHARS).text,
      data: result,
    };
  },
});

export const LINK_TOOLS: readonly AnyToolDefinition[] = [
  pageBacklinksTool,
  pageRelatedTool,
  knowledgeMapTool,
];
