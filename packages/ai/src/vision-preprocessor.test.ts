import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';
import { createVisionPreprocessor } from './registry';
import { VisionPreprocessor } from './vision-preprocessor';

/** The real logger, silenced: a hand-rolled one drifts from the interface. */
function fakeLogger(): Logger {
  return createLogger({ name: 'ai-test', level: 'silent' });
}

const input = {
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'image/png',
  correlationId: 'corr-test',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VisionPreprocessor', () => {
  it('sends the image as a base64 data URI in an OpenAI-style multimodal body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'A red square.' } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const preprocessor = new VisionPreprocessor({
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'qwen/qwen3.7-flash',
      appUrl: 'https://exocortex.test',
      logger: fakeLogger(),
    });

    const description = await preprocessor.describeImage(input);

    expect(description).toBe('A red square.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.test/api/v1/chat/completions');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe('qwen/qwen3.7-flash');
    const imagePart = body.messages[0]?.content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url).toBe('data:image/png;base64,AQID');
  });

  it('throws AiProviderError on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );

    const preprocessor = new VisionPreprocessor({
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'qwen/qwen3.7-flash',
      appUrl: 'https://exocortex.test',
      logger: fakeLogger(),
    });

    await expect(preprocessor.describeImage(input)).rejects.toThrow(AiProviderError);
  });
});

describe('VisionPreprocessor and reasoning models (issue #204)', () => {
  function preprocessor(): VisionPreprocessor {
    return new VisionPreprocessor({
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'vendor/thinking-model',
      appUrl: 'https://exocortex.test',
      logger: fakeLogger(),
    });
  }

  function bodyOf(call: unknown): { max_tokens: number; reasoning?: { effort: string } } {
    const [, init] = call as [string, RequestInit];
    return JSON.parse(init.body as string) as {
      max_tokens: number;
      reasoning?: { effort: string };
    };
  }

  it('asks without reasoning, so the thinking cannot eat the whole answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Ein Diff.' } }] })),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await preprocessor().describeImage(input)).toBe('Ein Diff.');
    expect(bodyOf(fetchMock.mock.calls[0]).reasoning).toEqual({ effort: 'none' });
  });

  it('asks again with room to think when reasoning cannot be switched off', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"Reasoning is mandatory for this endpoint"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Ein Diff.' } }] })),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await preprocessor().describeImage(input)).toBe('Ein Diff.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyOf(fetchMock.mock.calls[1]);
    expect(retry.reasoning).toBeUndefined();
    expect(retry.max_tokens).toBeGreaterThan(bodyOf(fetchMock.mock.calls[0]).max_tokens);
  });

  it('does not retry a 400 that is about something else', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('not a valid model ID', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(preprocessor().describeImage(input)).rejects.toThrow(AiProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createVisionPreprocessor', () => {
  it('returns null when no model is configured', () => {
    const preprocessor = createVisionPreprocessor({
      logger: fakeLogger(),
      appUrl: 'https://exocortex.test',
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
    });
    expect(preprocessor).toBeNull();
  });

  it('returns null when no API key is configured', () => {
    const preprocessor = createVisionPreprocessor({
      logger: fakeLogger(),
      appUrl: 'https://exocortex.test',
      apiKey: '',
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'qwen/qwen3.7-flash',
    });
    expect(preprocessor).toBeNull();
  });

  it('returns a configured preprocessor otherwise', () => {
    const preprocessor = createVisionPreprocessor({
      logger: fakeLogger(),
      appUrl: 'https://exocortex.test',
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'qwen/qwen3.7-flash',
    });
    expect(preprocessor).toBeInstanceOf(VisionPreprocessor);
  });
});
