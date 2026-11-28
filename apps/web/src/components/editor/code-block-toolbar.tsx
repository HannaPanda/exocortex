'use client';

import { autoUpdate, computePosition, type ComputePositionConfig, offset } from '@floating-ui/dom';
import { type EditorView } from '@tiptap/pm/view';
import { type Editor, type EditorEvents, useEditorState } from '@tiptap/react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { CODE_BLOCK_LANGUAGES } from '@exocortex/editor';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  Toolbar,
  ToolbarButton,
} from '@exocortex/ui';

/** How long the copy button stays in its confirmed state. */
const COPIED_FEEDBACK_MS = 1_500;

/**
 * How far the bar stands in from the block's top and right edge, in pixels.
 *
 * The block keeps a strip at its top free for the bar (`padding-top` on an
 * editable code block in `globals.css`), so the bar covers no code however
 * long the first line is. The strip is there whether the bar shows or not:
 * a padding that came and went with the pointer would make the code jump.
 */
const INSET = 4;

/**
 * Where the bar sits: inside the block's top right corner (issue #304).
 *
 * `top-end` puts the bar above the block, flush with its right edge; the
 * offset then pulls it down by its own height plus the inset, and in by the
 * inset (for an `-end` placement a negative cross axis offset moves it in). No `flip` and no `shift`: a bar that changes sides when the block
 * nears an edge is the jump the issue was about.
 */
const BAR_POSITION: ComputePositionConfig = {
  placement: 'top-end',
  strategy: 'absolute',
  middleware: [
    offset(({ rects }) => ({ mainAxis: -(rects.floating.height + INSET), crossAxis: -INSET })),
  ],
};

/** The position of the code block `element` is the DOM of, or `null`. */
function codeBlockPosOf(view: EditorView, element: Element): number | null {
  let inside: number;
  try {
    inside = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  const { doc } = view.state;
  if (doc.nodeAt(inside)?.type.name === 'codeBlock') return inside;
  const $pos = doc.resolve(inside);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'codeBlock') return $pos.before(depth);
  }
  return null;
}

/** The code block's DOM at `pos`, or `null` when no code block stands there now. */
function codeBlockElementAt(view: EditorView, pos: number): HTMLElement | null {
  if (view.state.doc.nodeAt(pos)?.type.name !== 'codeBlock') return null;
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * The editor's view once it is mounted. Before that `editor.view` is a proxy
 * that throws on `dom`, and the chrome may render before the editor's element
 * has taken the view.
 */
export function useMountedView(editor: Editor): EditorView | null {
  const [view, setView] = React.useState<EditorView | null>(null);
  React.useEffect(() => {
    const take = (): void => {
      if (editor.isDestroyed) return;
      try {
        if (editor.view.dom instanceof HTMLElement) setView(editor.view);
      } catch {
        // Not mounted yet; `mount` below brings it.
      }
    };
    take();
    editor.on('mount', take);
    return () => {
      editor.off('mount', take);
    };
  }, [editor]);
  return view;
}

/**
 * The code block under the pointer, as a position kept in step with the
 * document. Only a mouse hovers: a finger's `pointerover` arrives with the tap
 * that also moves the caret, and the caret already shows the bar there.
 */
function useHoveredCodeBlock(
  view: EditorView | null,
  bar: React.RefObject<HTMLDivElement | null>,
): [number | null, React.Dispatch<React.SetStateAction<number | null>>] {
  const [hovered, setHovered] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (view === null) return undefined;
    const over = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return;
      const pre = event.target.closest('pre');
      // A transcluded section renders its own editor inside this one; its code
      // blocks belong to that view.
      if (pre === null || pre.closest('.ProseMirror') !== view.dom) {
        setHovered(null);
        return;
      }
      setHovered(codeBlockPosOf(view, pre));
    };
    const leave = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      const into = event.relatedTarget;
      if (into instanceof Node && bar.current?.contains(into) === true) return;
      setHovered(null);
    };
    view.dom.addEventListener('pointerover', over, { passive: true });
    view.dom.addEventListener('pointerleave', leave, { passive: true });
    return () => {
      view.dom.removeEventListener('pointerover', over);
      view.dom.removeEventListener('pointerleave', leave);
    };
  }, [view, bar]);

  return [hovered, setHovered];
}

