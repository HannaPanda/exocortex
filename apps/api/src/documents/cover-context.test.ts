import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_PROMPT_CHARS } from '@exocortex/ai';
import { type ProseMirrorNode } from '@exocortex/editor';

import {
  composeCoverPrompt,
  MAX_COVER_PASSAGE_CHARS,
  MAX_COVER_TOPICS,
  readCoverMaterial,
} from './cover-context';

/**
 * What a cover learns about its page when the page context is asked for
 * (issue #224): the title, the headings as topics and a summary or the
 * opening, never code, never what is embedded.
 */

const text = (value: string): ProseMirrorNode => ({ type: 'text', text: value });
const paragraph = (value: string): ProseMirrorNode => ({
  type: 'paragraph',
  content: [text(value)],
});
const heading = (level: number, value: string): ProseMirrorNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: 'doc', content });

describe('readCoverMaterial', () => {
  it('names the first three heading levels as topics, once each', () => {
    const material = readCoverMaterial(
      doc(
        heading(1, 'Agenda'),
        paragraph('Wir treffen uns im großen Raum.'),
        heading(2, 'Beschlüsse'),
        heading(4, 'Kleinkram'),
        heading(2, 'agenda'),
      ),
    );
    expect(material.topics).toEqual(['Agenda', 'Beschlüsse']);
    expect(material.opening).toBe('Wir treffen uns im großen Raum.');
  });

  it('reads prose inside lists and quotes, but never code or embeds', () => {
    const material = readCoverMaterial(
      doc(
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('rm -rf /tmp/geheim')] },
        { type: 'media', attrs: { attachmentId: 'a1', alt: 'Bild' } },
        { type: 'fileAttachment', attrs: { attachmentId: 'a2', filename: 'vertrag.pdf' } },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('Pakete installieren')] }],
        },
      ),
    );
    expect(material.opening).toBe('Pakete installieren');
    expect(material.opening).not.toContain('geheim');
    // The language of a code block says what the page is about; the code does not.
    expect(material.topics).toEqual(['bash']);
  });

  it('stops at ten topics and cuts the opening short', () => {
    const headings = Array.from({ length: 14 }, (_, index) => heading(2, `Thema ${index + 1}`));
    const long = 'Wort '.repeat(400);
    const material = readCoverMaterial(doc(...headings, paragraph(long)));
    expect(material.topics).toHaveLength(MAX_COVER_TOPICS);
    expect(material.opening.length).toBeLessThanOrEqual(MAX_COVER_PASSAGE_CHARS + 2);
    expect(material.opening.endsWith('…')).toBe(true);
  });

  it('answers an empty page with nothing', () => {
    expect(readCoverMaterial(null)).toEqual({ topics: [], opening: '' });
  });
});

describe('composeCoverPrompt', () => {
  const page = doc(heading(2, 'Linux-Installation'), paragraph('Skripte für neue Rechner.'));

  it('prefers the digest summary over the opening', () => {
    const composed = composeCoverPrompt({
      prompt: '',
      title: 'Setup',
      summary: 'Wie neue Rechner eingerichtet werden.',
      document: page,
    });
    expect(composed?.context).toEqual({
      title: 'Setup',
      topics: ['Linux-Installation'],
      source: 'summary',
    });
    expect(composed?.prompt).toContain('Wie neue Rechner eingerichtet werden.');
    expect(composed?.prompt).not.toContain('Skripte für neue Rechner');
    // Without an own idea the frame asks for a scene that embodies the theme.
    expect(composed?.prompt).toContain('verkörpert');
  });

  it('puts the person’s own idea first and keeps the context beneath it', () => {
    const composed = composeCoverPrompt({
      prompt: 'Sonnenaufgang am See',
      title: 'Setup',
      summary: null,
      document: page,
    });
    expect(composed?.prompt.startsWith('Sonnenaufgang am See\n')).toBe(true);
    expect(composed?.prompt).toContain('Skripte für neue Rechner.');
    expect(composed?.context.source).toBe('opening');
  });

  it('fits a full prompt and the largest context into what the image model reads', () => {
    const word = 'Überschrift '.repeat(20);
    const composed = composeCoverPrompt({
      prompt: 'x'.repeat(1_000),
      title: 'T'.repeat(500),
      summary: 'Satz '.repeat(500),
      document: doc(...Array.from({ length: 12 }, (_, index) => heading(1, `${index} ${word}`))),
    });
    expect(composed?.prompt.length).toBeLessThanOrEqual(MAX_IMAGE_PROMPT_CHARS);
  });

  it('has nothing to offer for an untitled empty page without a prompt', () => {
    expect(composeCoverPrompt({ prompt: '', title: '', summary: null, document: null })).toBeNull();
  });
});
