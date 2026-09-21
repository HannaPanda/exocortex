import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient, ExocortexApiError } from './client.js';
import { getMcpPrompt, listMcpPrompts } from './prompts.js';

const NOW = '2026-09-08T10:00:00.000Z';

function workspace(id: string, name: string, slug: string): unknown {
  return {
    id,
    name,
    slug,
    createdAt: NOW,
    updatedAt: NOW,
    role: 'OWNER',
    memberCount: 1,
    isMemory: false,
  };
}

function rule(documentId: string, title: string, mode: string, trigger: string | null): unknown {
  return { documentId, title, mode, trigger, priority: 0 };
}

function markdown(documentId: string, text: string): unknown {
  return {
    documentId,
    filename: 'regel.md',
    yjsUpdatedAt: '2026-09-21T12:00:00.000Z',
    view: 'content',
    chars: text.length,
    map: null,
    markdown: text,
    path: [],
    children: [],
  };
}

function clientReturning(routes: Record<string, unknown>): ExocortexApiClient {
  return {
    async request(input) {
      const answer = routes[input.path];
      if (answer === undefined) {
        throw new ExocortexApiError('not_found', `no route: ${input.path}`, 404, null);
      }
      return input.responseSchema.parse(answer);
    },
    async upload(input) {
      return input.responseSchema.parse(undefined);
    },
  };
}

const CLIENT = clientReturning({
  '/api/workspaces': {
    workspaces: [
      workspace('ws123456', 'Second Brain', 'second-brain'),
      workspace('ws999999', 'Memory', 'memory'),
    ],
  },
  '/api/workspaces/ws123456/ai-rules': {
    rules: [
      rule('doc12345', 'Schreibstil für Johanna', 'always', 'Gilt für jeden Text.'),
      rule('doc22222', 'Abgeschaltete Regel', 'off', null),
    ],
  },
  '/api/workspaces/ws999999/ai-rules': {
    rules: [rule('doc33333', 'Schreibstil für Johanna', 'on_demand', null)],
  },
  '/api/documents/doc12345/export/markdown': markdown('doc12345', 'Keine Gedankenstriche.'),
});

describe('listMcpPrompts', () => {
  it('offers the rule pages of every readable workspace as slash commands', async () => {
    const prompts = await listMcpPrompts(CLIENT);

    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'schreibstil-fuer-johanna',
      // Same title in a second workspace: the menu still needs two distinct names.
      'schreibstil-fuer-johanna-2',
    ]);
    expect(prompts[0]).toMatchObject({
      title: 'Schreibstil für Johanna',
      description: 'Gilt für jeden Text. (Regelseite aus Second Brain, gilt immer)',
      arguments: [],
    });
  });

  it('leaves a switched-off rule out of the menu', async () => {
    const prompts = await listMcpPrompts(CLIENT);
    expect(prompts.map((prompt) => prompt.title)).not.toContain('Abgeschaltete Regel');
  });

  it('says nothing about a workspace whose rules cannot be read', async () => {
    const client = clientReturning({
      '/api/workspaces': { workspaces: [workspace('ws123456', 'Second Brain', 'second-brain')] },
    });
    expect(await listMcpPrompts(client)).toEqual([]);
  });
});

describe('getMcpPrompt', () => {
  it('loads the rule page behind the name as one user message', async () => {
    const prompt = await getMcpPrompt(CLIENT, 'schreibstil-fuer-johanna');

    expect(prompt?.messages).toHaveLength(1);
    expect(prompt?.messages[0]?.role).toBe('user');
    expect(prompt?.messages[0]?.content.text).toContain('Keine Gedankenstriche.');
    expect(prompt?.messages[0]?.content.text).toContain('Schreibstil für Johanna');
  });

  it('answers "no such prompt" instead of guessing', async () => {
    expect(await getMcpPrompt(CLIENT, 'gibt-es-nicht')).toBeNull();
  });
});
