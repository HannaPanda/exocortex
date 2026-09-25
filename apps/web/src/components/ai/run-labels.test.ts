import { describe, expect, it } from 'vitest';

import { currentPhaseLabel, toolActivityLine } from './run-labels';
import { type ToolActivityEntry } from './use-ai-run-tracker';

const entry = (overrides: Partial<ToolActivityEntry>): ToolActivityEntry => ({
  key: 'k',
  toolName: 'exo_page_read',
  status: 'started',
  target: null,
  ...overrides,
});

describe('toolActivityLine', () => {
  it('names the tool, what it touched and how it ended', () => {
    expect(toolActivityLine(entry({ status: 'succeeded', target: 'document:abc' }))).toBe(
      'Werkzeug exo_page_read (Seite abc) … fertig',
    );
    expect(toolActivityLine(entry({ target: 'workspace:w1' }))).toBe(
      'Werkzeug exo_page_read (Arbeitsbereich w1) wird ausgeführt …',
    );
  });

  it('says why a refused call did not run', () => {
    expect(toolActivityLine(entry({ status: 'refused' }))).toContain('Fremdinhalte');
  });

  it('passes an unknown target through rather than guessing', () => {
    expect(toolActivityLine(entry({ status: 'failed', target: 'plain' }))).toBe(
      'Werkzeug exo_page_read (plain) … fehlgeschlagen',
    );
  });
});

describe('currentPhaseLabel', () => {
  it('prefers a tool in flight over everything else', () => {
    expect(currentPhaseLabel([entry({ target: 'document:abc' })], 'text', 'reasoning')).toBe(
      'Werkzeug exo_page_read (Seite abc) wird ausgeführt',
    );
  });

  it('names the silent phases, then falls back to the text', () => {
    const done = [entry({ status: 'succeeded' })];
    expect(currentPhaseLabel(done, '', 'reasoning')).toBe('KI denkt nach');
    expect(currentPhaseLabel(done, '', 'compacting')).toBe('Älterer Verlauf wird zusammengefasst');
    expect(currentPhaseLabel(done, 'Hallo', null)).toBe('Antwort wird geschrieben');
    expect(currentPhaseLabel([], '', null)).toBe('Antwort wird erzeugt');
  });
});
