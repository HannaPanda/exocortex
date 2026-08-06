import { describe, expect, it } from 'vitest';

import { formatOpenPageSection, type OpenPage } from './system-prompt';

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
    const section = formatOpenPageSection({ ...page, type: 'COLLECTION' }, { toolsAvailable: true });

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
    const section = formatOpenPageSection({ ...page, title: '   ', ancestorTitles: [] }, { toolsAvailable: true });

    expect(section).toContain('Titel: Unbenannte Seite');
    expect(section).toContain('Pfad: Unbenannte Seite');
  });
});
