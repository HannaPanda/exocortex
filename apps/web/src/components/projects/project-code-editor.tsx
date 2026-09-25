'use client';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { type HocuspocusProvider } from '@hocuspocus/provider';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';

import { projectFilesMap } from '@exocortex/editor';

/**
 * One project file, edited collaboratively (issue #43, ADR-027).
 *
 * CodeMirror 6 over the `Y.Text` that already sits in the project's Yjs
 * document, through `y-codemirror.next`: the same socket, the same room and the
 * same awareness the page editor uses, so several people typing in
 * `chapters/intro.tex` see each other's cursors and nothing is saved, ever --
 * there is no save, the CRDT is the state.
 *
 * Everything here is MIT-licensed (ADR-027): CodeMirror, its legacy `stex`
 * mode for LaTeX highlighting, and the Yjs binding. No AGPL package reaches
 * this bundle.
 */

/**
 * Highlighting for LaTeX.
 *
 * `stex` is CodeMirror's own stream mode, carried over from CodeMirror 5 in
 * `@codemirror/legacy-modes`. A Lezer grammar for LaTeX would highlight better;
 * the one that exists is AGPL, so this is the one that can be used here. It is
 * good enough for what it is for: telling a command from an argument from a
 * comment while writing.
 */
const LATEX = StreamLanguage.define(stex);

/** Files that get LaTeX highlighting rather than none. */
function languageFor(path: string): Extension[] {
  const lower = path.toLowerCase();
  if (/\.(tex|sty|cls|ltx|def|clo|ins|dtx|tikz|pgf)$/.test(lower)) return [LATEX];
  return [];
}

interface ProjectCodeEditorProps {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  path: string;
  readOnly: boolean;
  /** Line to scroll to and mark, when a diagnostic was clicked. */
  focusLine: number | null;
  /** Rises with every jump, so the same line asked for twice moves twice. */
  focusNonce: number;
  /** Where the caret is, so the PDF can mark the same place (issue #53). */
  onCursorLine: (line: number) => void;
}

/**
 * A hard wrap would hide the ends of long lines and LaTeX has plenty of them;
 * soft wrapping is what a writer expects and what a diagnostic's line number
 * still agrees with, because a wrapped line is one line.
 */
const BASE_THEME = EditorView.theme({
  // 13px is not a rung of the type ladder and is not meant to be one: this
  // sizes source code in a full-height editor pane, where the question is how
  // many columns of LaTeX fit, not how a label relates to its value.
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.6',
  },
  '.cm-content': { paddingBlock: '0.75rem' },
  '&.cm-focused': { outline: 'none' },
});

export function ProjectCodeEditor({
  provider,
  ydoc,
  path,
  readOnly,
  focusLine,
  focusNonce,
  onCursorLine,
}: ProjectCodeEditorProps) {
  const t = useTranslations('projects.editor');
  const emptyFileText = t('emptyFile');
  const host = React.useRef<HTMLDivElement | null>(null);
  const view = React.useRef<EditorView | null>(null);
  // Through a ref, so a new callback identity does not rebuild the editor and
  // throw everybody's cursor away with it.
  const report = React.useRef(onCursorLine);
  React.useEffect(() => {
    report.current = onCursorLine;
  }, [onCursorLine]);

  React.useEffect(() => {
    const element = host.current;
    if (element === null) return;

    const entry = projectFilesMap(ydoc).get(path);
    const text = entry?.get('text');
    if (!(text instanceof Y.Text)) {
      // Either the path holds an asset or the tree has not arrived over the
      // socket yet. The caller draws the empty state; there is nothing to bind.
      return;
    }

    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        lineNumbers(),
        history(),
        EditorView.lineWrapping,
        BASE_THEME,
        ...languageFor(path),
        // The binding replaces CodeMirror's own document: `yCollab` installs the
        // Y.Text as the source of truth and carries the remote cursors.
        yCollab(text, provider.awareness ?? undefined),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (!update.selectionSet && !update.docChanged) return;
          report.current(update.state.doc.lineAt(update.state.selection.main.head).number);
        }),
        placeholder(emptyFileText),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ],
    });

    const created = new EditorView({ state, parent: element });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [provider, ydoc, path, readOnly, emptyFileText]);

  // Jumping to a diagnostic's line. An effect of its own so it does not rebuild
  // the editor, which would drop everybody's cursor to jump to a warning.
  React.useEffect(() => {
    const current = view.current;
    if (current === null || focusLine === null) return;
    if (focusLine < 1 || focusLine > current.state.doc.lines) return;
    const line = current.state.doc.line(focusLine);
    current.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    current.focus();
  }, [focusLine, focusNonce]);

  return <div ref={host} className="h-full min-h-0 overflow-auto" data-testid="project-editor" />;
}
