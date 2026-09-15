'use client';

import { type ResolvedPos } from '@tiptap/pm/model';
import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  BaselineIcon,
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  SmileIcon,
  SparklesIcon,
  StrikethroughIcon,
  SubscriptIcon,
  SuperscriptIcon,
  UnderlineIcon,
} from 'lucide-react';
import * as React from 'react';

import {
  BLOCK_ID_ATTRIBUTE,
  type BlockCatalogEntry,
  collectBlockIdsInRange,
  isValidBlockId,
} from '@exocortex/editor';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
} from '@exocortex/ui';

import { useAiSelection } from '@/components/ai/ai-selection';
import { useCommentAnchor } from '@/components/comments/comment-anchor';

import { BlockActionItems } from './block-actions';
import { ColorMenu } from './color-menu';
import { EmojiMenu } from './emoji-menu';
import { LinkMenu } from './link-menu';
import { currentBlockLabel, TurnIntoMenu, TurnIntoTriggerLabel } from './turn-into-menu';

interface SelectionToolbarProps {
  editor: Editor;
  catalog: readonly BlockCatalogEntry[];
  documentId: string;
  /** Passed through to `LinkMenu`, whose page search reads this workspace's tree. */
  workspaceId: string;
}

interface MarkButton {
  id: string;
  label: string;
  shortcut: string;
  icon: React.ComponentType<{ className?: string }>;
  mark: string;
  toggle: (editor: Editor) => void;
}

/**
 * The inline marks, in the order Notion and every word processor puts them.
 * Keyboard shortcuts come from the Tiptap extensions; they are listed here only
 * so the `aria-label` names them.
 */
const MARK_BUTTONS: readonly MarkButton[] = [
  {
    id: 'bold',
    label: 'Fett',
    shortcut: 'Strg+B',
    icon: BoldIcon,
    mark: 'bold',
    toggle: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    label: 'Kursiv',
    shortcut: 'Strg+I',
    icon: ItalicIcon,
    mark: 'italic',
    toggle: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    id: 'underline',
    label: 'Unterstrichen',
    shortcut: 'Strg+U',
    icon: UnderlineIcon,
    mark: 'underline',
    toggle: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    id: 'strike',
    label: 'Durchgestrichen',
    shortcut: 'Strg+Shift+S',
    icon: StrikethroughIcon,
    mark: 'strike',
    toggle: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    id: 'code',
    label: 'Code',
    shortcut: 'Strg+E',
    icon: CodeIcon,
    mark: 'code',
    toggle: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    id: 'superscript',
    label: 'Hochgestellt',
    shortcut: 'Strg+.',
    icon: SuperscriptIcon,
    mark: 'superscript',
    toggle: (editor) => editor.chain().focus().toggleSuperscript().run(),
  },
  {
    id: 'subscript',
    label: 'Tiefgestellt',
    shortcut: 'Strg+,',
    icon: SubscriptIcon,
    mark: 'subscript',
    toggle: (editor) => editor.chain().focus().toggleSubscript().run(),
  },
];

/**
 * The innermost addressable block a position sits in.
 *
 * Walked from the inside out rather than taken from `collectBlockIdsInRange`,
 * which returns ancestors first: a comment on a sentence inside a list belongs
 * to that list *item*, not to the whole list. `null` when nothing on the path
 * carries an identifier yet, which makes the comment a page-wide one.
 */
function innermostBlockId(position: ResolvedPos): string | null {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    const id: unknown = position.node(depth).attrs[BLOCK_ID_ATTRIBUTE];
    if (isValidBlockId(id)) return id;
  }
  return null;
}

/**
 * Formatting bar that appears over a selection.
 *
 * This is the discoverable half of the editor: every mark the schema supports is
 * reachable here without knowing a shortcut. It deliberately does not appear for
 * an empty selection (nothing to format), inside a code block (no marks apply) or
 * while the document is read-only.
 */
