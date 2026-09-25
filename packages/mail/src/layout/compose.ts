import { type Locale } from '@exocortex/contracts';

import { mailLanguage } from '../translator';
import { type RenderedMail } from '../types';

import { type MailBlock, type MailContent, type MailListItem } from './content';
import { type MailTheme, mailTheme } from './theme';

/**
 * The one layout every mail from this deployment is drawn in (issue #109).
 *
 * Both parts come from the same `MailContent`: the plain text is not a
 * stripped copy of the HTML and the HTML is not a decorated copy of the text,
 * so neither can say something the other does not.
 *
 * The HTML is written for mail clients, not for browsers: tables for layout,
 * every style inline, no script, no web font, no image. Nothing a reader needs
 * depends on CSS arriving -- a link is a real `<a href>` with its address
 * beside it, and a client that drops every style still shows a readable
 * sequence of headings, paragraphs and links.
 */
export function composeMail(
  content: MailContent,
  locale: Locale,
  theme: MailTheme = mailTheme,
): RenderedMail {
  return {
    subject: content.subject,
    text: renderText(content, locale),
    html: renderHtml(content, locale, theme),
  };
}

/**
 * The few words the layout says on its own, in the reader's language: the
 * line under a button and the quotation marks around a quoted item, which are
 * „so“ in German and "so" in English.
 */
interface LayoutWords {
  buttonFallback: string;
  quote: (text: string) => string;
}

function layoutWords(locale: Locale): LayoutWords {
  const { t } = mailLanguage(locale);
  return {
    buttonFallback: t('layout.buttonFallback'),
    quote: (text) => t('layout.quote', { text }),
  };
}

// ---------------------------------------------------------------------------
// Plain text

/**
 * The text part. Not hard-wrapped: a URL broken at column 72 stops being a
 * link, and every client wraps prose on its own.
 */
export function renderText(content: MailContent, locale: Locale): string {
  const words = layoutWords(locale);
  const lines: string[] = [];
  if (content.greeting !== undefined) lines.push(content.greeting, '');
  for (const block of content.blocks) lines.push(...textBlock(words, block), '');
  if (content.footer !== undefined && content.footer.length > 0) {
    lines.push(...content.footer, '');
  }
  lines.push('eXocortex');
  return lines.join('\n');
}

function textBlock(words: LayoutWords, block: MailBlock): string[] {
  switch (block.kind) {
    case 'paragraph':
    case 'notice':
      return [block.text];
    case 'action':
    case 'link':
      return [`${block.label}:`, block.url];
    case 'facts':
      return block.rows.map((row) => `${row.label}: ${row.value}`);
    case 'section': {
      const lines = [block.title, ...block.items.map((item) => `- ${textItem(words, item)}`)];
      if (block.more !== undefined) lines.push(`- ${block.more}`);
      if (block.link !== undefined) lines.push(`${block.link.label}:`, block.link.url);
      return lines;
    }
    case 'excerpt':
      return ['---', '', block.text, '', '---'];
  }
}

function textItem(words: LayoutWords, item: MailListItem): string {
  const text = item.quoted === true ? words.quote(item.text) : item.text;
  return item.label === undefined ? text : `${item.label}: ${text}`;
}

// ---------------------------------------------------------------------------
// HTML

/** Everything that reaches the markup goes through here, attributes included. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * An address that may become an `href`: http and https, nothing else.
 *
 * Every link a template writes points back into this deployment, so this
 * refuses nothing today. It is here because an `href` is the one attribute
 * where escaping is not enough -- `javascript:` survives it intact.
 */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
}

