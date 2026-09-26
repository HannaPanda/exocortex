import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';
import { selectToolDomains } from '../domains.js';

import { attentionListTool, attentionRequestTool, attentionResolveTool } from './attention.js';

interface RecordedCall {
  method: string;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
}

function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, query: input.query, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const NOW = '2026-09-26T10:00:00.000Z';

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att12345678',
    workspaceId: 'ws12345678',
    workspaceName: 'Second Brain',
    kind: 'review',
    status: 'open',
    title: 'Bericht fertig',
    reason: 'Bitte gegenlesen',
    urgency: 'normal',
    recipientId: 'user1234567',
    raisedBy: { kind: 'agent', userId: 'user1234567', name: 'Johanna' },
    agentLabel: 'claude-code',
    system: true,
    workItem: { id: 'item1234567', title: 'Bericht', status: 'review' },
    run: null,
    options: [
      { id: 'accept', label: null },
      { id: 'return', label: null },
    ],
    noteMode: 'optional',
    blocking: true,
    context: null,
    action: null,
    workState: null,
    subject: null,
    settledAt: null,
    settledBy: null,
    resolution: null,
    createdAt: NOW,
    ...overrides,
  };
}

const COUNTS = {
  decision: 0,
  approval: 0,
  review: 1,
  blocked: 0,
  budget: 0,
  run_failed: 0,
  conflict: 0,
  information: 0,
};

describe('attention tools', () => {
  it('lists the inbox with the options a system item offers, in words', async () => {
    const { client, calls } = createFakeClient({
      attentionItems: [item()],
      openCounts: COUNTS,
      truncated: false,
    });
    const result = await attentionListTool.run(client, {});
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/attention' });
    expect(result.text).toContain('accept = abnehmen');
    expect(result.text).toContain('Auftrag „Bericht“');
  });

  it('asks in the workspace it was given and passes the options through', async () => {
    const { client, calls } = createFakeClient({
      attentionItem: item({ kind: 'decision', system: false, options: [] }),
    });
    await attentionRequestTool.run(client, {
      workspaceId: 'ws12345678',
      kind: 'decision',
      title: 'Global oder Arbeitsbereich?',
      options: [
        { id: 'global', label: 'Global' },
        { id: 'workspace', label: 'Arbeitsbereich' },
      ],
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/workspaces/ws12345678/attention',
      body: { kind: 'decision', options: [{ id: 'global' }, { id: 'workspace' }] },
    });
  });

  it('pauses the run on a blocking question about work, and only then (issue #140)', async () => {
    const blocking = createFakeClient({
      attentionItem: item({ kind: 'information', system: false, options: [] }),
    });
    const paused = await attentionRequestTool.run(blocking.client, {
      workspaceId: 'ws12345678',
      kind: 'information',
      title: 'Wohin damit?',
      workItemId: 'item1234567',
      workState: 'Entwurf steht.',
    });
    expect(paused.pausesRun).toBe(true);
    expect(paused.text).toContain('Beende diesen Lauf');
    expect(blocking.calls[0]?.body).toMatchObject({ workState: 'Entwurf steht.' });

    const loose = createFakeClient({
      attentionItem: item({ kind: 'information', system: false, options: [], blocking: false }),
    });
    const going = await attentionRequestTool.run(loose.client, {
      workspaceId: 'ws12345678',
      kind: 'information',
      title: 'Nebenbei',
      workItemId: 'item1234567',
      blocking: false,
    });
    expect(going.pausesRun).toBe(false);
  });

  it('shows what an approval is bound to and that the page has moved since', async () => {
    const { client } = createFakeClient({
      attentionItems: [
        item({
          kind: 'approval',
          system: false,
          options: [{ id: 'yes', label: 'Ja' }],
          action: 'Seite leeren',
          subject: [
            { documentId: 'doc12345678', revision: NOW, title: 'Altlasten', changed: true },
          ],
        }),
      ],
      openCounts: COUNTS,
      truncated: false,
    });
    const result = await attentionListTool.run(client, {});
    expect(result.text).toContain('Freizugebende Aktion: Seite leeren');
    expect(result.text).toContain('Altlasten (id: doc12345678, Revision');
    expect(result.text).toContain('seitdem geändert');
  });

  it('resolves with an option and a note', async () => {
    const { client, calls } = createFakeClient({
      attentionItem: item({
        status: 'resolved',
        resolution: { optionId: 'return', note: 'Quellen fehlen' },
      }),
    });
    const result = await attentionResolveTool.run(client, {
      attentionItemId: 'att12345678',
      optionId: 'return',
      note: 'Quellen fehlen',
    });
    expect(calls[0]).toMatchObject({
      path: '/api/attention/att12345678/resolve',
      body: { optionId: 'return', note: 'Quellen fehlen' },
    });
    expect(result.text).toContain('gewählt: return');
  });

  it('offers the attention domain to a run started from a work item', () => {
    const domains = selectToolDomains({
      text: 'Frag mit exo_attention_request (workItemId x), wenn du eine Entscheidung brauchst.',
    });
    expect(domains).toContain('attention');
  });
});
