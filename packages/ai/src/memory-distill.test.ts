import { describe, expect, it } from 'vitest';

import {
  MEMORY_CHECKPOINT_PROMPT,
  MEMORY_DISTILL_PROMPT,
  parseMemoryNote,
  renderDistillContext,
  transcriptTail,
} from './memory-distill';

describe('parseMemoryNote', () => {
  it('splits the title line off the body', () => {
    const note = parseMemoryNote(
      'TITEL: Hooks nach tools/ verschoben\n\n- erledigt\n- offen: Plugin',
    );
    expect(note).toEqual({
      title: 'Hooks nach tools/ verschoben',
      body: '- erledigt\n- offen: Plugin',
    });
  });

  it('keeps a note whose title line the model forgot', () => {
    // A formatting slip is not a reason to throw away a summary that was
    // already paid for.
    const note = parseMemoryNote('- etwas gelernt\n- etwas anderes');
    expect(note?.title).toBe('etwas gelernt');
    expect(note?.body).toBe('- etwas gelernt\n- etwas anderes');
  });

  it('writes nothing when the model says there is nothing to keep', () => {
    expect(parseMemoryNote('NICHTS')).toBeNull();
    expect(parseMemoryNote('nichts.')).toBeNull();
    expect(parseMemoryNote('   ')).toBeNull();
  });

  it('writes nothing when only a title came back', () => {
    expect(parseMemoryNote('TITEL: Eine Sitzung')).toBeNull();
  });
});

describe('transcriptTail', () => {
  it('leaves a short transcript alone', () => {
    expect(transcriptTail('kurz', 100)).toBe('kurz');
  });

  it('cuts at a line boundary so no line arrives halved', () => {
    const tail = transcriptTail('erste Zeile\nzweite Zeile\ndritte Zeile', 20);
    expect(tail).toBe('dritte Zeile');
  });
});

describe('renderDistillContext', () => {
  it('leaves the hint line out when there is none', () => {
    expect(renderDistillContext({ projectKey: '/var/www/x', client: 'hermes', hint: null })).toBe(
      'Projekt: /var/www/x\nClient: hermes',
    );
  });
});

describe('the checkpoint prompt', () => {
  it('asks for the same answer shape as the capture prompt', () => {
    // Both kinds of note end up side by side under one project page. If the
    // checkpoint prompt ever stopped asking for `TITEL:`, `parseMemoryNote`
    // would silently fall back to guessing a title from the first bullet.
    expect(MEMORY_CHECKPOINT_PROMPT.startsWith(MEMORY_DISTILL_PROMPT)).toBe(true);
    expect(MEMORY_CHECKPOINT_PROMPT).toContain('Diese Sitzung läuft noch.');
  });
});
