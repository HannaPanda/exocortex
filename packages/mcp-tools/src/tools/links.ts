import { z } from 'zod';

import {
  type DocumentLinkKind,
  type DocumentLinksResponse,
  documentLinksResponseSchema,
  idSchema,
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

function renderOutgoing(result: DocumentLinksResponse): string {
  if (result.outgoing.length === 0) {
    return result.pending
      ? 'Die ausgehenden Verweise dieser Seite wurden noch nicht erfasst.'
      : 'Diese Seite verweist auf keine andere Seite.';
  }
  const lines = result.outgoing.map((link) =>
    link.target === null
      ? `- ${link.targetTitle} (${KIND_LABEL[link.kind]}, nicht auflösbar: keine Seite mit diesem Titel)`
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

export const LINK_TOOLS: readonly AnyToolDefinition[] = [pageBacklinksTool, pageRelatedTool];
