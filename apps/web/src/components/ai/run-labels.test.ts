import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { messagesFor } from '@exocortex/i18n/catalog';

import {
  currentPhaseLabel,
  currentToolPage,
  resolveRunLabel,
  type RunLabel,
  type RunTranslator,
  toolActivityLine,
} from './run-labels';
import { type ToolActivityEntry } from './use-ai-run-tracker';

const t: RunTranslator = createTranslator({
  locale: 'de',
  messages: messagesFor('de'),
  namespace: 'ai.run',
});
const german = (label: RunLabel): string => resolveRunLabel(t, label);

const entry = (overrides: Partial<ToolActivityEntry>): ToolActivityEntry => ({
  key: 'k',
  toolName: 'exo_page_read',
  status: 'started',
  target: null,
  subject: null,
  ...overrides,
});

describe('toolActivityLine', () => {
  it('names the tool, what it touched and how it ended', () => {
    expect(german(toolActivityLine(entry({ status: 'succeeded', target: 'document:abc' })))).toBe(
      'Werkzeug exo_page_read (Seite abc) … fertig',
    );
    expect(german(toolActivityLine(entry({ target: 'workspace:w1' })))).toBe(
      'Werkzeug exo_page_read (Arbeitsbereich w1) wird ausgeführt …',
    );
  });

  it('leaves the parentheses out when the call touched nothing named', () => {
    expect(german(toolActivityLine(entry({ status: 'succeeded' })))).toBe(
      'Werkzeug exo_page_read … fertig',
    );
  });

  it('says why a refused call did not run', () => {
    expect(german(toolActivityLine(entry({ status: 'refused' })))).toContain('Fremdinhalte');
  });

  it('passes an unknown target through rather than guessing', () => {
    expect(german(toolActivityLine(entry({ status: 'failed', target: 'plain' })))).toBe(
      'Werkzeug exo_page_read (plain) … fehlgeschlagen',
    );
    expect(german(toolActivityLine(entry({ status: 'failed', target: 'file:f1' })))).toBe(
      'Werkzeug exo_page_read (file f1) … fehlgeschlagen',
    );
  });
});

describe('currentPhaseLabel', () => {
  it('prefers a tool in flight over everything else', () => {
    expect(
      german(currentPhaseLabel([entry({ target: 'document:abc' })], 'text', 'reasoning')),
    ).toBe('Werkzeug exo_page_read (Seite abc) wird ausgeführt');
  });

  it('names the silent phases, then falls back to the text', () => {
    const done = [entry({ status: 'succeeded' })];
    expect(german(currentPhaseLabel(done, '', 'reasoning'))).toBe('KI denkt nach');
    expect(german(currentPhaseLabel(done, '', 'compacting'))).toBe(
      'Älterer Verlauf wird zusammengefasst',
    );
    expect(german(currentPhaseLabel(done, 'Hallo', null))).toBe('Antwort wird geschrieben');
    expect(german(currentPhaseLabel([], '', null))).toBe('Antwort wird erzeugt');
  });
});

describe('currentToolPage', () => {
  it('names the page a running call writes to', () => {
    expect(currentToolPage([entry({ target: 'document:abc', subject: 'document:abc' })])).toEqual({
      documentId: 'abc',
      writing: true,
    });
  });

  it('names the page a running call only reads', () => {
    expect(currentToolPage([entry({ subject: 'document:abc' })])).toEqual({
      documentId: 'abc',
      writing: false,
    });
  });

  it('keeps naming the page after the call, until the next one', () => {
    expect(currentToolPage([entry({ status: 'succeeded', target: 'document:abc' })])).toEqual({
      documentId: 'abc',
      writing: true,
    });
  });

  it('names nothing for a call that did not reach a page or is about none', () => {
    expect(currentToolPage([entry({ status: 'refused', target: 'document:abc' })])).toBeNull();
    expect(currentToolPage([entry({ target: 'workspace:w1' })])).toBeNull();
    expect(currentToolPage([])).toBeNull();
  });
});
