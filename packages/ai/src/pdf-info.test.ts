import { describe, expect, it } from 'vitest';

import { createLogger, type Logger } from '@exocortex/logger';

import { createPdfDocumentInfoReader } from './pdf-info';

/** The real logger, silenced: a hand-rolled one drifts from the interface. */
function fakeLogger(): Logger {
  return createLogger({ name: 'ai-test', level: 'silent' });
}

/**
 * A one-page PDF written by hand, carrying all five `/Info` entries.
 *
 * Hand-written rather than generated so the fixture is the thing under test:
 * the trailer points `/Info` at object 6, whose Title, Author, Creator,
 * Producer and CreationDate are the exact values asserted below. Verified on
 * 2026-08-06 to be the same file the live Docling container reports nothing
 * about, which is the reason this reader exists.
 */
const PDF_WITH_INFO_DICTIONARY = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK' +
    'PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUg' +
    'L1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8' +
    'IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MSA+' +
    'PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoSGFsbG8gTWV0YWRhdGVuIFRlc3QpIFRqIEVUCmVuZHN0' +
    'cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2' +
    'ZXRpY2EgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1RpdGxlIChRdWFydGFsc2JlcmljaHQgUTMpIC9BdXRob3IgKEpv' +
    'aGFubmEgUGFuZGEpIC9DcmVhdG9yIChIYW5kbWFkZSkgL1Byb2R1Y2VyIChUZXN0ZmFsbCkgL0NyZWF0aW9uRGF0' +
    'ZSAoRDoyMDI2MDQwMTEyMDAwMFopID4+CmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAw' +
    'MDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEg' +
    'MDAwMDAgbiAKMDAwMDAwMDM0MiAwMDAwMCBuIAowMDAwMDAwNDEyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUg' +
    'NyAvUm9vdCAxIDAgUiAvSW5mbyA2IDAgUiA+PgpzdGFydHhyZWYKNTYwCiUlRU9GCg==',
  'base64',
);

describe('createPdfDocumentInfoReader', () => {
  const reader = createPdfDocumentInfoReader({ logger: fakeLogger() });

  it('reads the metadata dictionary out of the file', async () => {
    const info = await reader.read({ data: PDF_WITH_INFO_DICTIONARY, correlationId: 'corr-test' });

    expect(info).toMatchObject({
      extractor: 'pdf-info',
      title: 'Quartalsbericht Q3',
      author: 'Johanna Panda',
      creator: 'Handmade',
      // The document's own producer, not pdf-lib's. Loading a document
      // rewrites both Producer and ModDate unless `updateMetadata` is off, so
      // this assertion is what keeps that option from being dropped.
      producer: 'Testfall',
      createdAt: '2026-04-01T12:00:00.000Z',
      pageCount: 1,
    });
  });

  it('reports nothing about layout, which is what the engines are for', async () => {
    const info = await reader.read({ data: PDF_WITH_INFO_DICTIONARY, correlationId: 'corr-test' });

    // Null means "no source could tell", so claiming zero tables here would be
    // a statement nobody made.
    expect(info).toMatchObject({
      tableCount: null,
      pictureCount: null,
      confidence: null,
      ocrUsed: null,
    });
  });

  it('leaves an absent entry null rather than empty', async () => {
    const info = await reader.read({ data: PDF_WITH_INFO_DICTIONARY, correlationId: 'corr-test' });

    // The fixture has no /ModDate.
    expect(info?.modifiedAt).toBeNull();
  });

  it('returns null for a file it cannot open, instead of failing the job', async () => {
    const info = await reader.read({
      data: Buffer.from('this is not a PDF'),
      correlationId: 'corr-test',
    });

    // A file pdf-lib cannot parse may still be one an OCR engine reads, so an
    // unreadable dictionary must not end the extraction.
    expect(info).toBeNull();
  });
});
