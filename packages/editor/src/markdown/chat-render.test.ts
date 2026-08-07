import { describe, expect, it } from 'vitest';

import { type ProseMirrorDocument, type ProseMirrorMark, type ProseMirrorNode } from '../contract';
import {
  COLUMNS_MARKDOWN,
  DERIVED_BLOCKS_MARKDOWN,
  INLINE_STYLING_MARKDOWN,
  KITCHEN_SINK_MARKDOWN,
  MATH_MARKDOWN,
  MEDIA_MARKDOWN,
  MENTION_MARKDOWN,
  TOGGLE_MARKDOWN,
} from '../fixtures';
import { serializePlainText } from '../plain-text';

import { pruneForChat, sanitizeLinkHref } from './chat-render';
import { parseMarkdown } from './parse';

/** Every node type anywhere in the document, for allow/deny assertions. */
function collectTypes(document: ProseMirrorDocument): Set<string> {
  const types = new Set<string>();
  const walk = (node: ProseMirrorNode): void => {
    types.add(node.type);
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of document.content ?? []) walk(child);
  return types;
}

/** Every mark type anywhere in the document. */
function collectMarkTypes(document: ProseMirrorDocument): Set<string> {
  const types = new Set<string>();
  const walk = (node: ProseMirrorNode): void => {
    for (const mark of node.marks ?? []) types.add(mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of document.content ?? []) walk(child);
  return types;
}

function findLinkMarks(document: ProseMirrorDocument): ProseMirrorMark[] {
  const marks: ProseMirrorMark[] = [];
  const walk = (node: ProseMirrorNode): void => {
    for (const mark of node.marks ?? []) if (mark.type === 'link') marks.push(mark);
    for (const child of node.content ?? []) walk(child);
  };
  for (const child of document.content ?? []) walk(child);
  return marks;
}

describe('pruneForChat', () => {
  it('keeps the small element set the chat renders', () => {
    const pruned = pruneForChat(parseMarkdown(KITCHEN_SINK_MARKDOWN).document);
    const types = collectTypes(pruned);

    for (const allowed of [
      'paragraph',
      'heading',
      'blockquote',
      'bulletList',
      'orderedList',
      'listItem',
      'codeBlock',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'text',
    ]) {
      expect(types.has(allowed)).toBe(true);
    }
  });

  it('drops images, horizontal rules and Exocortex-only blocks that survive parsing', () => {
    const pruned = pruneForChat(parseMarkdown(KITCHEN_SINK_MARKDOWN).document);
    const types = collectTypes(pruned);

    expect(types.has('image')).toBe(false);
    expect(types.has('horizontalRule')).toBe(false);
    // The callout in KITCHEN_SINK_MARKDOWN degrades to a blockquote instead.
    expect(types.has('callout')).toBe(false);
    // The task list in KITCHEN_SINK_MARKDOWN degrades to a bulletList instead.
    expect(types.has('taskList')).toBe(false);
    expect(types.has('taskItem')).toBe(false);
  });

  it('degrades a task list into a bulletList without losing its text', () => {
    const source = '- [x] Erledigt\n- [ ] Noch offen\n';
    const pruned = pruneForChat(parseMarkdown(source).document);

    expect(pruned.content?.[0]?.type).toBe('bulletList');
    expect(pruned.content?.[0]?.content?.every((item) => item.type === 'listItem')).toBe(true);
    expect(serializePlainText(pruned)).toContain('Erledigt');
    expect(serializePlainText(pruned)).toContain('Noch offen');
  });

  it('degrades a callout into a blockquote without losing its body', () => {
    const source = '> [!warning] Achtung\n> Der Text der Box.\n';
    const pruned = pruneForChat(parseMarkdown(source).document);

    expect(pruned.content?.[0]?.type).toBe('blockquote');
    expect(pruned.content?.[0]?.attrs).toBeUndefined();
    expect(serializePlainText(pruned)).toContain('Der Text der Box.');
  });

  it('keeps a plain blockquote as a blockquote', () => {
    const pruned = pruneForChat(parseMarkdown('> Nur ein Zitat.\n').document);
    expect(pruned.content?.[0]?.type).toBe('blockquote');
  });

  it('strips marks the chat does not style but keeps the underlying text', () => {
    const pruned = pruneForChat(parseMarkdown(INLINE_STYLING_MARKDOWN).document);
    const markTypes = collectMarkTypes(pruned);

    for (const dropped of ['textColor', 'underline', 'superscript', 'subscript']) {
      expect(markTypes.has(dropped)).toBe(false);
    }
    expect(serializePlainText(pruned)).toContain('Hervorhebung');
    expect(serializePlainText(pruned)).toContain('Unterstreichung');
  });

  it('strips strikethrough but keeps the text', () => {
    const pruned = pruneForChat(parseMarkdown('Ein ~~gestrichener~~ Text.\n').document);
    expect(collectMarkTypes(pruned).has('strike')).toBe(false);
    expect(serializePlainText(pruned)).toContain('gestrichener');
  });

  it('keeps bold, italic, inline code and link marks', () => {
    const pruned = pruneForChat(
      parseMarkdown('**fett**, *kursiv*, `code` und [ein Link](https://exocortex.app).\n').document,
    );
    const markTypes = collectMarkTypes(pruned);
    expect(markTypes.has('bold')).toBe(true);
    expect(markTypes.has('italic')).toBe(true);
    expect(markTypes.has('code')).toBe(true);
    expect(markTypes.has('link')).toBe(true);
  });

  it('leaves a wiki link mark alone -- issue #22 decides how it is presented', () => {
    const pruned = pruneForChat(parseMarkdown('Siehe [[Andere Seite]].\n').document);
    const hrefs = findLinkMarks(pruned).map((mark) => mark.attrs?.href);
    expect(hrefs).toContain('wiki:Andere Seite');
  });

  it('drops a javascript: link but keeps its text', () => {
    const pruned = pruneForChat(parseMarkdown('[Klick mich](javascript:alert(1)).\n').document);
    expect(findLinkMarks(pruned)).toEqual([]);
    expect(serializePlainText(pruned)).toContain('Klick mich');
  });

  it('drops a data: link but keeps its text', () => {
    const pruned = pruneForChat(
      parseMarkdown('[Bild](data:text/html;base64,PHNjcmlwdD4=).\n').document,
    );
    expect(findLinkMarks(pruned)).toEqual([]);
    expect(serializePlainText(pruned)).toContain('Bild');
  });

  it('keeps an ordinary https link', () => {
    const pruned = pruneForChat(parseMarkdown('[Exocortex](https://exocortex.app).\n').document);
    const hrefs = findLinkMarks(pruned).map((mark) => mark.attrs?.href);
    expect(hrefs).toEqual(['https://exocortex.app']);
  });

  it('produces an empty document, never a crash, for pages made only of excluded blocks', () => {
    for (const markdown of [TOGGLE_MARKDOWN, COLUMNS_MARKDOWN, DERIVED_BLOCKS_MARKDOWN, MEDIA_MARKDOWN]) {
      const pruned = pruneForChat(parseMarkdown(markdown).document);
      expect(pruned.content).toEqual([]);
    }
  });

  it('keeps the surrounding prose of a math block but drops the formula itself', () => {
    // MATH_MARKDOWN's inline `$E = mc^2$` sits inside an otherwise ordinary
    // paragraph, so the paragraph survives even though the formula does not.
    const pruned = pruneForChat(parseMarkdown(MATH_MARKDOWN).document);
    expect(collectTypes(pruned).has('inlineMath')).toBe(false);
    expect(collectTypes(pruned).has('blockMath')).toBe(false);
    expect(serializePlainText(pruned)).toContain('Die Masse-Energie-Beziehung lautet');
  });

  it('drops a mention but is not confused by it', () => {
    const pruned = pruneForChat(parseMarkdown(MENTION_MARKDOWN).document);
    expect(collectTypes(pruned).has('mention')).toBe(false);
    // The plain text around the mentions is an ordinary paragraph and survives.
    expect(serializePlainText(pruned)).toContain('Besprochen mit');
  });
});

describe('sanitizeLinkHref', () => {
  it('rejects javascript: regardless of case', () => {
    expect(sanitizeLinkHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('JavaScript:alert(1)')).toBeNull();
  });

  it('rejects javascript: even with control characters hidden inside the scheme', () => {
    expect(sanitizeLinkHref('java\nscript:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('java\tscript:alert(1)')).toBeNull();
  });

  it('rejects data: and vbscript:', () => {
    expect(sanitizeLinkHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeLinkHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects an empty or whitespace-only href', () => {
    expect(sanitizeLinkHref('')).toBeNull();
    expect(sanitizeLinkHref('   ')).toBeNull();
  });

  it('accepts ordinary schemes and scheme-less references', () => {
    expect(sanitizeLinkHref('https://exocortex.app')).toBe('https://exocortex.app');
    expect(sanitizeLinkHref('mailto:hanna@example.com')).toBe('mailto:hanna@example.com');
    expect(sanitizeLinkHref('#abschnitt')).toBe('#abschnitt');
  });
});
