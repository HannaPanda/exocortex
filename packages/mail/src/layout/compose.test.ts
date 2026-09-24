import { describe, expect, it } from 'vitest';

import { type MailMessage } from '@exocortex/contracts';

import { MAIL_EXAMPLES } from '../examples';
import { renderMail } from '../render';

import { composeMail } from './compose';
import { type MailContent } from './content';

/**
 * The layout every mail is drawn in (issue #109).
 *
 * Three things are worth asserting here rather than by looking: that the
 * markup is well-formed enough for a client to parse, that nothing a person
 * or a model wrote can become markup, and that the text part says what the
 * HTML part says. The look itself is pinned by one file snapshot of the base
 * template, which doubles as the page to open when checking it by eye.
 */

const VOID_ELEMENTS = new Set(['meta', 'br', 'img', 'hr', 'link', 'input']);

/**
 * Every opened element is closed, in order. Comments go first: the Outlook
 * conditionals are comments that contain half a table on purpose.
 */
function unbalancedTags(html: string): string[] {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
  const stack: string[] = [];
  const problems: string[] = [];
  for (const match of stripped.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    if (VOID_ELEMENTS.has(name)) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    const open = stack.pop();
    if (open !== name) problems.push(`</${name}> closes <${open ?? 'nothing'}>`);
  }
  return [...problems, ...stack.map((name) => `<${name}> never closed`)];
}

const examples = Object.values(MAIL_EXAMPLES) as MailMessage[];

describe('every template in the shared layout', () => {
  it.each(examples.map((message) => [message.template, message] as const))(
    '%s renders well-formed HTML and a text part',
    (_template, message) => {
      const mail = renderMail(message);

      expect(mail.html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(mail.html).toContain('<html lang="de">');
      expect(unbalancedTags(mail.html)).toEqual([]);
      // The wordmark comes from the layout, not from the template.
      expect(mail.html).toContain('ocortex</td>');
      expect(mail.text).not.toMatch(/<[a-z/][^>]*>/i);
      expect(mail.text.trimEnd().endsWith('eXocortex')).toBe(true);
    },
  );

  it.each(examples.map((message) => [message.template, message] as const))(
    '%s links the same addresses in both parts',
    (_template, message) => {
      const mail = renderMail(message);
      const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) =>
        (match[1] ?? '').replaceAll('&amp;', '&'),
      );

      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(mail.text).toContain(href);
    },
  );
});

describe('escaping', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';

  it('never lets a title, a name or a comment become markup', () => {
    const mail = renderMail({
      template: 'COMMENT_DIGEST',
      commentCount: 1,
      morePages: 0,
      pages: [
        {
          title: hostile,
          url: 'https://exocortex.app/arbeitsbereich/w1/seite/d1',
          moreComments: 0,
          comments: [{ authorName: hostile, preview: `"><style>*{display:none}</style>` }],
        },
      ],
    });

    expect(mail.html).not.toContain('<script');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<style');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('onerror=&quot;alert(2)&quot;');
    // The text part is text: it keeps the characters as they were written.
    expect(mail.text).toContain(hostile);
  });

  it('keeps an automation page as text rather than rendering it', () => {
    const mail = renderMail({
      ...MAIL_EXAMPLES.AUTOMATION_PAGE,
      body: `# Überschrift\n\n${hostile}\n\n<a href="https://evil.example">klick</a>`,
    });

    expect(mail.html).not.toContain('<script');
    expect(mail.html).not.toContain('href="https://evil.example"');
    expect(mail.html).toContain('# Überschrift');
  });

  it('turns no address into a link that is not http or https', () => {
    const mail = composeMail({
      subject: 'Test',
      preheader: 'Test',
      heading: 'Test',
      blocks: [
        { kind: 'action', label: 'Los', url: 'javascript:alert(1)' },
        { kind: 'link', label: 'Weiter', url: 'data:text/html,<b>x</b>' },
      ],
    });

    expect(mail.html).not.toContain('href="javascript:');
    expect(mail.html).not.toContain('href="data:');
    expect(mail.html).toContain('Los');
  });
});

