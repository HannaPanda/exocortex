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
    const section = formatOpenPageSection(page, true);

    expect(section).toContain('Titel: Steuern 2026');
    expect(section).toContain('Pfad: Finanzen / Steuern / Steuern 2026');
    expect(section).toContain('documentId: doc_steuern');
    expect(section).toContain('Typ: Seite');
  });

  it('never carries the page content, only the pointer to it', () => {
    const section = formatOpenPageSection(page, true);

    expect(section).toContain('`exo_page_read`');
    expect(section).toContain('Der Inhalt steht hier nicht.');
  });

  it('tells the model to admit the gap when it cannot fetch the page itself', () => {
    const section = formatOpenPageSection(page, false);

    expect(section).not.toContain('`exo_page_read`');
    expect(section).toContain('Werkzeuge sind aus');
    expect(section).toContain('erraten');
  });

  it('marks a collection as a collection, so it is not treated as prose', () => {
    const section = formatOpenPageSection({ ...page, type: 'COLLECTION' }, true);

    expect(section).toContain('Typ: Sammlung (Datenbank)');
  });

  it('marks an archived page', () => {
    const section = formatOpenPageSection({ ...page, archived: true }, true);

    expect(section).toContain('Typ: Seite (archiviert)');
  });

  it('shows an elided breadcrumb as elided instead of pretending it is the root', () => {
    const section = formatOpenPageSection({ ...page, pathElided: true }, true);

    expect(section).toContain('Pfad: … / Finanzen / Steuern / Steuern 2026');
  });

  it('falls back to a readable title for an untitled page', () => {
    const section = formatOpenPageSection({ ...page, title: '   ', ancestorTitles: [] }, true);

    expect(section).toContain('Titel: Unbenannte Seite');
    expect(section).toContain('Pfad: Unbenannte Seite');
  });
});
