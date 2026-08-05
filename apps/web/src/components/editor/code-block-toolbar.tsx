'use client';

import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { CheckIcon, CopyIcon } from 'lucide-react';
import * as React from 'react';

import { CODE_BLOCK_LANGUAGES } from '@exocortex/editor';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

/** How long the copy button stays in its confirmed state. */
const COPIED_FEEDBACK_MS = 1_500;

/**
 * Controls for the code block the cursor is in: language and copy.
 *
 * A separate bar from the selection toolbar because it applies to the *block*, not
 * to a selection, and because inside a code block no inline mark applies (which is
 * why the selection toolbar hides itself there).
 */
export function CodeBlockToolbar({ editor }: { editor: Editor }) {
  const [copied, setCopied] = React.useState(false);

  const language = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const value = instance.getAttributes('codeBlock').language;
      return typeof value === 'string' ? value : '';
    },
  });

  const copy = async (): Promise<void> => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name !== 'codeBlock') continue;
      await window.navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      return;
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="codeBlockToolbar"
      options={{ placement: 'top-end', offset: 4 }}
      shouldShow={({ editor: instance }) => instance.isEditable && instance.isActive('codeBlock')}
    >
      <div
        className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-lg"
        data-testid="code-block-toolbar"
      >
        <Select
          value={language}
          onValueChange={(value) => {
            editor
              .chain()
              .focus()
              .updateAttributes('codeBlock', { language: typeof value === 'string' ? value : '' })
              .run();
          }}
        >
          <SelectTrigger size="sm" aria-label="Sprache" data-testid="code-language-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_BLOCK_LANGUAGES.map((entry) => (
              <SelectItem
                key={entry.value}
                value={entry.value}
                data-testid={`code-language-${entry.value.length > 0 ? entry.value : 'none'}`}
              >
                <SelectItemText>{entry.label}</SelectItemText>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? 'Code kopiert' : 'Code kopieren'}
          data-testid="code-copy"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </BubbleMenu>
  );
}