/**
 * Controls for one code block: language and copy.
 *
 * A separate bar from the selection toolbar because it applies to the *block*,
 * not to a selection, and because inside a code block no inline mark applies
 * (which is why the selection toolbar hides itself there).
 *
 * It stands in the block's top right corner and shows while the pointer rests
 * on the block or the caret is in it (issue #304). Before, it was a bubble
 * menu over the caret: it covered the lines above the one being written and
 * moved with every arrow key. Now it is placed against the block, never
 * against the caret, so it stays where it first appeared.
 *
 * Rendered directly after the editor's own element, so `Tab` from the code
 * goes straight into the bar and `Shift + Tab` back; `Escape` returns to the
 * text as well. On a touch screen it shows while the caret is in the block,
 * which is what tapping into the block does.
 */
export function CodeBlockToolbar({ editor }: { editor: Editor }) {
  const t = useTranslations('editor.codeBlock');
  /** A language's own name, or the catalogue's word for an entry that has none. */
  const languageLabel = (entry: (typeof CODE_BLOCK_LANGUAGES)[number]): string =>
    'labelKey' in entry ? t(entry.labelKey) : entry.label;
  const [copied, setCopied] = React.useState(false);

  const barRef = React.useRef<HTMLDivElement>(null);
  const view = useMountedView(editor);
  const [hovered, setHovered] = useHoveredCodeBlock(view, barRef);
  /**
   * The block the bar stays on while it is being used: from a press on it, a
   * focus in it, or its language list being open, until the focus or the
   * press goes elsewhere. Without it the bar would follow the pointer away from
   * the block on its way into the language list, and a block the pointer
   * merely crosses would take the bar along.
   */
  const [held, setHeld] = React.useState<number | null>(null);
  const languageOpen = React.useRef(false);

  const caret = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      if (!instance.isEditable || !instance.isFocused) return null;
      const { $from } = instance.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === 'codeBlock') return $from.before(depth);
      }
      return null;
    },
  });
  const editable = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance.isEditable,
  });

  // Both positions follow the document: a line typed above the block moves it.
  // A caret that moves while the bar is not in use releases the bar: the
  // writer has gone back to the text, maybe out of the block altogether.
  React.useEffect(() => {
    const follow = ({ transaction }: EditorEvents['transaction']): void => {
      if (
        transaction.selectionSet &&
        !languageOpen.current &&
        barRef.current?.contains(document.activeElement) !== true
      ) {
        setHeld(null);
      }
      if (!transaction.docChanged) return;
      const map = (pos: number | null): number | null => {
        if (pos === null) return null;
        const result = transaction.mapping.mapResult(pos);
        return result.deleted ? null : result.pos;
      };
      setHovered(map);
      setHeld(map);
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [editor, setHovered]);

  const anchor = editable ? (held ?? hovered ?? caret) : null;

  /** Directly after the editor's element, so it is the next stop for `Tab`. */
  const [host] = React.useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  );
  React.useEffect(() => {
    if (view === null || host === null) return undefined;
    view.dom.after(host);
    return () => host.remove();
  }, [view, host]);

  // `Tab` in the code goes to the bar. Without this it would go to whatever is
  // focusable next in the document, a task's checkbox further down included.
  React.useEffect(() => {
    if (view === null || caret === null) return undefined;
    const tab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.defaultPrevented) return;
      const first = barRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
      if (first === null || first === undefined) return;
      event.preventDefault();
      first.focus();
    };
    view.dom.addEventListener('keydown', tab);
    return () => view.dom.removeEventListener('keydown', tab);
  }, [view, caret]);

  // The press or focus that held the bar went elsewhere.
  React.useEffect(() => {
    if (held === null) return undefined;
    const press = (event: PointerEvent): void => {
      if (languageOpen.current) return;
      if (event.target instanceof Node && barRef.current?.contains(event.target) === true) return;
      setHeld(null);
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [held]);

  const block = anchor === null || view === null ? null : codeBlockElementAt(view, anchor);

  React.useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || block === null) return undefined;
    let current = true;
    const update = (): void => {
      void computePosition(block, bar, BAR_POSITION).then(({ x, y }) => {
        if (!current) return;
        bar.style.left = `${x}px`;
        bar.style.top = `${y}px`;
        bar.style.visibility = 'visible';
      });
    };
    const stop = autoUpdate(block, bar, update);
    return () => {
      current = false;
      stop();
    };
  }, [block]);

  const language = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      if (anchor === null) return '';
      const value: unknown = instance.state.doc.nodeAt(anchor)?.attrs.language;
      return typeof value === 'string' ? value : '';
    },
  });

  if (host === null || block === null || anchor === null) return null;

  /**
   * Whether the caret stands in this very block, so a change may return to it.
   * Read from the selection, not from `caret`: a press on the bar has already
   * taken the focus from the text, and `caret` only counts a focused editor.
   */
  const caretInBlock = (): boolean => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'codeBlock') return $from.before(depth) === anchor;
    }
    return false;
  };

  const setLanguage = (value: string): void => {
    const pos = anchor;
    const chain = editor.chain();
    // Back to the text only when the caret is in this block: focusing the editor
    // otherwise scrolls to a caret somewhere else on the page.
    if (caretInBlock()) chain.focus();
    chain
      .command(({ tr }) => {
        if (tr.doc.nodeAt(pos)?.type.name !== 'codeBlock') return false;
        tr.setNodeAttribute(pos, 'language', value);
        return true;
      })
      .run();
  };

  const copy = async (): Promise<void> => {
    const node = editor.state.doc.nodeAt(anchor);
    if (node?.type.name !== 'codeBlock') return;
    await window.navigator.clipboard.writeText(node.textContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return createPortal(
    <Toolbar
      ref={barRef}
      aria-label={t('label')}
      data-testid="code-block-toolbar"
      // Flat, in the block's own colour: on the block it has no edge of its own
      // (DESIGN.md, the Flat-By-Default Rule), and where an outline laid over the
      // text covers the corner (issue #283) it still reads, because `z-10` keeps
      // it above that list and the colour keeps the list's words from showing
      // through it.
      className="absolute top-0 left-0 z-10 gap-0.5 border-0 bg-sunken p-0 shadow-none"
      style={{ visibility: 'hidden' }}
      onPointerDown={() => setHeld(anchor)}
      onFocus={() => setHeld(anchor)}
      onBlur={(event) => {
        if (languageOpen.current) return;
        const into = event.relatedTarget;
        // `null` is a tap on a button a touch browser does not focus; the next
        // press elsewhere releases the bar instead.
        if (into === null || barRef.current?.contains(into) === true) return;
        setHeld(null);
      }}
      onPointerLeave={(event) => {
        const into = event.relatedTarget;
        if (into instanceof Node && block.contains(into)) return;
        setHovered(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || languageOpen.current) return;
        event.preventDefault();
        setHeld(null);
        editor.commands.focus();
      }}
    >
      <Select
        value={language}
        onOpenChange={(open) => {
          languageOpen.current = open;
          if (open) setHeld(anchor);
          // A language chosen with the caret in the block sends the focus back
          // to the text, and the bar is the caret's again.
          else if (view?.hasFocus() === true) setHeld(null);
        }}
        onValueChange={(value) => setLanguage(typeof value === 'string' ? value : '')}
      >
        <ToolbarButton
          render={
            <SelectTrigger
              size="sm"
              aria-label={t('language')}
              data-testid="code-language-trigger"
              className="h-7 gap-1 border-transparent px-2 text-meta text-muted-foreground hover:text-foreground"
            />
          }
        >
          {/* Base UI shows the raw value without a render function. */}
          <SelectValue>
            {() => {
              const entry = CODE_BLOCK_LANGUAGES.find((candidate) => candidate.value === language);
              return entry === undefined ? language : languageLabel(entry);
            }}
          </SelectValue>
        </ToolbarButton>
        <SelectContent align="end">
          {CODE_BLOCK_LANGUAGES.map((entry) => (
            <SelectItem
              key={entry.value}
              value={entry.value}
              data-testid={`code-language-${entry.value.length > 0 ? entry.value : 'none'}`}
            >
              <SelectItemText>{languageLabel(entry)}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ToolbarButton
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? t('copied') : t('copy')}
            title={copied ? t('copied') : t('copy')}
            data-testid="code-copy"
            className="text-muted-foreground hover:text-foreground"
            // Keeps the caret in the code: a press that took the focus would
            // end the reason the bar is showing before the click arrives.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void copy()}
          />
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </ToolbarButton>
      {/* The changed name of the button is not announced by itself. */}
      <span className="sr-only" aria-live="polite">
        {copied ? t('copied') : ''}
      </span>
    </Toolbar>,
    host,
  );
}
