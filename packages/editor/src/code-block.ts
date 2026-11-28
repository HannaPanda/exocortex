import { type Command, InputRule } from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';

import { codeBlockBackspace, codeBlockDelete, type CodeBlockEdgeOutcome } from './code-block-edges';
import { placeCodeBlock, planCodeBlock } from './code-block-placement';
import { looksLikeSession, shellScript, terminalSession } from './code-grammars';
import { codeHighlightPlugin, type HighlightSpan } from './code-highlight';

/**
 * Syntax highlighting for code blocks.
 *
 * The languages are registered individually rather than through `lowlight`'s
 * "all" bundle: that bundle is roughly 190 grammars and about a megabyte of
 * JavaScript, in a product whose stated personality is speed (PRODUCT.md). This
 * list covers what actually appears in an eXocortex page; adding one is a single
 * import. `bash` and `console` are our own wrappers of the upstream grammars
 * (`code-grammars.ts`, issue #317).
 *
 * The stored document only ever contains the language *name*. Highlighting is
 * derived at render time, which is why changing this list can never invalidate a
 * document.
 */
const lowlight = createLowlight();

lowlight.register({
  bash: shellScript,
  console: terminalSession,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  powershell,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
});

// Names that were written after a fence before the picker offered them: a
// `.env` file is INI to every reader of it.
lowlight.registerAlias({ ini: ['dotenv', 'env'] });

/**
 * The picker entries whose label is a word rather than a language's own name,
 * and therefore lives in the message catalogue (`editor.codeBlock.<key>`).
 */
export type CodeBlockLanguageLabelKey = 'noHighlighting' | 'terminalSession';

/**
 * Languages offered in the picker, in the order they are shown.
 *
 * `value` is what lands in the document and in the Markdown fence. `label` is a
 * language's own name and is the same in every interface language; an entry
 * named by a word instead carries `labelKey`. Aliases (`ts`, `js`, `sh`,
 * `shell`) are understood on import because the grammars register them, but the
 * picker shows one canonical name.
 *
 * The empty value is no highlighting at all: no grammar, and no guessing one.
 */
