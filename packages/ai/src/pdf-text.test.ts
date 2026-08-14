import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Logger } from '@exocortex/logger';

import { createOpenRouterPdfExtractor } from './pdf-text';

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

function extractor() {
  return createOpenRouterPdfExtractor({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.test/api/v1',
    model: 'test/model',
    appUrl: 'https://exocortex.test',
    logger: fakeLogger(),
  });
}

function respondWith(content: string): void {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
      ),
  );
}

const input = { data: new Uint8Array([1, 2, 3]), filename: 'x.pdf', correlationId: 'corr-test' };

/**
 * The literal responses below were captured from the live `pdf-text` plugin on
 * 2026-08-06, one from a three-page scan and one from a PDF with a text layer.
 */
const SCAN_RESPONSE =
  '# document.pdf\n## Metadata\n- PDFFormatVersion=1.4\n- Title=scan\n' +
  '- CreationDate=D:20260806090613Z\n\n\n\n## Contents\n### Page 1\n\n\n\n\n### Page 2\n\n\n\n\n### Page 3';

const TEXT_LAYER_RESPONSE =
  '# document.pdf\n## Metadata\n- PDFFormatVersion=1.5\n- Creator=LaTeX with hyperref\n' +
  "- CreationDate=D:20260426115610-00'00'\n\n\n\n" +
  '## Contents\n### Page 1\nHermes Kanban\nA durable, profile-aware work-queue architecture.';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenRouterPdfExtractor', () => {
  it('reports a scan as no result even though the response is not empty', async () => {
    // The plugin answers a scan with its skeleton and empty pages. Accepting
    // that would cache PDF header fields as the document text and, worse, would
    // stop the OCR-capable engine behind it from ever being tried.
    respondWith(SCAN_RESPONSE);

    const result = await extractor().extract(input);

    expect(result.text).toBeNull();
    // The metadata dictionary is the one thing the scan did yield, and the OCR
    // engine that reads it next cannot see it, so it has to survive.
    expect(result.metadata).toMatchObject({ title: 'scan', pageCount: 3 });
  });

  it('returns the text of a PDF that has a text layer', async () => {
    respondWith(TEXT_LAYER_RESPONSE);

    const result = await extractor().extract(input);

    expect(result.text).toContain('Hermes Kanban');
    expect(result.metadata?.extractor).toBe('openrouter');
    expect(result.metadata?.ocrUsed).toBe(false);
  });

  it('passes through a response that does not follow the plugin skeleton', async () => {
    // A model that answers in prose instead of the plugin format must not be
    // judged by a marker it never emitted.
    respondWith('Just the plain text of the document, no headings at all.');

    const result = await extractor().extract(input);

    expect(result.text).toBe('Just the plain text of the document, no headings at all.');
  });

  it('reports a scan as no result when the plugin wraps its output in a file element', async () => {
    // Observed against the same document as SCAN_RESPONSE: the model sometimes
    // echoes the plugin's `<file>` wrapper. Without stripping markup the lone
    // closing tag counts as page content.
    respondWith(`<file name="scan.pdf">\n${SCAN_RESPONSE}\n</file>`);

    expect((await extractor().extract(input)).text).toBeNull();
  });

  it('returns null for an empty response', async () => {
    respondWith('   \n  ');

    const result = await extractor().extract(input);

    expect(result.text).toBeNull();
    expect(result.metadata).toBeNull();
  });

  it('reads the PDF metadata dictionary, converting PDF dates to ISO', async () => {
    respondWith(TEXT_LAYER_RESPONSE);

    const { metadata } = await extractor().extract(input);

    expect(metadata).toMatchObject({
      creator: 'LaTeX with hyperref',
      // `D:20260426115610-00'00'` in the PDF's own date format.
      createdAt: '2026-04-26T11:56:10.000Z',
      pageCount: 1,
    });
  });

  it('keeps a zone offset that is not UTC', async () => {
    respondWith(
      "# document.pdf\n## Metadata\n- CreationDate=D:20260426115610+02'00'\n\n" +
        '## Contents\n### Page 1\nGenug Text, damit die Seite als Inhalt zählt.',
    );

    const { metadata } = await extractor().extract(input);

    expect(metadata?.createdAt).toBe('2026-04-26T09:56:10.000Z');
  });
});
