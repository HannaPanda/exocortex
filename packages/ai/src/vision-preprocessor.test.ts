import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';
import { createVisionPreprocessor } from './registry';
import { VisionPreprocessor } from './vision-preprocessor';

function fakeLogger(): Logger {
  const noop = (): void => {
    /* no output in tests */
  };
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
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