export const CODE_BLOCK_LANGUAGES = [
  { value: '', labelKey: 'noHighlighting' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Shell' },
  { value: 'console', labelKey: 'terminalSession' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'python', label: 'Python' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'php', label: 'PHP' },
  { value: 'sql', label: 'SQL' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ini', label: 'TOML / INI' },
  { value: 'xml', label: 'HTML / XML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'diff', label: 'Diff' },
] as const satisfies readonly (
  { value: string; label: string } | { value: string; labelKey: CodeBlockLanguageLabelKey }
)[];

export type CodeBlockLanguage = (typeof CODE_BLOCK_LANGUAGES)[number]['value'];

/**
 * The grammar a stored language name stands for, or `null` for plain text. A
 * shell block holding a terminal session is read as one (`looksLikeSession`);
 * the stored name is not touched.
 */
function grammarFor(language: unknown, code: string): string | null {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0 || !lowlight.registered(normalized)) return null;
  const bashNames = ['bash', 'sh', 'zsh', 'shell'];
  return bashNames.includes(normalized) && looksLikeSession(code) ? 'console' : normalized;
}

/** The node shape `lowlight.highlight` actually produces, inferred rather than
 *  imported from `hast`: this package has no direct dependency on `@types/hast`,
 *  only a transitive one through `lowlight`, which pnpm does not expose here. */
type LowlightNode = ReturnType<typeof lowlight.highlight>['children'][number];

/**
 * The theme classes of an element: `hljs-*` and the modifiers highlight.js
 * puts beside them (`function_`, `prompt_`). The wrapper around a stretch in
 * another grammar (a session's commands are bash) is named after that grammar
 * and colours nothing, so it is left out.
 */
function classesOf(node: LowlightNode): readonly string[] {
  if (node.type !== 'element') return [];
  const className = node.properties.className;
  if (!Array.isArray(className)) return [];
  return className.map(String).filter((name) => name.startsWith('hljs-') || name.endsWith('_'));
}

/** Flattens the nested tree into stretches, each with all the classes around it. */
function collectSpans(
  nodes: readonly LowlightNode[],
  inherited: readonly string[],
  spans: HighlightSpan[],
  offset: number,
): number {
  let position = offset;
  for (const node of nodes) {
    if (node.type === 'text') {
      const end = position + node.value.length;
      if (end > position && inherited.some((name) => name.startsWith('hljs-'))) {
        spans.push({ from: position, to: end, className: inherited.join(' ') });
      }
      position = end;
    } else if (node.type === 'element') {
      position = collectSpans(node.children, [...inherited, ...classesOf(node)], spans, position);
    }
  }
  return position;
}

/**
 * The coloured stretches of `code` in `language`, empty for no language or an
 * unknown one. Never a guess: "Ohne Hervorhebung" and an unregistered name
 * (`text`, a language nobody added) both mean plain text.
 */
export function highlightSpans(code: string, language: unknown): readonly HighlightSpan[] {
  const grammar = grammarFor(language, code);
  if (grammar === null || code.length === 0) return [];
  const spans: HighlightSpan[] = [];
  collectSpans(lowlight.highlight(grammar, code).children, [], spans, 0);
  return spans;
}

/**
 * A fence (```, optionally with a language, or ~~~) typed at the start of a
 * line. Upstream's rule only matched at the start of a text block and only
 * where that block may turn into a code block, so it never fired in a list
 * item, nor on a fresh line after `Umschalt+Enter` (issue #318). Here the line
 * may also start after a line break, and the code block goes where
 * `placeCodeBlock` puts it.
 */
const CODE_FENCE = /(?:```|~~~)([a-z]+)?[\s\n]$/;

/**
 * The code block, replacing the plain one from `@tiptap/extension-code-block`.
 *
 * `exitOnTripleEnter` is off and `exitOnArrowDown` is on: in a code block an empty
 * line is normal content, so three of them must not eject the writer out of the
 * block.
 *
 * Highlighting comes from our own plugin (`code-highlight.ts`), not from
 * `@tiptap/extension-code-block-lowlight`: that one guessed a language for a
 * block without one and kept stale colours after a language change (#317).
 */
export const ExocortexCodeBlock = CodeBlock.extend({
  /**
   * `setCodeBlock` and `toggleCodeBlock` (the catalog's "Codeblock", the slash
   * menu, `Mod-Alt-c`) go through `placeCodeBlock`, so a list item's text
   * stays in its item (issue #318). Where the rule has nothing to say (the
   * caret already in a code block, a selection over several blocks) upstream's
   * command runs as before, which also toggles a code block back.
   */
  addCommands() {
    const parent = this.parent?.() ?? {};
    const placeOr =
      (fallback: (attrs: { language: string } | undefined) => Command) =>
      (attributes?: { language: string }): Command =>
      (props) => {
        const { tr, dispatch } = props;
        const attrs = attributes ?? null;
        if (dispatch === undefined) {
          if (planCodeBlock(tr.doc, tr.selection, this.type, attrs) !== null) return true;
        } else if (placeCodeBlock(tr, this.type, attrs)) {
          return true;
        }
        return fallback(attributes)(props);
      };
    return {
      ...parent,
      setCodeBlock: placeOr(
        (attributes) =>
          ({ commands }) =>
            commands.setNode(this.name, attributes),
      ),
      toggleCodeBlock: placeOr(
        (attributes) =>
          ({ commands }) =>
            commands.toggleNode(this.name, 'paragraph', attributes),
      ),
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: CODE_FENCE,
        handler: ({ state, range, match }) => {
          const $start = state.doc.resolve(range.from);
          const atLineStart =
            $start.parentOffset === 0 || $start.nodeBefore?.type.spec.linebreakReplacement === true;
          if (!atLineStart || $start.parent.type === this.type) return null;
          const { tr } = state;
          tr.delete(range.from, range.to);
          const language = match[1];
          if (!placeCodeBlock(tr, this.type, language === undefined ? null : { language })) {
            return null;
          }
          return undefined;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    /** Dispatches what the edge rule decided; `false` lets the key go on. */
    const apply = (outcome: CodeBlockEdgeOutcome): boolean => {
      if (outcome === null) return false;
      if (outcome !== 'stay') this.editor.view.dispatch(outcome);
      return true;
    };
    return {
      ...parent,
      /**
       * Backspace and Delete never join a code block with its neighbour
       * (`code-block-edges.ts`, issue #319). An empty code block becomes an
       * empty paragraph where it stands, also inside a list item (#318),
       * where upstream's `clearNodes` lifted it out of every list around it.
       */
      Backspace: (props) => {
        if (!this.editor.isEditable) return false;
        const { $from } = this.editor.state.selection;
        // A text block typed into shape right below a code block (`# `)
        // goes back to its text first, as everywhere else.
        if ($from.parent.type !== this.type && this.editor.commands.undoInputRule()) return true;
        if (apply(codeBlockBackspace(this.editor.state, this.type))) return true;
        return parent.Backspace?.(props) ?? false;
      },
      Delete: (props) => {
        if (!this.editor.isEditable) return false;
        if (apply(codeBlockDelete(this.editor.state, this.type))) return true;
        return parent.Delete?.(props) ?? false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      codeHighlightPlugin({
        name: this.name,
        spansFor: (node: ProseMirrorNode) => highlightSpans(node.textContent, node.attrs.language),
      }),
    ];
  },
}).configure({
  languageClassPrefix: 'language-',
  exitOnTripleEnter: false,
  exitOnArrowDown: true,
  // Code is not prose: a browser's page translation must leave it alone.
  HTMLAttributes: { class: 'exocortex-code-block', translate: 'no' },
});