/** Escaped text with its line breaks kept. */
function inline(value: string): string {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

/**
 * The HTML part. `locale` is the reader's: it is the document's `lang`, which
 * is what a screen reader picks its voice by, and it chooses the one sentence
 * the layout says on its own (the fallback under a button).
 */
export function renderHtml(
  content: MailContent,
  locale: Locale,
  theme: MailTheme = mailTheme,
): string {
  const t = theme;
  const words = layoutWords(locale);
  const body = [
    content.greeting === undefined ? '' : paragraph(t, inline(content.greeting)),
    ...content.blocks.map((block) => htmlBlock(t, words, block)),
  ].join('\n');

  const footer =
    content.footer === undefined || content.footer.length === 0
      ? ''
      : `<tr><td style="padding:0 32px 8px 32px;"><div style="border-top:1px solid ${t.rule};padding-top:16px;">${content.footer
          .map(
            (line) =>
              `<p style="margin:0 0 8px 0;font-family:${t.fontFamily};font-size:13px;line-height:1.5;color:${t.mutedText};">${inline(line)}</p>`,
          )
          .join('')}</div></td></tr>`;

  // `color-scheme: light` asks the clients that honour it not to invert the
  // sheet. The ones that invert anyway get a layout without dark-on-dark
  // traps: every text colour sits on a background this file also sets.
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${t.canvas};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${t.canvas};">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="${String(t.maxWidth)}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${String(t.maxWidth)}px;background-color:${t.sheet};border-radius:${String(t.radius)}px;border-collapse:separate;overflow:hidden;">
<tr><td style="background-color:${t.header};padding:18px 32px;font-family:${t.fontFamily};font-size:20px;font-weight:600;letter-spacing:0.01em;color:${t.headerText};">e<span style="color:${t.headerSignal};">X</span>ocortex</td></tr>
<tr><td style="padding:32px 32px 16px 32px;font-family:${t.fontFamily};font-size:16px;line-height:1.55;color:${t.text};word-break:break-word;overflow-wrap:anywhere;">
<h1 style="margin:0 0 20px 0;font-size:22px;line-height:1.3;font-weight:600;color:${t.text};">${escapeHtml(content.heading)}</h1>
${body}
</td></tr>
${footer}
<tr><td style="padding:8px 32px 28px 32px;font-family:${t.fontFamily};font-size:13px;line-height:1.5;color:${t.mutedText};">eXocortex</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}

function paragraph(t: MailTheme, html: string): string {
  return `<p style="margin:0 0 16px 0;font-family:${t.fontFamily};font-size:16px;line-height:1.55;color:${t.text};">${html}</p>`;
}

function anchor(t: MailTheme, label: string, url: string): string {
  const href = safeHref(url);
  if (href === null) return escapeHtml(label);
  return `<a href="${href}" style="color:${t.link};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

function htmlBlock(t: MailTheme, words: LayoutWords, block: MailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(t, inline(block.text));
    case 'action':
      return actionButton(t, words, block.label, block.url);
    case 'link':
      return paragraph(t, anchor(t, block.label, block.url));
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">${block.rows
        .map(
          (row) =>
            `<tr><td valign="top" style="padding:2px 16px 2px 0;font-family:${t.fontFamily};font-size:14px;line-height:1.5;color:${t.mutedText};white-space:nowrap;">${escapeHtml(row.label)}</td><td valign="top" style="padding:2px 0;font-family:${t.fontFamily};font-size:15px;line-height:1.5;color:${t.text};">${inline(row.value)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'notice':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td style="background-color:${t.panel};border:1px solid ${t.panelBorder};border-radius:6px;padding:12px 16px;font-family:${t.fontFamily};font-size:15px;line-height:1.5;color:${t.text};">${inline(block.text)}</td></tr></table>`;
    case 'section':
      return sectionBlock(t, words, block);
    case 'excerpt':
      return `<div style="margin:0 0 16px 0;padding:16px;background-color:${t.panel};border-radius:6px;font-family:${t.fontFamily};font-size:15px;line-height:1.55;color:${t.text};white-space:pre-wrap;">${escapeHtml(block.text)}</div>`;
  }
}

/**
 * The primary action: a filled cell with a link inside, the construction that
 * survives Outlook. The address is written out below it as well, because a
 * button is the first thing a client that blocks remote content or strips
 * styles turns into something nobody recognises as clickable.
 */
function actionButton(t: MailTheme, words: LayoutWords, label: string, url: string): string {
  const href = safeHref(url);
  if (href === null) return paragraph(t, escapeHtml(label));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px 0;"><tr><td style="background-color:${t.actionFill};border-radius:6px;"><a href="${href}" style="display:inline-block;padding:12px 22px;font-family:${t.fontFamily};font-size:16px;font-weight:600;line-height:1.2;color:${t.actionText};text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a></td></tr></table>
<p style="margin:0 0 20px 0;font-family:${t.fontFamily};font-size:13px;line-height:1.5;color:${t.mutedText};">${escapeHtml(words.buttonFallback)}<br><a href="${href}" style="color:${t.link};text-decoration:underline;word-break:break-all;">${escapeHtml(url)}</a></p>`;
}

function sectionBlock(
  t: MailTheme,
  words: LayoutWords,
  block: Extract<MailBlock, { kind: 'section' }>,
): string {
  const items = block.items
    .map((item) => {
      const text = escapeHtml(item.quoted === true ? words.quote(item.text) : item.text);
      const label =
        item.label === undefined
          ? ''
          : `<strong style="font-weight:600;">${escapeHtml(item.label)}:</strong> `;
      return `<p style="margin:0 0 6px 0;font-family:${t.fontFamily};font-size:15px;line-height:1.5;color:${t.text};">${label}${text}</p>`;
    })
    .join('');
  const more =
    block.more === undefined
      ? ''
      : `<p style="margin:0 0 6px 0;font-family:${t.fontFamily};font-size:14px;line-height:1.5;color:${t.mutedText};">${escapeHtml(block.more)}</p>`;
  const link =
    block.link === undefined
      ? ''
      : `<p style="margin:8px 0 0 0;font-family:${t.fontFamily};font-size:14px;line-height:1.5;">${anchor(t, block.link.label, block.link.url)}</p>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td style="border-top:1px solid ${t.rule};padding-top:14px;"><h2 style="margin:0 0 8px 0;font-family:${t.fontFamily};font-size:17px;line-height:1.35;font-weight:600;color:${t.text};">${escapeHtml(block.title)}</h2>${items}${more}${link}</td></tr></table>`;
}