export function SelectionToolbar({
  editor,
  catalog,
  documentId,
  workspaceId,
}: SelectionToolbarProps) {
  const { handOver } = useAiSelection();
  const { compose } = useCommentAnchor();

  /**
   * Opens a comment thread on the selected passage.
   *
   * The anchor is the *first* block the selection touches, not the range: a
   * comment addresses a place, and a block identifier is the only address that
   * survives the sentence being rewritten (issue #18). The selected text
   * travels as the quote so the thread still reads sensibly once the block is
   * gone.
   */
  const commentOnSelection = (): void => {
    const { from, to, $from } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
    compose({ documentId, blockId: innermostBlockId($from), quote: text });
  };

  /**
   * Hands the selected passage to the AI panel. It is not sent here: it becomes
   * a chip above the composer, and only the next submitted message carries it.
   */
  const sendSelectionToAi = (): void => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
    if (text.length === 0) return;
    handOver({ documentId, blockIds: collectBlockIdsInRange(editor.state.doc, from, to), text });
  };

  /*
   * `useEditor` does not re-render on every transaction in Tiptap 3, so the
   * pressed states are subscribed explicitly. One selector for the whole bar keeps
   * it to a single re-render per selection change instead of one per button.
   */
  const active = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      blockLabel: currentBlockLabel(instance, catalog),
      link: instance.isActive('link'),
      marks: Object.fromEntries(
        MARK_BUTTONS.map((button) => [button.id, instance.isActive(button.mark)]),
      ),
    }),
  });

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: instance, state, from, to }) => {
        if (!instance.isEditable) return false;
        if (from === to) return false;
        if (instance.isActive('codeBlock')) return false;
        // An image or a divider is a node selection, not a text run.
        return state.doc.textBetween(from, to, ' ').trim().length > 0;
      }}
    >
      <Toolbar aria-label="Formatierung" data-testid="selection-toolbar">
        <TurnIntoMenu
          editor={editor}
          catalog={catalog}
          trigger={
            <ToolbarButton
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Blocktyp: ${active.blockLabel}. In anderen Block umwandeln`}
                  data-testid="turn-into-trigger"
                />
              }
            >
              <TurnIntoTriggerLabel label={active.blockLabel} />
            </ToolbarButton>
          }
        />

        <ToolbarSeparator />

        {MARK_BUTTONS.map((button) => (
          <ToolbarButton
            key={button.id}
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${button.label} (${button.shortcut})`}
                // The accessible name never shows on screen; a pointer user needs the
                // tooltip to learn which icon does what, and the shortcut with it.
                title={`${button.label} (${button.shortcut})`}
                aria-pressed={active.marks[button.id] === true}
                data-pressed={active.marks[button.id] === true ? '' : undefined}
                data-testid={`mark-${button.id}`}
                className="data-pressed:bg-accent-strong data-pressed:text-foreground"
                // Without this the button takes the focus on mousedown and ProseMirror
                // drops the selection, so the command runs against nothing.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => button.toggle(editor)}
              />
            }
          >
            <button.icon />
          </ToolbarButton>
        ))}

        <ToolbarSeparator />

        {/* These three open a popover or a menu, where the trigger owns the click. */}
        <LinkMenu
          editor={editor}
          workspaceId={workspaceId}
          trigger={
            <ToolbarButton
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Link"
                  title="Link"
                  aria-pressed={active.link}
                  data-pressed={active.link ? '' : undefined}
                  data-testid="mark-link"
                  className="data-pressed:bg-accent-strong data-pressed:text-foreground"
                />
              }
            >
              <LinkIcon />
            </ToolbarButton>
          }
        />

        <ColorMenu
          editor={editor}
          trigger={
            <ToolbarButton
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Farbe"
                  title="Textfarbe"
                  data-testid="color-trigger"
                />
              }
            >
              <BaselineIcon />
            </ToolbarButton>
          }
        />

        <EmojiMenu
          editor={editor}
          trigger={
            <ToolbarButton
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Emoji"
                  title="Emoji"
                  data-testid="emoji-trigger"
                />
              }
            >
              <SmileIcon />
            </ToolbarButton>
          }
        />

        <ToolbarSeparator />

        <ToolbarButton
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Kommentieren"
              title="Kommentieren"
              data-testid="selection-to-comment"
              // Same reason as the mark buttons: taking the focus on mousedown drops
              // the ProseMirror selection, and the quote would be empty.
              onMouseDown={(event) => event.preventDefault()}
              onClick={commentOnSelection}
            />
          }
        >
          <MessageSquarePlusIcon />
        </ToolbarButton>

        <ToolbarButton
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="An KI schicken"
              title="An KI schicken"
              data-testid="selection-to-ai"
              // Same reason as the mark buttons: focus on mousedown would drop the
              // ProseMirror selection, and there would be nothing left to hand over.
              onMouseDown={(event) => event.preventDefault()}
              onClick={sendSelectionToAi}
            />
          }
        >
          <SparklesIcon />
        </ToolbarButton>

        <ToolbarSeparator />

        {/* The block actions are also on the gutter handle, but that one only
            appears on hover; here they are always reachable, including by
            keyboard. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ToolbarButton
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Blockaktionen"
                    title="Blockaktionen"
                    data-testid="block-actions-trigger"
                  />
                }
              >
                <MoreHorizontalIcon />
              </ToolbarButton>
            }
          />
          <DropdownMenuContent align="end">
            <BlockActionItems editor={editor} catalog={catalog} target={null} />
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>
    </BubbleMenu>
  );
}
