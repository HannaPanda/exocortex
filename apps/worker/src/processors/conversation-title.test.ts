import { describe, expect, it, vi } from 'vitest';

import { type AiProvider } from '@exocortex/ai';
import { type Settings } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { WorkspaceKeyUnreadableError } from '../ai-key';

import {
  cleanSuggestedTitle,
  createConversationTitleProcessor,
  TITLE_MESSAGE_MAX_CHARS,
  TITLE_TRANSCRIPT_MAX_CHARS,
  titleTranscript,
} from './conversation-title';

/**
 * A title suggested on request (issue #233). No database and no provider: the
 * message query, the key resolution and the model are stubs, so every case is
 * a question of what was read and what came back.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function job() {
  return {
    payload: {
      correlationId: 'c1',
      conversationId: 'conv1',
      workspaceId: 'ws1',
      userId: 'u1',
      model: 'chat/model',
      provider: 'openrouter',
    },
    logger,
  } as unknown as Parameters<ReturnType<typeof createConversationTitleProcessor>>[0];
}

function setup(input: {
  messages: { role: string; content: string }[];
  answer?: string | Error;
  key?: Error;
  compactionModel?: string | null;
}) {
  const findMany = vi.fn(async () => input.messages);
  const generate = vi.fn(async () => {
    if (input.answer instanceof Error) throw input.answer;
    return { text: input.answer ?? 'Titel', usage: {}, finishReason: 'stop', toolCalls: [] };
  });
  const provider = { generate } as unknown as AiProvider;
  const providerFor = vi.fn(async () => {
    if (input.key !== undefined) throw input.key;
    return { provider, key: { apiKey: 'test-key', usedOwnKey: false }, openRouter: provider };
  });
  const processor = createConversationTitleProcessor({
    prisma: { aiConversationMessage: { findMany } } as unknown as PrismaClient,
    settings: async () =>
      ({ 'ai.compactionModelSlug': input.compactionModel ?? null }) as unknown as Settings,
    providerFor,
  });
  return { processor, findMany, generate, providerFor };
}

describe('titleTranscript', () => {
  it('is empty without a message that says anything', () => {
    expect(titleTranscript([])).toBe('');
    expect(titleTranscript([{ role: 'USER', content: '   ' }])).toBe('');
  });

  it('names who spoke and collapses whitespace', () => {
    expect(
      titleTranscript([
        { role: 'USER', content: 'Wie  richte ich\nnginx ein?' },
        { role: 'ASSISTANT', content: 'So geht es.' },
      ]),
    ).toBe('Person: Wie richte ich nginx ein?\n\nAssistent: So geht es.');
  });

  it('cuts a long message on its own', () => {
    const transcript = titleTranscript([{ role: 'USER', content: 'a'.repeat(5_000) }]);
    expect(transcript.length).toBe('Person: '.length + TITLE_MESSAGE_MAX_CHARS);
    expect(transcript.endsWith('…')).toBe(true);
  });

  it('keeps the first message and the newest ones, and marks the gap', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('USER' as const) : ('ASSISTANT' as const),
      content: `Nachricht ${String(index)} ${'x'.repeat(400)}`,
    }));
    const transcript = titleTranscript(messages);
    expect(transcript.length).toBeLessThanOrEqual(TITLE_TRANSCRIPT_MAX_CHARS + 10);
    expect(transcript.startsWith('Person: Nachricht 0 ')).toBe(true);
    expect(transcript).toContain('[…]');
    expect(transcript).toContain('Nachricht 39 ');
    expect(transcript).not.toContain('Nachricht 1 ');
  });
});

describe('cleanSuggestedTitle', () => {
  it.each([
    ['nginx als Reverse Proxy einrichten', 'nginx als Reverse Proxy einrichten'],
    ['„Umzug der Backups“', 'Umzug der Backups'],
    ['Titel: Backups auf MEGA.', 'Backups auf MEGA'],
    ['**Steuererklärung 2026**', 'Steuererklärung 2026'],
    ['\n\n# Kalender-Sync\nWeil es um den Kalender ging.', 'Kalender-Sync'],
    ['"Deploy-Pipeline"', 'Deploy-Pipeline'],
  ])('turns %j into %j', (raw, expected) => {
    expect(cleanSuggestedTitle(raw)).toBe(expected);
  });

  it('answers null for nothing usable', () => {
    expect(cleanSuggestedTitle('')).toBeNull();
    expect(cleanSuggestedTitle('  \n  ')).toBeNull();
    expect(cleanSuggestedTitle('""')).toBeNull();
  });

  it('cuts a long answer at a word', () => {
    const title = cleanSuggestedTitle(
      'Eine sehr lange Überschrift über die Einrichtung eines Servers mit vielen Diensten darauf',
    );
    expect(title).not.toBeNull();
    expect((title as string).length).toBeLessThanOrEqual(60);
    expect((title as string).endsWith(' ')).toBe(false);
    expect('Eine sehr lange Überschrift über die Einrichtung eines Servers').toContain(
      title as string,
    );
  });
});

describe('createConversationTitleProcessor', () => {
  it('suggests a title from the person and the assistant only', async () => {
    const { processor, findMany, generate } = setup({
      messages: [
        { role: 'USER', content: 'Wie richte ich nginx ein?' },
        { role: 'ASSISTANT', content: 'Mit einem Server-Block.' },
      ],
      answer: '„nginx einrichten“',
    });
    await expect(processor(job())).resolves.toEqual({
      outcome: 'suggested',
      title: 'nginx einrichten',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversationId: 'conv1',
          role: { in: ['USER', 'ASSISTANT'] },
          isSummary: false,
        }),
      }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'chat/model',
        messages: [
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Person: Wie richte ich nginx ein?'),
          }),
        ],
      }),
    );
  });

  it('writes with the compaction model when one is configured', async () => {
    const { processor, generate } = setup({
      messages: [{ role: 'USER', content: 'Frage' }],
      compactionModel: 'cheap/summary',
    });
    await processor(job());
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'cheap/summary' }));
  });

  it('asks no model for an empty conversation', async () => {
    const { processor, providerFor, generate } = setup({ messages: [] });
    await expect(processor(job())).resolves.toEqual({
      outcome: 'failed',
      reason: 'nothing_to_name',
    });
    expect(providerFor).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('says so when the workspace key cannot be read', async () => {
    const { processor, generate } = setup({
      messages: [{ role: 'USER', content: 'Frage' }],
      key: new WorkspaceKeyUnreadableError('undecryptable'),
    });
    await expect(processor(job())).resolves.toEqual({
      outcome: 'failed',
      reason: 'key_unreadable',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('answers provider_failed for a failing or empty model', async () => {
    const failing = setup({
      messages: [{ role: 'USER', content: 'Frage' }],
      answer: new Error('boom'),
    });
    await expect(failing.processor(job())).resolves.toEqual({
      outcome: 'failed',
      reason: 'provider_failed',
    });
    const empty = setup({ messages: [{ role: 'USER', content: 'Frage' }], answer: '  ' });
    await expect(empty.processor(job())).resolves.toEqual({
      outcome: 'failed',
      reason: 'provider_failed',
    });
  });
});
