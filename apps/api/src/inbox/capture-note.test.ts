import { describe, expect, it } from 'vitest';

import { buildCaptureNote, fallbackTitle, shortenTitle } from './capture-note';

const AT = new Date('2026-09-18T14:32:00');

describe('buildCaptureNote', () => {
  it('names the note after its first line and does not repeat it in the body', () => {
    const note = buildCaptureNote({ text: 'Kaffee kaufen' }, AT);
    expect(note.title).toBe('Kaffee kaufen');
    expect(note.markdown).toBe('');
  });

  it('keeps everything below the first line', () => {
    const note = buildCaptureNote({ text: '# Idee\n\nEine Inbox, die nichts fragt.' }, AT);
    expect(note.title).toBe('Idee');
    expect(note.markdown).toBe('Eine Inbox, die nichts fragt.');
  });

  it('leaves the text alone when the caller brought a title', () => {
    const note = buildCaptureNote({ text: 'Kaffee kaufen', title: 'Einkauf' }, AT);
    expect(note.title).toBe('Einkauf');
    expect(note.markdown).toBe('Kaffee kaufen');
  });

  it('reads a bare URL as host and path', () => {
    const note = buildCaptureNote({ text: 'https://www.example.com/blog/post/?ref=x' }, AT);
    expect(note.title).toBe('example.com/blog/post');
  });

  it('falls back to the moment of capture when there is no usable line', () => {
    const note = buildCaptureNote({ text: '   \n\n  ' }, AT);
    expect(note.title).toBe('Notiz vom 18.09.2026, 14:32');
    expect(note.markdown).toBe('');
  });

  it('appends the source as an ordinary Markdown line', () => {
    const note = buildCaptureNote(
      { text: 'Etwas Gelesenes', source: 'Ein Blog', sourceUrl: 'https://example.com/a' },
      AT,
    );
    expect(note.markdown).toBe('Quelle: [Ein Blog](https://example.com/a)');
  });

  it('names the address itself when no label came with it', () => {
    const note = buildCaptureNote(
      { text: 'Zeile eins\nZeile zwei', sourceUrl: 'https://example.com/a' },
      AT,
    );
    expect(note.markdown).toBe('Zeile zwei\n\nQuelle: [example.com/a](https://example.com/a)');
  });

  it('drops brackets from a label so the link cannot end early', () => {
    const note = buildCaptureNote(
      { text: 'x', source: 'Titel [mit] Klammern', sourceUrl: 'https://example.com/a' },
      AT,
    );
    expect(note.markdown).toBe('Quelle: [Titel mit Klammern](https://example.com/a)');
  });

  it('strips list and quote markers from the line it takes the title from', () => {
    expect(buildCaptureNote({ text: '- Milch\n- Brot' }, AT).title).toBe('Milch');
    expect(buildCaptureNote({ text: '> Zitat\nRest' }, AT).title).toBe('Zitat');
    expect(buildCaptureNote({ text: '**Fett**\nRest' }, AT).title).toBe('Fett');
  });
});

describe('shortenTitle', () => {
  it('cuts on a word boundary and marks the cut', () => {
    const title = shortenTitle(`${'wort '.repeat(40)}ende`);
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
  });

  it('leaves a short title untouched', () => {
    expect(shortenTitle('  Kurz und gut  ')).toBe('Kurz und gut');
  });
});

describe('fallbackTitle', () => {
  it('pads every field to two digits', () => {
    expect(fallbackTitle(new Date('2026-01-02T03:04:00'))).toBe('Notiz vom 02.01.2026, 03:04');
  });
});
