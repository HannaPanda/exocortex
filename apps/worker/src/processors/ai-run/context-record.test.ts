import { describe, expect, it } from 'vitest';

import { contextEvent } from './context-record';

describe('the recorded context of a run (issue #145)', () => {
  const event = contextEvent({
    promptSections: [
      { key: 'base_prompt', text: '', items: null, truncated: false, sources: [] },
      {
        key: 'always_rules',
        text: 'Regel A\nRegel B',
        items: 2,
        truncated: true,
        sources: [
          {
            kind: 'rule',
            documentId: 'rule-1',
            databaseViewId: null,
            savedQueryId: null,
            mode: null,
            chars: 7,
            fullChars: null,
            truncated: false,
            origin: 'internal',
          },
        ],
      },
    ],
    notes: [{ key: 'write_mode', message: { role: 'system', content: 'Nur vorschlagen.' } }],
    imageContext: { role: 'system', content: 'Ein Diagramm.' },
    documentId: 'page-1',
    conversation: [
      { role: 'user', content: 'Frage eins' },
      { role: 'assistant', content: 'Antwort' },
      { role: 'user', content: 'Frage zwei' },
    ],
    tools: { offered: 22, schemaChars: 3600, domains: ['core', 'pages'], closedDomains: [] },
  });

  it('measures every part and leaves out the empty ones', () => {
    expect(event.kind).toBe('context');
    if (event.kind !== 'context') return;
    const keys = event.data.sections.map((section) => section.key);
    expect(keys).toEqual([
      'always_rules',
      'write_mode',
      'images',
      'conversation_user',
      'conversation_assistant',
      'tool_schemas',
    ]);
    const user = event.data.sections.find((section) => section.key === 'conversation_user');
    expect(user).toMatchObject({ items: 2, chars: 'Frage einsFrage zwei'.length });
    const tools = event.data.sections.find((section) => section.key === 'tool_schemas');
    expect(tools).toMatchObject({ items: 22, chars: 3600, estimatedTokens: 1000 });
  });

  it('marks image descriptions as text from an uploaded file', () => {
    if (event.kind !== 'context') return;
    const images = event.data.sections.find((section) => section.key === 'images');
    expect(images?.sources[0]).toMatchObject({ documentId: 'page-1', origin: 'attachment' });
  });

  it('keeps no text, only sizes', () => {
    expect(JSON.stringify(event)).not.toContain('Frage eins');
    expect(JSON.stringify(event)).not.toContain('Regel A');
  });
});
