import { z } from 'zod';

import {
  confirmEntityCandidateResponseSchema,
  dismissEntityCandidateResponseSchema,
  ENTITY_TYPE_LABELS,
  entityCandidateListResponseSchema,
  entityListResponseSchema,
  entityMutationResponseSchema,
  type EntityProfile,
  entityProfileSchema,
  entityTypeSchema,
  idSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The entity layer, as tools (issue #47).
 *
 * The one that matters is `exo_entity_profile`: it is the difference between
 * "five pages mention fpb2" and "here is what is known about fpb2", which for
 * an agent with a context window is the difference between an answer and a
 * reading list. The rest is what a curated list needs to stay curated.
 *
 * Provisioning the database is deliberately not a tool. It writes a
 * deployment-wide setting, and `entities.databaseId` decides what every one of
 * these tools then reads; a person does that once, in the admin area.
 */

const typeArgument = entityTypeSchema.describe(
  `Art der Entität: ${Object.entries(ENTITY_TYPE_LABELS)
    .map(([value, label]) => `${value} (${label})`)
    .join(', ')}`,
);

export const entityListTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_list',
  description:
    'Listet die bekannten Entitäten: Personen, Hosts, Dienste, Projekte, Zugänge und ' +
    'Organisationen, über die dieses System etwas weiß. Mit Aliassen und der Zahl der Seiten, ' +
    'die über sie sprechen. Nützlich, um vor einer Suche zu klären, ob es zu einem Namen ' +
    'überhaupt eine geführte Entität gibt.',
  inputSchema: z.object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Teil eines Namens oder Aliasnamens. Weglassen listet alle.'),
    type: typeArgument.optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Höchstzahl der Entitäten'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: false,
  async execute(client, input) {
    const response = await client.request({
      method: 'GET',
      path: '/api/entities',
      query: {
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      responseSchema: entityListResponseSchema,
    });

    if (response.databaseId === null) {
      return {
        text: 'Diese Installation führt keine Entitäten. In den Einstellungen lässt sich eine Entitäten-Datenbank anlegen.',
        data: response,
      };
    }
    if (response.entities.length === 0) {
      return { text: 'Keine Entität passt dazu.', data: response };
    }

    const lines = response.entities.map((entity) => {
      const marks = [
        ENTITY_TYPE_LABELS[entity.type],
        entity.aliases.length === 0 ? null : `auch: ${entity.aliases.join(', ')}`,
        `${entity.mentionCount} Seiten`,
      ].filter((mark): mark is string => mark !== null);
      return `- ${entity.title} (${marks.join(', ')}, id: ${entity.id})`;
    });
    return { text: lines.join('\n'), data: response };
  },
});

function renderProfile(profile: EntityProfile): string {
  const parts = [profile.text];
  if (profile.hiddenMentions > 0) {
    parts.push(
      `\n(${profile.hiddenMentions} weitere Seiten in Arbeitsbereichen, die du nicht lesen darfst.)`,
    );
  }
  return parts.join('\n');
}

export const entityProfileTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_profile',
  description:
    'Beantwortet „was weiß ich über X" in einer Anfrage: was die Entität ist, welche ' +
    'verdichteten Fakten für sie gelten, womit sie zusammenhängt und welche Seiten über sie ' +
    'sprechen, nach Aktualität. Der Umweg über die Suche und fünf geöffnete Seiten entfällt ' +
    'damit. Die Id kommt aus exo_entity_list.',
  inputSchema: z.object({
    entityId: idSchema.describe('Id der Entität aus exo_entity_list'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: false,
  async execute(client, input) {
    const response = await client.request({
      method: 'GET',
      path: `/api/entities/${encodeURIComponent(input.entityId)}`,
      responseSchema: entityProfileSchema,
    });
    return { text: renderProfile(response), data: response };
  },
});

export const entityCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_create',
  description:
    'Legt eine Entität an: einen Namen, seine Schreibweisen und seine Art. Danach werden ' +
    'bestehende Seiten einmal nach diesen Namen durchsucht und verknüpft, und jede weitere ' +
    'Speicherung einer Seite prüft sie mit. Nur für Dinge anlegen, über die es wirklich etwas ' +
    'zu wissen gibt; eine Liste, die niemand pflegt, ist schlechter als keine.',
  inputSchema: z.object({
    title: z.string().trim().min(2).max(200).describe('Der geführte Name'),
    type: typeArgument.optional(),
    aliases: z
      .array(z.string().trim().min(2).max(120))
      .max(20)
      .optional()
      .describe('Weitere Schreibweisen, unter denen der Name auf Seiten steht'),
    summary: z
      .string()
      .trim()
      .max(20_000)
      .optional()
      .describe('Markdown für die Seite der Entität. Optional.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  target: (input) => `entity:${input.title.toLowerCase()}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: '/api/entities',
      body: {
        title: input.title,
        type: input.type ?? 'other',
        aliases: input.aliases ?? [],
        summary: input.summary ?? '',
      },
      responseSchema: entityMutationResponseSchema,
    });
    return {
      text:
        `Entität „${response.entity.title}" angelegt (id: ${response.entity.id}). ` +
        'Bestehende Seiten werden im Hintergrund nach diesem Namen durchsucht.',
      data: response,
    };
  },
});

