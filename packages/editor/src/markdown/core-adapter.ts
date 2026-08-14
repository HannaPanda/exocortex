import {
  type MarkdownBlockSerializer,
  type MarkdownExtensionAdapter,
  type MarkdownSerializerContext,
  type ProseMirrorNode,
} from '../contract';

/**
 * Markdown serializers for the built-in Exocortex nodes and marks.
 *
 * Every serializer returns a block that ends with exactly one blank line, so the
 * top-level serializer only has to trim the final newlines.
 */

const CODE_FENCE = '```';

function textOf(node: ProseMirrorNode): string {
  return node.text ?? '';
}

/** Escapes characters that would otherwise start Markdown syntax. */
export function escapeInlineText(value: string): string {
  return (
    value
      .replace(/([\\`*_[\]])/g, '\\$1')
      // Exocortex inline syntax: superscript and subscript use single
      // characters, highlight and underline a pair. Escaping the first character
      // of a pair is enough, because the rule then no longer sees a delimiter.
      .replace(/([~^])/g, '\\$1')
      .replace(/(==|\+\+)/g, '\\$1')
      // A mention opens with `@[` or `@(`; a bare `@` in prose is left alone.
      .replace(/@(?=[[(])/g, '\\@')
      .replace(/^(\s*)([#>])/gm, '$1\\$2')
      .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
      .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3')
  );
}

function paragraph(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const inline = context.renderInline(node);
  const suffix = context.blockIdSuffix(node);
  if (inline.length === 0 && suffix.length === 0) return '\n';
  return `${inline}${suffix}\n\n`;
}

function heading(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const rawLevel = node.attrs?.level;
  const level = typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1;
  return `${'#'.repeat(level)} ${context.renderInline(node)}${context.blockIdSuffix(node)}\n\n`;
}

function codeBlock(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  const body = (node.content ?? []).map(textOf).join('');
  const suffix = context.blockIdSuffix(node);
  const info = `${language}${suffix.length > 0 ? `${language.length > 0 ? ' ' : ''}${suffix.trim()}` : ''}`;
  return `${CODE_FENCE}${info}\n${body}${body.endsWith('\n') ? '' : '\n'}${CODE_FENCE}\n\n`;
}

function blockquote(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const body = context.renderBlockChildren(node).replace(/\n+$/, '');
  return `${context.indentBlock(body, '> ', '> ')}\n\n`;
}

function bulletList(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const items = (node.content ?? []).map((item) => {
    const body = context.renderBlockChildren(item).replace(/\n+$/, '');
    const suffix = context.blockIdSuffix(item);
    return context.indentBlock(appendSuffixToFirstLine(body, suffix), '- ', '  ');
  });
  return `${items.join('\n')}\n\n`;
}

function orderedList(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const rawStart = node.attrs?.start;
  const start = typeof rawStart === 'number' && rawStart > 0 ? rawStart : 1;
  const items = (node.content ?? []).map((item, index) => {
    const marker = `${start + index}. `;
    const body = context.renderBlockChildren(item).replace(/\n+$/, '');
    const suffix = context.blockIdSuffix(item);
    return context.indentBlock(
      appendSuffixToFirstLine(body, suffix),
      marker,
      ' '.repeat(marker.length),
    );
  });
  return `${items.join('\n')}\n\n`;
}

function taskList(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const items = (node.content ?? []).map((item) => {
    const checked = item.attrs?.checked === true;
    const marker = `- [${checked ? 'x' : ' '}] `;
    const body = context.renderBlockChildren(item).replace(/\n+$/, '');
    const suffix = context.blockIdSuffix(item);
    return context.indentBlock(appendSuffixToFirstLine(body, suffix), marker, '  ');
  });
  return `${items.join('\n')}\n\n`;
}

function appendSuffixToFirstLine(body: string, suffix: string): string {
  if (suffix.length === 0) return body;
  const lines = body.split('\n');
  lines[0] = `${lines[0] ?? ''}${suffix}`;
  return lines.join('\n');
}

function horizontalRule(): string {
  return '---\n\n';
}

function image(node: ProseMirrorNode): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  const title =
    typeof node.attrs?.title === 'string' && node.attrs.title.length > 0
      ? ` "${node.attrs.title}"`
      : '';
  return `![${alt}](${src}${title})\n\n`;
}

function cellText(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  return context.renderBlockChildren(node).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function table(node: ProseMirrorNode, context: MarkdownSerializerContext): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return '';

  const renderedRows = rows.map((row) =>
    (row.content ?? []).map((cell) => cellText(cell, context)),
  );
  const columnCount = Math.max(...renderedRows.map((row) => row.length));
  const pad = (row: string[]): string[] => {
    const copy = [...row];
    while (copy.length < columnCount) copy.push('');
    return copy;
  };

  const [headerRow, ...bodyRows] = renderedRows;
  const lines: string[] = [];
  lines.push(`| ${pad(headerRow ?? []).join(' | ')} |`);
  lines.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`);
  for (const row of bodyRows) {
    lines.push(`| ${pad(row).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** Renders children of a table cell without the surrounding block spacing. */
const passthrough: MarkdownBlockSerializer = (node, context) => context.renderBlockChildren(node);

export const coreMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    paragraph,
    heading,
    codeBlock: codeBlock,
    blockquote,
    bulletList,
    orderedList,
    taskList,
    listItem: passthrough,
    taskItem: passthrough,
    horizontalRule,
    image,
    table,
    tableRow: passthrough,
    tableCell: passthrough,
    tableHeader: passthrough,
  },
  marks: {
    bold: { open: '**', close: '**', priority: 30 },
    italic: { open: '*', close: '*', priority: 20 },
    strike: { open: '~~', close: '~~', priority: 10 },
    code: { open: '`', close: '`', priority: 100, raw: true },
    link: {
      priority: 40,
      open: '[',
      close: (mark) => {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        const title =
          typeof mark.attrs?.title === 'string' && mark.attrs.title.length > 0
            ? ` "${mark.attrs.title}"`
            : '';
        return `](${href}${title})`;
      },
    },
  },
};
