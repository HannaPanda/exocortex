import { describe, expect, it } from 'vitest';

import { chatAttachmentContext } from './chat-attachments';

describe('chatAttachmentContext', () => {
  it('says nothing for a message without pictures', () => {
    expect(chatAttachmentContext([])).toBeNull();
  });

  it('fences what the vision model saw as content from an uploaded document', () => {
    const message = chatAttachmentContext([
      { filename: 'screenshot.png', description: 'Ein Dialog mit einer Fehlermeldung.' },
    ]);

    expect(message?.role).toBe('system');
    expect(message?.content).toContain('ein Bild angehängt');
    expect(message?.content).toContain('<<<FREMDINHALT aus einem hochgeladenen Dokument');
    expect(message?.content).toContain('1. screenshot.png: Ein Dialog mit einer Fehlermeldung.');
    expect(message?.content).toContain('<<<ENDE FREMDINHALT>>>');
  });

  it('says which picture nobody could look at, outside the fence', () => {
    const message = chatAttachmentContext([
      { filename: 'a.png', description: 'Ein Diagramm.' },
      { filename: 'b.jpg', description: null },
    ]);
    const content = message?.content ?? '';

    expect(content).toContain('2 Bilder angehängt');
    const fenceEnd = content.indexOf('<<<ENDE FREMDINHALT>>>');
    expect(content.indexOf('b.jpg: nicht angesehen')).toBeGreaterThan(fenceEnd);
    expect(content).toContain('statt den Inhalt zu erraten');
  });

  it('opens no fence when no picture was described, so the run read nothing foreign', () => {
    const content = chatAttachmentContext([{ filename: 'b.jpg', description: null }])?.content;
    expect(content).not.toContain('FREMDINHALT');
    expect(content).toContain('b.jpg: nicht angesehen');
  });
});