export const entityUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_update',
  description:
    'Ändert Art oder Schreibweisen einer Entität. Die Aliasse ersetzen die bisherigen ' +
    'vollständig, also die alten mitschicken, die bleiben sollen. Eine Änderung an den ' +
    'Aliassen löst eine erneute Suche in bestehenden Seiten aus.',
  inputSchema: z.object({
    entityId: idSchema.describe('Id der Entität'),
    type: typeArgument.optional(),
    aliases: z
      .array(z.string().trim().min(2).max(120))
      .max(20)
      .optional()
      .describe('Die vollständige neue Liste der Schreibweisen'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  destructive: true,
  target: (input) => `entity:${input.entityId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'PATCH',
      path: `/api/entities/${encodeURIComponent(input.entityId)}`,
      body: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      },
      responseSchema: entityMutationResponseSchema,
    });
    return {
      text: `„${response.entity.title}" aktualisiert.${
        response.rescanQueued ? ' Bestehende Seiten werden erneut geprüft.' : ''
      }`,
      data: response,
    };
  },
});

const linkResponseSchema = z.object({
  entityId: idSchema,
  documentId: idSchema,
  created: z.boolean(),
});

export const entityLinkPageTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_link_page',
  description:
    'Verknüpft eine Seite von Hand mit einer Entität, auch wenn der Name dort nicht steht. ' +
    'Für Seiten, die über etwas handeln, ohne es zu benennen. Solche Verknüpfungen überleben ' +
    'jede erneute Erfassung.',
  inputSchema: z.object({
    entityId: idSchema.describe('Id der Entität'),
    documentId: idSchema.describe('Id der Seite'),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('Warum die Seite dazugehört. Steht später im Profil.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  target: (input) => `entity-page:${input.entityId}:${input.documentId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: `/api/entities/${encodeURIComponent(input.entityId)}/pages`,
      body: { documentId: input.documentId, note: input.note ?? '' },
      responseSchema: linkResponseSchema,
    });
    return {
      text: response.created
        ? 'Verknüpft.'
        : 'Die Verknüpfung gab es schon; sie gilt jetzt als von Hand gesetzt.',
      data: response,
    };
  },
});

