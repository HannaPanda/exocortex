import { describe, expect, it, vi } from 'vitest';

import { AiImageEmptyError, AiProviderError, type ImageGenerator } from '@exocortex/ai';
import { type AiUsage, type Settings } from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type RedisEventBus } from '@exocortex/queue';

import { type ResolvedAiKey, WorkspaceKeyUnreadableError } from '../ai-key';

import { createDocumentCoverProcessor } from './document-cover';
import { type ImageRunRecord } from './image-run';

/**
 * Who pays for a cover and what the usage report learns about it (issue #252).
 *
 * No database and no provider: the key resolver, the generator, the API
 * client and the recorder are stubs, so every branch is a question of what
 * was asked of whom. The keys are placeholders, never real secrets.
 */

const WORKSPACE_KEY = 'workspace-test-key';
const DEPLOYMENT_KEY = 'deployment-test-key';

const settings = {
  'ai.enabled': true,
  'ai.imageGenerationEnabled': true,
  'ai.imageModelSlug': 'test/image',
  'ai.timeoutMs': 1_000,
} as unknown as Settings;

const usage: AiUsage = {
  inputTokens: 40,
  outputTokens: 1_290,
  cachedInputTokens: 0,
  provider: 'openrouter',
  servedBy: 'Google',
  model: 'test/image',
  providerCostMicroUsd: 38_700,
  durationMs: 9_000,
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function job(extra: { billingWorkspaceId?: string } = {}) {
  return {
    payload: {
      correlationId: 'c1',
      documentId: 'doc1',
      workspaceId: 'ws1',
      userId: 'u1',
      prompt: 'Berge im Morgennebel',
      ...extra,
    },
    logger,
  } as unknown as Parameters<ReturnType<typeof createDocumentCoverProcessor>>[0];
}

function generatorThat(
  generate: ImageGenerator['generate'],
  provider = 'openrouter',
): ImageGenerator {
  return { model: 'test/image', provider, generate: vi.fn(generate) };
}

function setup(input: {
  key: ResolvedAiKey | WorkspaceKeyUnreadableError;
  generator: ImageGenerator | null;
  settings?: Settings;
}) {
  const records: ImageRunRecord[] = [];
  const published: unknown[] = [];
  const announcedIn: string[] = [];
  const imageGeneratorFor = vi.fn((_slug: string | null, _apiKey?: string) => input.generator);
  const upload = vi.fn(async () => ({ coverAttachmentId: 'att1' }));
  const aiKeyFor = vi.fn(async (_workspaceId: string) => {
    if (input.key instanceof WorkspaceKeyUnreadableError) throw input.key;
    return input.key;
  });
  const settingsFor = vi.fn(async (_workspaceId?: string) => input.settings ?? settings);
  const processor = createDocumentCoverProcessor({
    imageGeneratorFor,
    aiKeyFor,
    recordImageRun: vi.fn(async (record: ImageRunRecord) => {
      records.push(record);
    }),
    apiClientFor: () => ({ upload }) as unknown as ExocortexApiClient,
    bus: {
      publish: vi.fn(async (event: { payload: unknown; workspaceId: string }) => {
        published.push(event.payload);
        announcedIn.push(event.workspaceId);
      }),
    } as unknown as RedisEventBus,
    settings: settingsFor,
  });
  return {
    processor,
    records,
    published,
    announcedIn,
    imageGeneratorFor,
    upload,
    aiKeyFor,
    settingsFor,
  };
}

const picture = async () => ({
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png',
  model: 'test/image',
  usage,
});

describe('createDocumentCoverProcessor', () => {
  it("draws with the workspace's own key and records that it paid", async () => {
    const { processor, records, published, imageGeneratorFor } = setup({
      key: { apiKey: WORKSPACE_KEY, usedOwnKey: true },
      generator: generatorThat(picture),
    });

    await processor(job());

    expect(imageGeneratorFor).toHaveBeenCalledWith('test/image', WORKSPACE_KEY);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: 'ws1',
      documentId: 'doc1',
      userId: 'u1',
      provider: 'openrouter',
      model: 'test/image',
      usedOwnKey: true,
      status: 'COMPLETED',
      errorCode: null,
      usage: { providerCostMicroUsd: 38_700 },
    });
    expect(published).toEqual([expect.objectContaining({ status: 'ready', errorDetail: null })]);
  });

  it("uses the deployment's key only for a workspace without one", async () => {
    const { processor, records, imageGeneratorFor } = setup({
      key: { apiKey: DEPLOYMENT_KEY, usedOwnKey: false },
      generator: generatorThat(picture),
    });

    await processor(job());

    expect(imageGeneratorFor).toHaveBeenCalledWith('test/image', undefined);
    expect(records[0]).toMatchObject({ usedOwnKey: false, status: 'COMPLETED' });
  });

  it.each([
    [401, 'invalid'],
    [402, 'credits'],
  ] as const)(
    'ends on a refused workspace key (%i) without asking the deployment key',
    async (status, reason) => {
      const { processor, records, published, imageGeneratorFor, upload } = setup({
        key: { apiKey: WORKSPACE_KEY, usedOwnKey: true },
        generator: generatorThat(async () => {
          throw new AiProviderError(
            'ai_image_unavailable',
            `Image model responded with ${status}`,
            {
              status,
            },
          );
        }),
      });

      await processor(job());

      expect(imageGeneratorFor).toHaveBeenCalledTimes(1);
      expect(imageGeneratorFor).toHaveBeenCalledWith('test/image', WORKSPACE_KEY);
      expect(upload).not.toHaveBeenCalled();
      expect(published).toEqual([
        expect.objectContaining({
          status: 'failed',
          errorDetail: { code: 'key_refused', reason, ownKey: true },
        }),
      ]);
      expect(records[0]).toMatchObject({
        status: 'FAILED',
        usedOwnKey: true,
        usage: null,
        diagnosis: {
          key: 'keyRefused',
          args: { reason, provider: 'openrouter', model: 'test/image', ownKey: true },
        },
      });
    },
  );

  it.each(['undecryptable', 'noEncryptionKey'] as const)(
    'ends on a workspace key it cannot read (%s) without drawing on the deployment key',
    async (reason) => {
      const generator = generatorThat(picture);
      const { processor, records, published, imageGeneratorFor, upload } = setup({
        key: new WorkspaceKeyUnreadableError(reason),
        generator,
      });

      await processor(job());

      // Issue #260: no generator is built at all, so no key of anybody's is
      // spent, and nothing was asked of a model that the usage report could show.
      expect(imageGeneratorFor).not.toHaveBeenCalled();
      expect(generator.generate).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(records).toHaveLength(0);
      expect(published).toEqual([
        expect.objectContaining({
          status: 'failed',
          errorDetail: { code: 'key_unreadable', reason },
        }),
      ]);
      expect(JSON.stringify(published)).not.toContain(DEPLOYMENT_KEY);
    },
  );

  it('still says image generation is off when the unreadable key does not matter', async () => {
    const { processor, published } = setup({
      key: new WorkspaceKeyUnreadableError('undecryptable'),
      generator: generatorThat(picture),
      settings: { ...settings, 'ai.imageGenerationEnabled': false },
    });

    await processor(job());

    expect(published).toEqual([expect.objectContaining({ errorDetail: { code: 'unavailable' } })]);
  });

  it('records what an answer without a picture cost', async () => {
    const { processor, records, published } = setup({
      key: { apiKey: DEPLOYMENT_KEY, usedOwnKey: false },
      generator: generatorThat(async () => {
        throw new AiImageEmptyError('no picture', usage);
      }),
    });

    await processor(job());

    expect(published).toEqual([
      expect.objectContaining({ errorDetail: { code: 'no_picture', model: 'test/image' } }),
    ]);
    expect(records[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'ai_image_empty',
      usage: { providerCostMicroUsd: 38_700 },
    });
  });

  it('records nothing when no picture was asked for', async () => {
    const { processor, records, published } = setup({
      key: { apiKey: DEPLOYMENT_KEY, usedOwnKey: false },
      generator: null,
    });

    await processor(job());

    expect(records).toHaveLength(0);
    expect(published).toEqual([expect.objectContaining({ errorDetail: { code: 'unavailable' } })]);
  });

  it("never counts the offline generator as the workspace's spending", async () => {
    const { processor, records } = setup({
      key: { apiKey: WORKSPACE_KEY, usedOwnKey: true },
      generator: generatorThat(picture, 'mock'),
    });

    await processor(job());

    expect(records[0]).toMatchObject({ provider: 'mock', usedOwnKey: false });
  });

  describe('on a page the reader reached through a share (issue #264)', () => {
    it("draws with the reader's workspace key, by its settings, and records it there", async () => {
      const { processor, records, published, aiKeyFor, settingsFor, imageGeneratorFor } = setup({
        key: { apiKey: WORKSPACE_KEY, usedOwnKey: true },
        generator: generatorThat(picture),
      });

      await processor(job({ billingWorkspaceId: 'reader-ws' }));

      expect(aiKeyFor).toHaveBeenCalledWith('reader-ws');
      expect(aiKeyFor).not.toHaveBeenCalledWith('ws1');
      expect(settingsFor).toHaveBeenCalledWith('reader-ws');
      expect(imageGeneratorFor).toHaveBeenCalledWith('test/image', WORKSPACE_KEY);
      // The cost lands with the reader; the page is still the one it is about.
      expect(records[0]).toMatchObject({
        workspaceId: 'reader-ws',
        documentId: 'doc1',
        userId: 'u1',
        usedOwnKey: true,
      });
      expect(published).toEqual([expect.objectContaining({ status: 'ready' })]);
    });

    it("stops when the reader's own key cannot be read, and the page's key does not step in", async () => {
      const { processor, records, published, aiKeyFor, imageGeneratorFor } = setup({
        key: new WorkspaceKeyUnreadableError('undecryptable'),
        generator: generatorThat(picture),
      });

      await processor(job({ billingWorkspaceId: 'reader-ws' }));

      expect(aiKeyFor).toHaveBeenCalledTimes(1);
      expect(aiKeyFor).toHaveBeenCalledWith('reader-ws');
      expect(imageGeneratorFor).not.toHaveBeenCalled();
      expect(records).toHaveLength(0);
      expect(published).toEqual([
        expect.objectContaining({
          errorDetail: { code: 'key_unreadable', reason: 'undecryptable' },
        }),
      ]);
    });

    it("still announces the outcome in the page's workspace", async () => {
      const { processor, announcedIn } = setup({
        key: { apiKey: DEPLOYMENT_KEY, usedOwnKey: false },
        generator: generatorThat(picture),
      });

      await processor(job({ billingWorkspaceId: 'reader-ws' }));

      expect(announcedIn).toEqual(['ws1']);
    });
  });
});
