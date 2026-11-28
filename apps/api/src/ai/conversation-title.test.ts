import { describe, expect, it, vi } from 'vitest';

import { type Logger } from '@exocortex/logger';
import { type QueueRegistry, QueueWaitTimeoutError } from '@exocortex/queue';

import { type AiModelResolverService } from './ai-model-resolver.service';
import { type ConversationRow } from './conversation-mapping';
import { suggestConversationTitle, TITLE_SUGGESTION_TIMEOUT_MS } from './conversation-title';

/**
 * The API half of a title suggestion (issue #233): which model the worker is
 * told to use, and how a worker that does not answer in time is reported.
 * The queue and the model registry are stubs.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function conversation(model: { slug: string } | null): ConversationRow {
  return {
    id: 'conv1',
    workspaceId: 'ws1',
    title: 'Wie richte ich nginx ein',
    model: model === null ? null : { slug: model.slug, contextWindowTokens: 100_000 },
  } as unknown as ConversationRow;
}

function setup(answer: () => Promise<unknown>) {
  const enqueueAndWait = vi.fn(answer);
  const modelResolver = {
    resolve: vi.fn(async ({ slug }: { slug: string }) => ({ slug, provider: 'openrouter' })),
    resolveDefault: vi.fn(async () => ({ slug: 'default/model', provider: 'cline-pass' })),
  };
  const dependencies = {
    queues: { enqueueAndWait } as unknown as QueueRegistry,
    logger: logger as unknown as Logger,
    modelResolver: modelResolver as unknown as AiModelResolverService,
  };
  return { dependencies, enqueueAndWait };
}

describe('suggestConversationTitle', () => {
  it("queues the conversation's model and passes the suggestion on", async () => {
    const { dependencies, enqueueAndWait } = setup(async () => ({
      outcome: 'suggested',
      title: 'nginx einrichten',
    }));
    await expect(
      suggestConversationTitle(dependencies, {
        conversation: conversation({ slug: 'chat/model' }),
        userId: 'u1',
        correlationId: 'c1',
      }),
    ).resolves.toEqual({
      conversationId: 'conv1',
      currentTitle: 'Wie richte ich nginx ein',
      suggestion: { outcome: 'suggested', title: 'nginx einrichten' },
    });
    expect(enqueueAndWait).toHaveBeenCalledWith(
      'conversation-title',
      expect.objectContaining({ conversationId: 'conv1', model: 'chat/model' }),
      { timeoutMs: TITLE_SUGGESTION_TIMEOUT_MS },
    );
  });

  it('uses the default model and its provider for a conversation without one', async () => {
    const { dependencies, enqueueAndWait } = setup(async () => ({
      outcome: 'failed',
      reason: 'nothing_to_name',
    }));
    const response = await suggestConversationTitle(dependencies, {
      conversation: conversation(null),
      userId: 'u1',
      correlationId: 'c1',
    });
    expect(response.suggestion).toEqual({ outcome: 'failed', reason: 'nothing_to_name' });
    expect(enqueueAndWait).toHaveBeenCalledWith(
      'conversation-title',
      expect.objectContaining({ model: 'default/model', provider: 'cline-pass' }),
      expect.anything(),
    );
  });

  it('answers timed_out when the worker does not answer in time', async () => {
    const { dependencies } = setup(async () => {
      throw new QueueWaitTimeoutError('conversation-title', TITLE_SUGGESTION_TIMEOUT_MS);
    });
    const response = await suggestConversationTitle(dependencies, {
      conversation: conversation(null),
      userId: 'u1',
      correlationId: 'c1',
    });
    expect(response.suggestion).toEqual({ outcome: 'failed', reason: 'timed_out' });
  });

  it('lets any other failure through', async () => {
    const { dependencies } = setup(async () => {
      throw new Error('redis is gone');
    });
    await expect(
      suggestConversationTitle(dependencies, {
        conversation: conversation(null),
        userId: 'u1',
        correlationId: 'c1',
      }),
    ).rejects.toThrow('redis is gone');
  });
});
