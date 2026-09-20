import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createAnydocExtractor, isOfficeMimeType, OfficeExtractionRefused } from './anydoc';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Parameters<typeof createAnydocExtractor>[0]['logger'];

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function extractorReturning(markdown: string) {
  const toMarkdownBytes = vi.fn().mockResolvedValue(markdown);
  return {
    toMarkdownBytes,
    extractor: createAnydocExtractor({ logger, load: async () => ({ toMarkdownBytes }) }),
  };
}

function extractorRejecting(error: unknown) {
  const toMarkdownBytes = vi.fn().mockRejectedValue(error);
  return {
    toMarkdownBytes,
    extractor: createAnydocExtractor({ logger, load: async () => ({ toMarkdownBytes }) }),
  };
}

const input = { data: new Uint8Array([1, 2, 3]), filename: 'bericht.docx', correlationId: 'c1' };

describe('createAnydocExtractor', () => {
  it('converts a document and reports itself as the engine', async () => {
    const { extractor } = extractorReturning('# Bericht\n\nEin Absatz.');

    const result = await extractor.extract({ ...input, mimeType: DOCX });

    expect(result.text).toBe('# Bericht\n\nEin Absatz.');
    expect(result.metadata?.extractor).toBe('anydoc');
    // Nothing was rendered, so nothing was read off a bitmap. Said explicitly
    // rather than left null, because "no OCR" is a fact about this engine.
    expect(result.metadata?.ocrUsed).toBe(false);
  });

  it('names the format instead of letting the library sniff the bytes again', async () => {
    // What this deployment accepts is decided once, at upload. A second,
    // independent guess inside the converter is how a file could be read as
    // something the allow list never let in.
    const { toMarkdownBytes, extractor } = extractorReturning('x');

    await extractor.extract({ ...input, mimeType: 'text/csv' });

    expect(toMarkdownBytes).toHaveBeenCalledWith(input.data, 'csv');
  });

  it('leaves the page count and the dates unset rather than inventing them', async () => {
    const { extractor } = extractorReturning('# Bericht');

    const result = await extractor.extract({ ...input, mimeType: DOCX });

    // A docx has no page count until something lays it out. Null is the
    // honest answer the schema is built for; zero would be a claim.
    expect(result.metadata?.pageCount).toBeNull();
    expect(result.metadata?.createdAt).toBeNull();
  });

  it('reports an empty conversion as no text rather than as an empty string', async () => {
    const { extractor } = extractorReturning('   \n\n  ');

    const result = await extractor.extract({ ...input, mimeType: DOCX });

    expect(result.text).toBeNull();
    // The metadata survives: "this converted, and there was nothing in it" is
    // a different answer from "this could not be converted".
    expect(result.metadata?.extractor).toBe('anydoc');
  });

  it.each([
    ['encrypted', 'passwortgeschützt'],
    ['malformed', 'beschädigt'],
    ['unsupported', 'kann nicht gelesen werden'],
    ['missingPart', 'fehlt ein Teil'],
  ])('turns a %s document into a settled refusal a reader can act on', async (code, phrase) => {
    const { extractor } = extractorRejecting(Object.assign(new Error('raw'), { code }));

    await expect(extractor.extract({ ...input, mimeType: DOCX })).rejects.toThrow(
      OfficeExtractionRefused,
    );
    await expect(extractor.extract({ ...input, mimeType: DOCX })).rejects.toThrow(
      new RegExp(phrase),
    );
  });

  it('rethrows anything that is not about this document', async () => {
    // A broken native binding or an out-of-memory says nothing about the file,
    // so the job has to retry rather than the attachment being written off.
    const { extractor } = extractorRejecting(new Error('binding not loaded'));

    const failure = extractor.extract({ ...input, mimeType: DOCX });

    await expect(failure).rejects.toThrow('binding not loaded');
    await expect(failure).rejects.not.toBeInstanceOf(OfficeExtractionRefused);
  });

  it('refuses a MIME type it has no format for, without loading the library', async () => {
    const load = vi.fn();
    const extractor = createAnydocExtractor({ logger, load });

    await expect(extractor.extract({ ...input, mimeType: 'application/pdf' })).rejects.toThrow(
      OfficeExtractionRefused,
    );
    expect(load).not.toHaveBeenCalled();
  });
});

/**
 * Against the real library rather than a stub, and against real files rather
 * than bytes assembled here.
 *
 * Everything above proves this file's own logic and would pass just as happily
 * with a native binding that does not load at all. These two are what say the
 * converter converts: the fixtures are a Word document and a CSV, and the
 * assertions are about the text a person would expect to find in them.
 */
describe('createAnydocExtractor against the installed library', () => {
  const extractor = createAnydocExtractor({ logger });
  // Relative to the package root, which is where both vitest and `turbo run`
  // start this workspace. `import.meta` would be the obvious spelling and is a
  // compile error here, because the package's typecheck covers its tests and
  // the package builds to CommonJS.
  const fixture = (name: string): Promise<Buffer> =>
    readFile(join(process.cwd(), 'src/__fixtures__', name));

  it('reads the headings, the paragraph and the table out of a Word document', async () => {
    const result = await extractor.extract({
      data: await fixture('bericht.docx'),
      filename: 'bericht.docx',
      mimeType: DOCX,
      correlationId: 'c1',
    });

    expect(result.text).toContain('Quartalsbericht');
    expect(result.text).toContain('Umsatz');
    // Umlauts survive the round trip, which is what a German corpus lives on.
    expect(result.text).toContain('Größenänderung');
    expect(result.metadata?.extractor).toBe('anydoc');
  });

  it('reads a CSV it was told is a CSV', async () => {
    // The format has no signature, so this is the case that would fail if the
    // MIME type stopped being passed through.
    const result = await extractor.extract({
      data: await fixture('zahlen.csv'),
      filename: 'zahlen.csv',
      mimeType: 'text/csv',
      correlationId: 'c1',
    });

    expect(result.text).toContain('Nord');
    expect(result.text).toContain('1200');
  });
});

describe('isOfficeMimeType', () => {
  it('claims the twelve formats the converter reads', () => {
    expect(isOfficeMimeType(DOCX)).toBe(true);
    expect(isOfficeMimeType('application/vnd.ms-excel')).toBe(true);
    expect(isOfficeMimeType('text/csv')).toBe(true);
  });

  it('claims neither PDF nor anything else', () => {
    // PDF has its own chain, and only that chain can read a scan.
    expect(isOfficeMimeType('application/pdf')).toBe(false);
    expect(isOfficeMimeType('image/png')).toBe(false);
    expect(isOfficeMimeType('application/zip')).toBe(false);
  });
});
