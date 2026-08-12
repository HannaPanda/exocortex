import { describe, expect, it } from 'vitest';

import { type AiProvider } from '@exocortex/ai';
import {
  type MemoryCaptureJob,
  type QUEUE_NAMES,
  resolveSettings,
  type Settings,
} from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

import { createMemoryCaptureProcessor, parseNote } from './memory-capture';

const logger = createLogger({ name: 'worker-test', level: 'silent' });

function settingsWith(rows: { key: string; value: unknown }[]): Settings {
  return resolveSettings({ rows, env: {} }).settings;
}

function job(overrides: Partial<MemoryCaptureJob> = {}): JobContext<typeof QUEUE_NAMES.memoryCapture> {
  const payload: MemoryCaptureJob = {
    correlationId: 'test',
    workspaceId: 'workspace-1234',
    userId: 'user-12345',
    project: '/var/www/exocortex',
    projectKey: '/var/www/exocortex',
    client: 'claude-code',
    sessionId: null,
    transcript: 'user: Was war noch mal mit den Hooks?\n\nassistant: Die liegen in tools/.',
    hint: null,
    startedAt: null,
    ...overrides,
  };
  return { payload, logger } as unknown as JobContext<typeof QUEUE_NAMES.memoryCapture>;
}

/** Records what the processor would have written, and what it was asked to generate. */
function harness(answer: string | Error) {
  const prompts: string[] = [];
  const written: Record<string, unknown>[] = [];

  const provider = {
    generate: async (request: { messages: readonly { content: string }[] }) => {
      prompts.push(request.messages.map((message) => message.content).join('\n'));
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: {}, finishReason: 'stop', toolCalls: [] };
    },
  } as unknown as AiProvider;

  const apiClientFor = (): ExocortexApiClient =>
    ({
      request: async (input: { body?: unknown }) => {
        written.push(input.body as Record<string, unknown>);
        return {
          documentId: 'doc-12345',
          workspaceId: 'workspace-1234',
          title: 'Notiz',
          appended: false,
          url: null,
        };
      },
    }) as unknown as ExocortexApiClient;

  return { prompts, written, provider, apiClientFor };
}

describe('parseNote', () => {
  it('splits the title line off the body', () => {
    const note = parseNote('TITEL: Hooks nach tools/ verschoben\n\n- erledigt\n- offen: Plugin');
    expect(note).toEqual({
      title: 'Hooks nach tools/ verschoben',
      body: '- erledigt\n- offen: Plugin',
    });
  });

  it('keeps a note whose title line the model forgot', () => {
    // A formatting slip is not a reason to throw away a summary that was
    // already paid for.
    const note = parseNote('- etwas gelernt\n- etwas anderes');
    expect(note?.title).toBe('etwas gelernt');
    expect(note?.body).toBe('- etwas gelernt\n- etwas anderes');
  });

  it('writes nothing when the model says there is nothing to keep', () => {
    expect(parseNote('NICHTS')).toBeNull();
    expect(parseNote('nichts.')).toBeNull();
    expect(parseNote('   ')).toBeNull();
  });

  it('writes nothing when only a title came back', () => {
    expect(parseNote('TITEL: Eine Sitzung')).toBeNull();
  });
});

describe('memory capture processor', () => {
  it('writes the distilled note through the API, not the database', async () => {
    const { written, provider, apiClientFor } = harness('TITEL: Gedächtnis gebaut\n\n- AP1 und AP2 stehen');
    const process = createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: async () => settingsWith([]),
      defaultModel: 'test/model',
    });

    await process(job());

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      project: '/var/www/exocortex',
      title: 'Gedächtnis gebaut',
      text: '- AP1 und AP2 stehen',
      client: 'claude-code',
      appendToday: false,
    });
  });

  it('writes nothing when the session was not worth remembering', async () => {
    const { written, provider, apiClientFor } = harness('NICHTS');
    const process = createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: async () => settingsWith([]),
      defaultModel: 'test/model',
    });

    await process(job());
    expect(written).toEqual([]);
  });

  it('survives a provider that fails, because a hook has long since exited', async () => {
    const { written, provider, apiClientFor } = harness(new Error('provider down'));
    const process = createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: async () => settingsWith([]),
      defaultModel: 'test/model',
    });

    await expect(process(job())).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  it('does nothing at all while the memory area is switched off', async () => {
    const { prompts, provider, apiClientFor } = harness('TITEL: X\n\n- y');
    const process = createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: async () => settingsWith([{ key: 'memory.enabled', value: false }]),
      defaultModel: 'test/model',
    });

    await process(job());
    // Not even the model call: the switch is off, so nothing is paid for.
    expect(prompts).toEqual([]);
  });

  it('hands the project and the client to the model as context', async () => {
    const { prompts, provider, apiClientFor } = harness('TITEL: X\n\n- y');
    const process = createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: async () => settingsWith([]),
      defaultModel: 'test/model',
    });

    await process(job({ hint: 'Issue 34' }));

    expect(prompts[0]).toContain('Projekt: /var/www/exocortex');
    expect(prompts[0]).toContain('Client: claude-code');
    expect(prompts[0]).toContain('Hinweis des Clients: Issue 34');
  });
});
