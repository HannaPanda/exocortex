import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import {
  AiImageEmptyError,
  createSolidPng,
  MockImageGenerator,
  OpenRouterImageGenerator,
} from './image-generator';
import { AiProviderError } from './provider';
import { createImageGenerator } from './registry';

const logger = createLogger({ name: 'test', level: 'silent' });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('createSolidPng', () => {
  it('writes a file that starts with the PNG signature and ends with IEND', () => {
    const png = createSolidPng(8, 4, [10, 20, 30]);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.includes(Buffer.from('IHDR', 'ascii'))).toBe(true);
    // IEND is the last chunk: its four type bytes sit just before its CRC.
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('records the dimensions it was given', () => {
    const png = createSolidPng(320, 100, [0, 0, 0]);
    // IHDR data starts 16 bytes in: 8 signature + 4 length + 4 type.
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(100);
  });
});

describe('MockImageGenerator', () => {
  it('returns a real PNG without touching the network', async () => {
    const result = await new MockImageGenerator().generate({
      prompt: 'Berge im Morgennebel',
      correlationId: 'c1',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.data.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('draws the same picture for the same prompt', async () => {
    const generator = new MockImageGenerator();
    const first = await generator.generate({ prompt: 'gleich', correlationId: 'c1' });
    const second = await generator.generate({ prompt: 'gleich', correlationId: 'c2' });
    const other = await generator.generate({ prompt: 'anders', correlationId: 'c3' });

    expect(first.data.equals(second.data)).toBe(true);
    expect(first.data.equals(other.data)).toBe(false);
  });
});

describe('OpenRouterImageGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function generator(): OpenRouterImageGenerator {
    return new OpenRouterImageGenerator({
      apiKey: 'k',
      baseUrl: 'https://example.invalid/api/v1',
      model: 'test/image',
      appUrl: 'https://exocortex.test',
      logger,
    });
  }

  it('decodes the inline image the model returns', async () => {
    const png = createSolidPng(4, 4, [1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await generator().generate({ prompt: 'ein Bild', correlationId: 'c1' });

    expect(result.mimeType).toBe('image/png');
    expect(result.data.equals(png)).toBe(true);
    expect(result.model).toBe('test/image');
  });

  it('reports an answer without a picture instead of returning an empty buffer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'Ich kann das nicht.' } }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    await expect(generator().generate({ prompt: 'x', correlationId: 'c1' })).rejects.toThrow(
      AiProviderError,
    );
  });

  it('reports an HTTP failure with the provider status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );

    await expect(generator().generate({ prompt: 'x', correlationId: 'c1' })).rejects.toThrow(/429/);
  });

  it('asks for the price and reports what the picture cost (issue #252)', async () => {
    const png = createSolidPng(4, 4, [1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'test/image-20261001',
          provider: 'Google',
          usage: { prompt_tokens: 40, completion_tokens: 1290, cost: 0.0387 },
          choices: [
            {
              message: {
                images: [{ image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generator().generate({ prompt: 'ein Bild', correlationId: 'c1' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { usage?: unknown };
    expect(body.usage).toEqual({ include: true });
    expect(result.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 1290,
      provider: 'openrouter',
      servedBy: 'Google',
      model: 'test/image-20261001',
      providerCostMicroUsd: 38_700,
    });
  });

  it('leaves the cost open when the provider named none, rather than calling it free', async () => {
    const png = createSolidPng(4, 4, [1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            usage: { prompt_tokens: 40, completion_tokens: 1290 },
            choices: [
              {
                message: {
                  images: [
                    { image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await generator().generate({ prompt: 'ein Bild', correlationId: 'c1' });

    expect(result.usage.providerCostMicroUsd).toBeNull();
    expect(result.usage.model).toBe('test/image');
  });

  it('keeps the usage of an answer without a picture, because it was still paid for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            usage: { prompt_tokens: 40, completion_tokens: 12, cost: 0.0001 },
            choices: [{ message: { content: 'Ich kann nicht malen.' } }],
          }),
          { status: 200 },
        ),
      ),
    );

    const failure = await generator()
      .generate({ prompt: 'x', correlationId: 'c1' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AiImageEmptyError);
    expect((failure as AiImageEmptyError).usage?.providerCostMicroUsd).toBe(100);
  });

  it('carries the status of a refused key and never the key itself', async () => {
    const apiKey = 'sk-or-v1-testonlynotarealkey000000';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: `User not found for key ${apiKey}` } }), {
          status: 401,
        }),
      ),
    );

    const failure = await new OpenRouterImageGenerator({
      apiKey,
      baseUrl: 'https://example.invalid/api/v1',
      model: 'test/image',
      appUrl: 'https://exocortex.test',
      logger,
    })
      .generate({ prompt: 'x', correlationId: 'c1' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).status).toBe(401);
    expect((failure as AiProviderError).message).not.toContain(apiKey);
    expect((failure as AiProviderError).message).toContain('[key]');
  });
});

describe('createImageGenerator', () => {
  const base = {
    logger,
    appUrl: 'https://exocortex.test',
    apiKey: 'k',
    baseUrl: 'https://example.invalid/api/v1',
  };

  it('gives the mock provider its offline generator', () => {
    expect(createImageGenerator({ ...base, providerId: 'mock', model: null })).toBeInstanceOf(
      MockImageGenerator,
    );
  });

  it('refuses to build one without a model, so nothing paid starts by accident', () => {
    expect(createImageGenerator({ ...base, providerId: 'openrouter', model: null })).toBeNull();
    expect(createImageGenerator({ ...base, providerId: 'openrouter', model: '' })).toBeNull();
  });

  it('refuses to build one without an API key', () => {
    expect(
      createImageGenerator({ ...base, apiKey: '', providerId: 'openrouter', model: 'a/b' }),
    ).toBeNull();
  });

  it('builds an OpenRouter generator once both are configured', () => {
    expect(
      createImageGenerator({ ...base, providerId: 'openrouter', model: 'a/b' }),
    ).toBeInstanceOf(OpenRouterImageGenerator);
  });
});
