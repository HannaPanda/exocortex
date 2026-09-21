import { describe, expect, it } from 'vitest';

import { toolSchemaChars, toolsFor } from './catalog.js';
import { ALWAYS_OFFERED_DOMAINS, openedDomain, selectToolDomains } from './domains.js';

/**
 * Which part of the catalogue a task hears about (issue #121, ADR-060).
 *
 * The property under test is not "the right domains" -- keywords cannot
 * promise that, which is why `exo_toolbox` exists. It is that the selection is
 * deterministic, that it never drops the two domains an everyday task needs,
 * and that what comes out is actually smaller.
 */
describe('selectToolDomains', () => {
  it('always offers the domains an everyday task cannot work without', () => {
    expect(selectToolDomains({ text: '' })).toEqual([...ALWAYS_OFFERED_DOMAINS]);
    expect(selectToolDomains({ text: 'Fass dich kurz.' })).toEqual([...ALWAYS_OFFERED_DOMAINS]);
  });

  it('adds the domain a task names, in German and in a compound', () => {
    expect(selectToolDomains({ text: 'Leg in der Datenbank ToDos eine Zeile an.' })).toContain(
      'databases',
    );
    // The reason the keywords are substrings rather than words: nobody writes
    // "Datenbank Ansicht".
    expect(selectToolDomains({ text: 'Sortier die Datenbankansicht neu.' })).toContain('databases');
    expect(selectToolDomains({ text: 'Bau das LaTeX-Projekt neu.' })).toContain('projects');
    expect(selectToolDomains({ text: 'Archiviere die Seite.' })).toContain('lifecycle');
  });

  it('takes a domain the words cannot say, because the context already knows it', () => {
    // An open database view: the page on screen is a database, and waiting for
    // somebody to write the word would cost the run a turn.
    const domains = selectToolDomains({ text: 'Was steht hier drin?', required: ['databases'] });
    expect(domains).toContain('databases');
  });

  it('answers in one fixed order, so two runs of the same task are comparable', () => {
    const first = selectToolDomains({ text: 'Datenbank und LaTeX-Projekt.' });
    const second = selectToolDomains({ text: 'LaTeX-Projekt und Datenbank.' });
    expect(first).toEqual(second);
  });

  it('cuts the tool list and its schema to a fraction of the catalogue', () => {
    // The measurement issue #121 exists for. Not a fixed number -- the
    // catalogue grows -- but the shape of the win has to survive a refactor.
    const everything = toolsFor('ai');
    const pageTask = toolsFor('ai', {
      domains: selectToolDomains({
        text: 'Verschiebe den Abschnitt „Standort Halle 4“ auf eine eigene Unterseite.',
      }),
    });

    expect(pageTask.length).toBeLessThan(everything.length / 3);
    expect(toolSchemaChars(pageTask)).toBeLessThan(toolSchemaChars(everything) / 3);
    // And it is still a working agent: read, write, and the way back.
    const names = pageTask.map((tool) => tool.name);
    expect(names).toContain('exo_page_read');
    expect(names).toContain('exo_page_extract_section');
    expect(names).toContain('exo_toolbox');
  });
});

describe('openedDomain', () => {
  it('reads the domain out of a toolbox call', () => {
    expect(openedDomain(JSON.stringify({ domain: 'databases' }))).toBe('databases');
  });

  it('answers null for anything that is not one', () => {
    expect(openedDomain(JSON.stringify({ domain: 'erfundenes' }))).toBeNull();
    expect(openedDomain(JSON.stringify({}))).toBeNull();
    expect(openedDomain('kein json')).toBeNull();
  });
});
