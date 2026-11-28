import { describe, expect, it } from 'vitest';

import {
  carriedFilesContext,
  CHAT_DOCUMENT_PROMPT_CHARS,
  chatDocumentContext,
} from './chat-documents';

describe('chatDocumentContext', () => {
  it('says nothing for a message without documents', () => {
    expect(chatDocumentContext([])).toBeNull();
  });

  it('fences a document text as attachment content', () => {
    const content =
      chatDocumentContext([
        {
          id: 'd1',
          filename: 'brief.pdf',
          state: 'ready',
          text: 'Sehr geehrte Damen',
          truncated: false,
        },
      ]) ?? '';

    expect(content).toContain('eine Datei angehängt');
    expect(content).toContain('<<<FREMDINHALT aus einem hochgeladenen Dokument');
    expect(content).toContain('### brief.pdf');
    expect(content).toContain('Sehr geehrte Damen');
    expect(content).not.toContain('exo_attachment_read_text');
  });

  it('cuts a long text to the budget and says where the rest is, outside the fence', () => {
    const long = 'x'.repeat(CHAT_DOCUMENT_PROMPT_CHARS + 500);
    const content =
      chatDocumentContext([
        { id: 'd2', filename: 'lang.txt', state: 'ready', text: long, truncated: false },
      ]) ?? '';

    expect(content).not.toContain(long);
    const fenceEnd = content.indexOf('<<<ENDE FREMDINHALT>>>');
    expect(content.indexOf('exo_attachment_read_text und der Kennung d2')).toBeGreaterThan(
      fenceEnd,
    ); // The rest is read where it is needed, not from where the prompt stopped (issue #133).
    expect(content).toContain('ohne Bereich kommt die Gliederung');
    expect(content).toContain('fromPage/toPage');
  });

  it('names a document still being read and one that could not be, and fences neither', () => {
    const content =
      chatDocumentContext([
        { id: 'd3', filename: 'neu.pdf', state: 'pending', text: null, truncated: false },
        { id: 'd4', filename: 'kaputt.docx', state: 'failed', text: null, truncated: false },
      ]) ?? '';

    expect(content).toContain('2 Dateien angehängt');
    expect(content).not.toContain('FREMDINHALT');
    expect(content).toContain('neu.pdf: Der Text wird noch gelesen');
    expect(content).toContain('kaputt.docx: Der Text dieser Datei ließ sich nicht lesen');
  });

  it('says outside the fence why an own document still closes writing (ADR-096)', () => {
    const content =
      chatDocumentContext([
        {
          id: 'd5',
          filename: 'fremd.pdf',
          state: 'ready',
          text: 'Inhalt',
          truncated: false,
          trust: { trusted: false, reason: 'flagged' },
        },
      ]) ?? '';
    expect(content.indexOf('fremd.pdf: Hinweis')).toBeGreaterThan(
      content.indexOf('<<<ENDE FREMDINHALT>>>'),
    );
  });
});

describe('carriedFilesContext', () => {
  it('keeps a summarised picture by its description and a document by its name', () => {
    const message = carriedFilesContext([
      { id: 'p1', filename: 'foto.png', picture: true, description: 'Ein Hund am Strand.' },
      { id: 'd1', filename: 'plan.pdf', picture: false, description: null },
    ]);

    expect(message?.role).toBe('system');
    expect(message?.content).toContain('zusammengefassten Nachrichten');
    expect(message?.content).toContain('1. foto.png: Ein Hund am Strand.');
    expect(message?.content).toContain('plan.pdf: Dokument, lesbar mit exo_attachment_read_text');
  });

  it('says nothing when the summarised messages had no files', () => {
    expect(carriedFilesContext([])).toBeNull();
  });
});