describe('the parts of the layout', () => {
  const plain: MailContent = {
    subject: 'eXocortex: Ohne Knopf',
    preheader: 'Vorschauzeile',
    heading: 'Nur Text',
    greeting: 'Hallo,',
    blocks: [{ kind: 'paragraph', text: 'Hier gibt es nichts zu klicken.' }],
  };

  it('draws no button for a mail without an action', () => {
    const mail = composeMail(plain);
    expect(mail.html).not.toContain('Falls der Knopf nicht funktioniert');
    expect(mail.html).not.toContain('href=');
  });

  it('draws a button with its address written out beneath it', () => {
    const url = 'https://exocortex.app/einladung/abc';
    const mail = composeMail({
      ...plain,
      blocks: [...plain.blocks, { kind: 'action', label: 'Konto anlegen', url }],
    });

    expect(mail.html.match(new RegExp(`href="${url}"`, 'g'))?.length).toBe(2);
    expect(mail.html).toContain('Falls der Knopf nicht funktioniert');
    expect(mail.text).toContain(`Konto anlegen:\n${url}`);
  });

  it('carries the preheader hidden and the subject as the document title', () => {
    const mail = composeMail(plain);
    expect(mail.html).toContain('display:none');
    expect(mail.html).toContain('Vorschauzeile');
    expect(mail.html).toContain('<title>eXocortex: Ohne Knopf</title>');
    // The preheader is for the inbox list; the text part has the subject.
    expect(mail.text).not.toContain('Vorschauzeile');
  });

  it('lets long titles and addresses wrap instead of widening the sheet', () => {
    const url = `https://exocortex.app/arbeitsbereich/w1/seite/${'x'.repeat(400)}`;
    const title = 'Ein sehr langer Titel '.repeat(9).trim();
    const mail = renderMail({ ...MAIL_EXAMPLES.SHARE_GRANTED, documentTitle: title, url });

    expect(mail.html).toContain('max-width:600px');
    expect(mail.html).toContain('overflow-wrap:anywhere');
    expect(mail.html).toContain('word-break:break-all');
    // Not broken anywhere in the text part, or it stops being a link.
    expect(mail.text.split('\n')).toContain(url);
    expect(mail.text).toContain(title);
  });

  it('gives every page of a digest its own section', () => {
    const mail = renderMail(MAIL_EXAMPLES.COMMENT_DIGEST);
    expect(mail.html.match(/<h2 /g)?.length).toBe(2);
    expect(mail.html).toContain('Claude Code Setup');
    expect(mail.html).toContain('Projektideen');
    expect(mail.html).toContain('und 3 weitere');
  });

  it('says the same thing in both parts', () => {
    for (const message of examples) {
      const mail = renderMail(message);
      for (const line of mail.text.split('\n')) {
        const words = line.replace(/^- /, '').replace(/:$/, '').trim();
        if (words.length === 0 || words === '---') continue;
        // Every piece of text is in the HTML, modulo the escaping and the
        // label/colon arrangement of lists and facts.
        for (const piece of words.split(': ')) {
          expect(
            mail.html.replaceAll('&quot;', '"').replaceAll('&#39;', "'"),
            `${message.template}: ${piece}`,
          ).toContain(piece.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
        }
      }
    }
  });
});

/**
 * The base template, pinned. A changed file here is a changed look for every
 * mail this deployment sends, which is worth a line in the commit that does
 * it. The file is also the quickest way to see the layout: open it in a
 * browser.
 */
describe('the base template', () => {
  it('matches the recorded markup', async () => {
    const mail = composeMail({
      subject: 'eXocortex: Alle Bausteine',
      preheader: 'Jeder Baustein des Layouts einmal.',
      heading: 'Alle Bausteine',
      greeting: 'Hallo,',
      blocks: [
        { kind: 'paragraph', text: 'Ein Absatz.\nMit einem Zeilenumbruch.' },
        { kind: 'facts', rows: [{ label: 'Erlaubt', value: 'Nur Lesen' }] },
        { kind: 'notice', text: 'Ein Hinweis, der auffallen soll.' },
        { kind: 'action', label: 'Hauptaktion', url: 'https://exocortex.app/a' },
        {
          kind: 'section',
          title: 'Ein Abschnitt',
          items: [{ label: 'Stefan', text: 'Ein Zitat.', quoted: true }],
          more: 'und 2 weitere',
          link: { label: 'Zur Seite', url: 'https://exocortex.app/b' },
        },
        { kind: 'excerpt', text: '## Überschrift\n\n- ein Punkt' },
        { kind: 'link', label: 'Ein Link', url: 'https://exocortex.app/c' },
      ],
      footer: ['Warum du diese Mail bekommst.'],
    });

    await expect(mail.html).toMatchFileSnapshot('./__snapshots__/base.html');
    await expect(mail.text).toMatchFileSnapshot('./__snapshots__/base.txt');
  });
});