export const entityUnlinkPageTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_unlink_page',
  description:
    'Löst die Verknüpfung zwischen einer Seite und einer Entität. Steht der Name auf der ' +
    'Seite, kommt die Verknüpfung beim nächsten Speichern der Seite zurück: die Seite sagt ' +
    'den Namen ja wirklich.',
  inputSchema: z.object({
    entityId: idSchema.describe('Id der Entität'),
    documentId: idSchema.describe('Id der Seite'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  destructive: true,
  target: (input) => `entity-page:${input.entityId}:${input.documentId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'DELETE',
      path: `/api/entities/${encodeURIComponent(input.entityId)}/pages/${encodeURIComponent(
        input.documentId,
      )}`,
      responseSchema: z.object({
        entityId: idSchema,
        documentId: idSchema,
        removed: z.boolean(),
      }),
    });
    return {
      text: response.removed ? 'Verknüpfung entfernt.' : 'Es gab keine Verknüpfung.',
      data: response,
    };
  },
});

export const entityCandidatesTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_candidates',
  description:
    'Listet Namen, die auf mehreren Seiten vorkommen und zu denen es noch keine Entität gibt. ' +
    'Vorschläge, keine Entscheidungen: angelegt wird erst durch exo_entity_candidate_confirm. ' +
    'Mit Beispielseiten, damit sich ohne Öffnen beurteilen lässt, ob ein Name ein Ding ist.',
  inputSchema: z.object({
    minDocuments: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Auf so vielen Seiten muss der Name stehen. Standard: Schwelle der Installation.'),
    limit: z.number().int().min(1).max(100).optional().describe('Höchstzahl der Vorschläge'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: false,
  async execute(client, input) {
    const response = await client.request({
      method: 'GET',
      path: '/api/entities/candidates',
      query: {
        ...(input.minDocuments === undefined ? {} : { minDocuments: input.minDocuments }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      responseSchema: entityCandidateListResponseSchema,
    });

    if (response.candidates.length === 0) {
      return {
        text: `Keine Vorschläge ab ${response.threshold} Seiten.`,
        data: response,
      };
    }
    const lines = response.candidates.map((candidate) => {
      const sample = candidate.samples[0];
      return (
        `- ${candidate.phrase} (${candidate.documentCount} Seiten, ` +
        `${candidate.occurrences}× genannt, id: ${candidate.id})` +
        (sample === undefined ? '' : `: „${sample.context}"`)
      );
    });
    return { text: lines.join('\n'), data: response };
  },
});

export const entityCandidateConfirmTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_candidate_confirm',
  description:
    'Macht aus einem Vorschlag eine Entität. Die Seiten, auf denen der Name schon steht, ' +
    'werden sofort verknüpft. Der vorgeschlagene Name bleibt immer ein Alias, auch wenn die ' +
    'Entität anders heißen soll.',
  inputSchema: z.object({
    candidateId: idSchema.describe('Id des Vorschlags aus exo_entity_candidates'),
    title: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .optional()
      .describe('Geführter Name. Weglassen übernimmt den vorgeschlagenen.'),
    type: typeArgument.optional(),
    aliases: z
      .array(z.string().trim().min(2).max(120))
      .max(20)
      .optional()
      .describe('Weitere Schreibweisen'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  target: (input) => `entity-candidate:${input.candidateId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: `/api/entities/candidates/${encodeURIComponent(input.candidateId)}/confirm`,
      body: {
        ...(input.title === undefined ? {} : { title: input.title }),
        type: input.type ?? 'other',
        aliases: input.aliases ?? [],
      },
      responseSchema: confirmEntityCandidateResponseSchema,
    });
    return {
      text:
        `„${response.entity.title}" angelegt (id: ${response.entity.id}), ` +
        `${response.adoptedMentions} Seiten sofort verknüpft.`,
      data: response,
    };
  },
});

export const entityCandidateDismissTool: AnyToolDefinition = defineTool({
  name: 'exo_entity_candidate_dismiss',
  description:
    'Verwirft einen Vorschlag dauerhaft. Er taucht nicht wieder auf, auch wenn der Name ' +
    'weiter auf Seiten steht. Das ist der Weg, die Vorschlagsliste brauchbar zu halten.',
  inputSchema: z.object({
    candidateId: idSchema.describe('Id des Vorschlags'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'entities',
  mutating: true,
  destructive: true,
  target: (input) => `entity-candidate:${input.candidateId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: `/api/entities/candidates/${encodeURIComponent(input.candidateId)}/dismiss`,
      responseSchema: dismissEntityCandidateResponseSchema,
    });
    return { text: `„${response.phrase}" wird nicht mehr vorgeschlagen.`, data: response };
  },
});

export const ENTITY_TOOLS: readonly AnyToolDefinition[] = [
  entityListTool,
  entityProfileTool,
  entityCreateTool,
  entityUpdateTool,
  entityLinkPageTool,
  entityUnlinkPageTool,
  entityCandidatesTool,
  entityCandidateConfirmTool,
  entityCandidateDismissTool,
];
