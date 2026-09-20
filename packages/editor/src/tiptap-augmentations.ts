/**
 * Loads the command type augmentations of every extension in the canonical
 * schema.
 *
 * Tiptap declares its commands by augmenting the `Commands` interface in
 * `@tiptap/core` from inside each extension package. A consumer that only imports
 * `@exocortex/editor` never loads those modules, so `editor.chain().toggleBold()`
 * would not typecheck even though it works at runtime. Re-importing them here,
 * and importing this module from the package entry point, makes the whole command
 * surface of the canonical schema part of this package's public types.
 *
 * Runtime cost is zero: every module here is already loaded by `extensions.ts`.
 */
import '@tiptap/extension-blockquote';
import '@tiptap/extension-bold';
import '@tiptap/extension-code';
import '@tiptap/extension-code-block';
import '@tiptap/extension-hard-break';
import '@tiptap/extension-heading';
import '@tiptap/extension-horizontal-rule';
import '@tiptap/extension-image';
import '@tiptap/extension-italic';
import '@tiptap/extension-link';
import '@tiptap/extension-list';
import '@tiptap/extension-paragraph';
import '@tiptap/extension-strike';
import '@tiptap/extension-subscript';
import '@tiptap/extension-superscript';
import '@tiptap/extension-table';
import '@tiptap/extension-underline';
