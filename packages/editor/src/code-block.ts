import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';

/**
 * Syntax highlighting for code blocks.
 *
 * The languages are registered individually rather than through `lowlight`'s
 * "all" bundle: that bundle is roughly 190 grammars and about a megabyte of
 * JavaScript, in a product whose stated personality is speed (PRODUCT.md). This
 * list covers what actually appears in an Exocortex page; adding one is a single
 * import.
 *
 * The stored document only ever contains the language *name*. Highlighting is
 * derived at render time, which is why changing this list can never invalidate a
 * document.
 */
const lowlight = createLowlight();

lowlight.register({
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
});

/**
 * Languages offered in the picker, in the order they are shown.
 *
 * `value` is what lands in the document and in the Markdown fence, `label` is
 * what the writer sees. Aliases (`ts`, `js`, `sh`) are understood on import
 * because highlight.js registers them, but the picker shows one canonical name.
 */
export const CODE_BLOCK_LANGUAGES = [
  { value: '', label: 'Ohne Hervorhebung' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Shell' },
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
] as const;

export type CodeBlockLanguage = (typeof CODE_BLOCK_LANGUAGES)[number]['value'];

/**
 * The code block, replacing the plain one from `@tiptap/extension-code-block`.
 *
 * `exitOnTripleEnter` is off and `exitOnArrowDown` is on: in a code block an empty
 * line is normal content, so three of them must not eject the writer out of the
 * block.
 */
export const ExocortexCodeBlock = CodeBlockLowlight.configure({
  lowlight,
  languageClassPrefix: 'language-',
  exitOnTripleEnter: false,
  exitOnArrowDown: true,
  HTMLAttributes: { class: 'exocortex-code-block' },
});
