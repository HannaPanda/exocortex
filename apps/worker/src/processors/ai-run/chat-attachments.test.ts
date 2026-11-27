import { describe, expect, it } from 'vitest';

import { chatAttachmentContext } from './chat-attachments';
import { imageInputCount, type RunPromptMessage, withoutImages } from './chat-images';

describe('chatAttachmentContext', () => {
  it('says nothing for a message without pictures', () => {
    expect(chatAttachmentContext([])).toBeNull();
  });

  it('fences what the vision model saw as content from an uploaded document', () => {
    const message = chatAttachmentContext([
      { id: 'f1', filename: 'screenshot.png', description: 'Ein Dialog mit einer Fehlermeldung.' },
    ]);

    expect(message?.role).toBe('system');
    expect(message?.content).toContain('ein Bild angehängt');
    expect(message?.content).toContain('<<<FREMDINHALT aus einem hochgeladenen Dokument');
    expect(message?.content).toContain('1. screenshot.png: Ein Dialog mit einer Fehlermeldung.');
    expect(message?.content).toContain('<<<ENDE FREMDINHALT>>>');
  });

  it('says which picture nobody could look at, outside the fence', () => {
    const message = chatAttachmentContext([
      { id: 'f2', filename: 'a.png', description: 'Ein Diagramm.' },
      { id: 'f3', filename: 'b.jpg', description: null },
    ]);
    const content = message?.content ?? '';

    expect(content).toContain('2 Bilder angehängt');
    const fenceEnd = content.indexOf('<<<ENDE FREMDINHALT>>>');
    expect(content.indexOf('b.jpg: nicht angesehen')).toBeGreaterThan(fenceEnd);
    expect(content).toContain('statt den Inhalt zu erraten');
  });

  it('opens no fence when no picture was described, so the run read nothing foreign', () => {
    const content = chatAttachmentContext([
      { id: 'f4', filename: 'b.jpg', description: null },
    ])?.content;
    expect(content).not.toContain('FREMDINHALT');
    expect(content).toContain('b.jpg: nicht angesehen');
  });

  it('says outside the fence why an own picture still closes writing (ADR-096)', () => {
    const content =
      chatAttachmentContext([
        {
          id: 'fa',
          filename: 'a.png',
          description: 'Ein Text.',
          trust: { trusted: false, reason: 'flagged' },
        },
        {
          id: 'fb',
          filename: 'b.png',
          description: 'Ein Diagramm.',
          trust: { trusted: true, reason: 'own_screened' },
        },
      ])?.content ?? '';
    const fenceEnd = content.indexOf('<<<ENDE FREMDINHALT>>>');
    expect(content.indexOf('a.png: Hinweis')).toBeGreaterThan(fenceEnd);
    expect(content).not.toContain('b.png: Hinweis');
  });

  it('says the picture is in the message itself when it goes as pixels (ADR-097)', () => {
    const message = chatAttachmentContext(
      [
        {
          id: 'p1',
          filename: 'shot.png',
          description: 'Ein Dialog.',
          trust: { trusted: false, reason: 'unscreened' },
        },
      ],
      new Set(['p1']),
    );

    expect(message?.content).toContain('Du siehst es in der Nachricht selbst');
    expect(message?.content).toContain('keine Anweisung an dich');
    expect(message?.content).not.toContain('FREMDINHALT');
    expect(message?.content).toContain('shot.png: Hinweis');
    // The same note as it reads without the pixels: the fenced description.
    expect(message?.withoutImages).toContain('1. shot.png: Ein Dialog.');
    expect(message?.withoutImages).toContain('Du siehst es nicht selbst.');
  });

  it('names the pictures it sees when only some go as pixels', () => {
    const message = chatAttachmentContext(
      [
        { id: 'p1', filename: 'neu.png', description: null },
        { id: 'p2', filename: 'alt.png', description: 'Ein Foto.' },
      ],
      new Set(['p1']),
    );

    expect(message?.content).toContain('In der Nachricht selbst siehst du neu.png');
    expect(message?.content).toContain('1. alt.png: Ein Foto.');
    expect(message?.content).not.toContain('neu.png: nicht angesehen');
  });
});

describe('withoutImages', () => {
  it('drops the pixels and puts the described note in place', () => {
    const prompt: RunPromptMessage[] = [
      { role: 'system', content: 'Prompt' },
      {
        role: 'system',
        content: 'Du siehst es in der Nachricht selbst.',
        withoutImages: 'Beschreibung',
      },
      { role: 'user', content: 'Was steht da?', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
    ];

    expect(imageInputCount(prompt)).toBe(1);
    const described = withoutImages(prompt);
    expect(described).toEqual([
      { role: 'system', content: 'Prompt' },
      { role: 'system', content: 'Beschreibung' },
      { role: 'user', content: 'Was steht da?' },
    ]);
    expect(imageInputCount(described)).toBe(0);
  });
});