/**
 * Structural subset of the hast tree `lowlight.highlight` returns, framework
 * agnostic so a consumer outside the editor (the AI chat, issue #21) can turn
 * it into its own UI without depending on `hast` or Tiptap.
 */
export interface HighlightNode {
  type: 'element' | 'text';
  /** Set on `'text'` nodes. */
  value?: string;
  /** `hljs-*` class names, set on `'element'` nodes. */
  className?: readonly string[];
  /** Set on `'element'` nodes. */
  children?: readonly HighlightNode[];
}

function toHighlightNode(node: LowlightNode): HighlightNode {
  if (node.type === 'text') return { type: 'text', value: node.value };
  if (node.type === 'element') {
    const className = node.properties.className;
    return {
      type: 'element',
      className: Array.isArray(className) ? className.map(String) : undefined,
      children: node.children.map(toHighlightNode),
    };
  }
  // `lowlight.highlight` only ever emits `element` and `text` nodes, but the
  // hast union it is typed against also allows `comment` and `doctype`. Render
  // those (never actually reached) as nothing rather than throw.
  return { type: 'text', value: '' };
}

/**
 * Highlights source code with the same grammar registry the editor's code
 * block uses (`lowlight` above), so a fenced code block rendered outside the
 * editor -- the AI chat (issue #21) -- gets identical `hljs-*` classes and can
 * share its CSS theme (`apps/web/src/app/globals.css`).
 *
 * Falls back to a single unhighlighted text node for an empty or unregistered
 * language: `lowlight.highlight` throws for a language it does not know, and a
 * fenced block in a chat message may carry any string the model typed.
 */
export function highlightCode(code: string, language: string): readonly HighlightNode[] {
  const grammar = grammarFor(language, code);
  if (grammar === null) return code.length > 0 ? [{ type: 'text', value: code }] : [];
  return lowlight.highlight(grammar, code).children.map(toHighlightNode);
}
