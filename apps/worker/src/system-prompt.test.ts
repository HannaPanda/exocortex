import { describe, expect, it } from 'vitest';

import { type RenderedConversationSource } from '@exocortex/database';

import { formatOpenPageSection, formatPinnedSourcesSection, type OpenPage } from './system-prompt';

/**
 * Pure formatting tests for the "open page" block. The surrounding
 * `buildSystemPrompt` needs a database and is exercised by the worker's
 * integration suite; what matters here is that the block is a pointer and says
 * so honestly in both tool states.
 */

const page: OpenPage = {
  id: 'doc_steuern',
  title: 'Steuern 2026',
  type: 'PAGE',
  archived: false,
  ancestorTitles: ['Finanzen', 'Steuern'],
  pathElided: false,
};

describe('formatOpenPageSection', () => {
  it('names title, breadcrumb, id and type', () => {
    const section = formatOpenPageSection(page, { toolsAvailable: true });

    expect(section).toContain('Titel: Steuern 2026');
    expect(section).toContain('Pfad: Finanzen / Steuern / Steuern 2026');
    expect(section).toContain('documentId: doc_steuern');
    expect(section).toContain('Typ: Seite');
  });

  it('carries only the pointer while ai.pageContextEnabled is off', () => {
    const section = formatOpenPageSection(page, { toolsAvailable: true });

    expect(section).toContain('`exo_page_read`');
    expect(section).toContain('Der Inhalt steht hier nicht.');
  });

  it('tells the model to admit the gap when it cannot fetch the page itself', () => {
    const section = formatOpenPageSection(page, { toolsAvailable: false });

    expect(section).not.toContain('`exo_page_read`');
    expect(section).toContain('Werkzeuge sind aus');
    expect(section).toContain('erraten');
  });

  it('marks a collection as a collection, so it is not treated as prose', () => {
    const section = formatOpenPageSection(
      { ...page, type: 'COLLECTION' },
      { toolsAvailable: true },
    );

    expect(section).toContain('Typ: Sammlung (Datenbank)');
  });

  it('marks an archived page', () => {
    const section = formatOpenPageSection({ ...page, archived: true }, { toolsAvailable: true });

    expect(section).toContain('Typ: Seite (archiviert)');
  });

  it('shows an elided breadcrumb as elided instead of pretending it is the root', () => {
    const section = formatOpenPageSection({ ...page, pathElided: true }, { toolsAvailable: true });

    expect(section).toContain('Pfad: … / Finanzen / Steuern / Steuern 2026');
  });

  it('carries the text and says it is complete when the content switch is on', () => {
    const section = formatOpenPageSection(page, {
      toolsAvailable: true,
      content: { text: '# Steuern 2026\n\nBelege sammeln.', truncated: false },
    });

    expect(section).toContain('### Inhalt');
    expect(section).toContain('Belege sammeln.');
    expect(section).toContain('vollständige Text');
    expect(section).not.toContain('Der Inhalt steht hier nicht.');
  });

  it('says an excerpt is an excerpt, so "the page does not mention X" stays honest', () => {
    const section = formatOpenPageSection(page, {
      toolsAvailable: true,
      content: { text: 'Nur der Anfang', truncated: true },
    });

    expect(section).toContain('gekürzt');
    expect(section).toContain('`exo_page_read`');
    expect(section).not.toContain('vollständige Text');
  });

  it('does not point at a tool the run cannot use when an excerpt was cut', () => {
    const section = formatOpenPageSection(page, {
      toolsAvailable: false,
      content: { text: 'Nur der Anfang', truncated: true },
    });

    expect(section).toContain('gekürzt');
    expect(section).not.toContain('`exo_page_read`');
    expect(section).toContain('erraten');
  });

  it('describes a collection instead of quoting it, even with the content switch on', () => {
    const section = formatOpenPageSection(
      { ...page, type: 'COLLECTION' },
      {
        toolsAvailable: true,
        collectionDescription: '### Spalten\n- Status (Auswahl: Offen)',
        content: { text: 'sollte nicht erscheinen', truncated: false },
      },
    );

    expect(section).toContain('- Status (Auswahl: Offen)');
    expect(section).toContain('`exo_database_query`');
    expect(section).not.toContain('sollte nicht erscheinen');
  });

  it('falls back to a readable title for an untitled page', () => {
    const section = formatOpenPageSection(
      { ...page, title: '   ', ancestorTitles: [] },
      { toolsAvailable: true },
    );

    expect(section).toContain('Titel: Unbenannte Seite');
    expect(section).toContain('Pfad: Unbenannte Seite');
  });
});

/**
 * The pinned sources block (issue #75). Same rule as the open page: a cut has
 * to be visible in the text, and a run without tools must be told that the
 * names it is given are names it cannot follow.
 */
function source(overrides: Partial<RenderedConversationSource> = {}): RenderedConversationSource {
  return {
    id: 'src_1',
    kind: 'PAGE',
    mode: 'EMBED',
    title: 'Steuern 2026',
    subtitle: 'in Finanzen',
    pointer: 'Den vollständigen Text holst du mit `exo_page_read` und documentId doc_steuern.',
    text: 'Die Frist endet am 31. Juli.',
    fullChars: 27,
    truncated: false,
    empty: false,
    ...overrides,
  };
}

describe('formatPinnedSourcesSection', () => {
  it('renders nothing when nothing is pinned', () => {
    expect(formatPinnedSourcesSection([], { toolsAvailable: true })).toBeNull();
  });

  it('puts an embedded source under its own heading, with its text', () => {
    const section = formatPinnedSourcesSection([source()], { toolsAvailable: true });

    expect(section).toContain('## Angeheftete Quellen');
    expect(section).toContain('### Steuern 2026 (Seite)');
    expect(section).toContain('_in Finanzen_');
    expect(section).toContain('Die Frist endet am 31. Juli.');
  });

  it('states a cut in the text rather than only in the metadata', () => {
    const section = formatPinnedSourcesSection([source({ truncated: true })], {
      toolsAvailable: true,
    });

    expect(section).toContain('die Quelle wurde gekürzt');
    expect(section).toContain('exo_page_read');
  });

  it('tells a tool-less run it cannot fetch the rest of a cut source', () => {
    const section = formatPinnedSourcesSection([source({ truncated: true })], {
      toolsAvailable: false,
    });

    expect(section).toContain('Mehr kannst du in diesem Lauf nicht laden');
    expect(section).not.toContain('exo_page_read');
  });

  it('lists a referenced source as a name with its pointer', () => {
    const section = formatPinnedSourcesSection(
      [source({ mode: 'REFERENCE', text: '', kind: 'SAVED_QUERY', title: 'Offene Aufgaben' })],
      { toolsAvailable: true },
    );

    expect(section).toContain('- Offene Aufgaben (Gespeicherte Suche, in Finanzen)');
    expect(section).not.toContain('### Offene Aufgaben');
  });

  it('says a tool-less run cannot follow a name it was given', () => {
    const section = formatPinnedSourcesSection([source({ mode: 'REFERENCE', text: '' })], {
      toolsAvailable: false,
    });

    expect(section).toContain('nicht laden (Werkzeuge sind aus)');
  });

  it('does not pretend an empty source has content', () => {
    const section = formatPinnedSourcesSection([source({ text: '', empty: true })], {
      toolsAvailable: true,
    });

    expect(section).toContain('Hier steht nichts.');
  });
});
