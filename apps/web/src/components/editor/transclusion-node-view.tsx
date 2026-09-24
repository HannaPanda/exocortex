'use client';

import { type NodeViewProps } from '@tiptap/core';
import { EditorContent, NodeViewWrapper, useEditor } from '@tiptap/react';
import { ExternalLinkIcon, ListTreeIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DocumentOutlineBlock } from '@exocortex/contracts';
import {
  buildEditorExtensions,
  transclusionBlockId,
  transclusionDocumentId,
  transclusionLabel,
} from '@exocortex/editor';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  LoadingState,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocumentFragment } from '@/lib/api/transclusion-queries';

import { PageLinkPromptContext } from './page-link-context';

interface TransclusionNodeViewProps extends NodeViewProps {
  workspaceId: string;
  /** The page this block sits on, so it can refuse to embed itself. */
  documentId: string;
}

/**
 * React node view for the `transclusion` node (issue #78, ADR-045).
 *
 * The block owns a reference and shows content it does not own. Everything on
 * screen here comes from one read of the source, performed as the person
 * looking, so the source's permissions decide what appears -- a reader without
 * access sees that something is embedded, never what.
 *
 * The content is rendered by a second, read-only editor over the canonical
 * schema rather than by a Markdown renderer of its own. That is the only way
 * the embedded copy looks like the original: a checklist stays a checklist, a
 * callout stays a callout, and the two renderings cannot drift apart because
 * there is only one.
 *
 * A transclusion inside the fragment is left as the plain block the schema
 * renders and is not resolved further. One level is what makes a cycle
 * impossible rather than detectable (ADR-045), so two pages embedding each
 * other both render, each naming the way back without following it.
 */
export function TransclusionNodeView({
  node,
  editor,
  updateAttributes,
  workspaceId,
  documentId,
}: TransclusionNodeViewProps) {
  const target = transclusionDocumentId(node.attrs);
  const blockId = transclusionBlockId(node.attrs);
  const label = transclusionLabel(node.attrs);
  const askPageLink = React.useContext(PageLinkPromptContext);
  const editable = editor.isEditable;

  // A page may not embed itself: the block would show the page it sits on,
  // with itself inside it. Refused here rather than resolved, because the
  // answer to "what does this show" would be "this".
  const self = target !== null && target === documentId;
  const fragment = useDocumentFragment(self ? null : target, blockId);

  const retarget = async (): Promise<void> => {
    const picked = await askPageLink?.current?.(label);
    if (picked === null || picked === undefined) return;
    // A new source invalidates the old block address; whole page is the only
    // honest default, and the block is picked again from the new page.
    updateAttributes({
      documentId: picked.documentId,
      label: picked.title,
      sourceBlockId: null,
    });
  };

  const title = fragment.data?.title ?? (label.length > 0 ? label : 'Eingebetteter Inhalt');

  return (
    <NodeViewWrapper className="exocortex-transclusion" contentEditable={false}>
      <div className="embed-header">
        <DocumentIcon
          icon={fragment.data?.icon ?? null}
          iconColor={fragment.data?.iconColor ?? null}
          type="PAGE"
        />
        <span className="embed-title">{title}</span>
        {fragment.data?.archivedAt == null ? null : <Badge variant="muted">Im Papierkorb</Badge>}
        <div className="embed-actions">
          {target === null || self ? null : (
            <Link
              href={`/arbeitsbereich/${workspaceId}/seite/${target}`}
              className="embed-action"
              data-testid="transclusion-open-source"
            >
              <ExternalLinkIcon aria-hidden />
              Quelle öffnen
            </Link>
          )}
          {editable && target !== null && !self ? (
            <BlockChooser
              documentId={target}
              blockId={blockId}
              onChoose={(chosen) => updateAttributes({ sourceBlockId: chosen })}
            />
          ) : null}
          {editable ? (
            <Button
              variant="ghost"
              size="sm"
              className="embed-action"
              data-testid="transclusion-retarget"
              onClick={() => void retarget()}
            >
              <PencilIcon aria-hidden />
              Seite wechseln
            </Button>
          ) : null}
        </div>
      </div>

      <TransclusionBody
        editable={editable}
        self={self}
        target={target}
        blockId={blockId}
        state={fragment}
        onRetarget={() => void retarget()}
        onWholePage={() => updateAttributes({ sourceBlockId: null })}
      />
    </NodeViewWrapper>
  );
}

/** Everything below the header: one of five states, never a blank box. */
function TransclusionBody({
  editable,
  self,
  target,
  blockId,
  state,
  onRetarget,
  onWholePage,
}: {
  editable: boolean;
  self: boolean;
  target: string | null;
  blockId: string | null;
  state: ReturnType<typeof useDocumentFragment>;
  onRetarget: () => void;
  onWholePage: () => void;
}) {
  const chooseSource = editable ? { label: 'Seite wählen', onClick: onRetarget } : undefined;

  if (target === null) {
    return (
      <EmptyState
        title="Keine Quelle gewählt"
        description="Wähle die Seite, deren Inhalt hier erscheinen soll. Der Text bleibt dort und wird hier nur gezeigt."
        action={chooseSource}
      />
    );
  }
  if (self) {
    return (
      <EmptyState
        title="Eine Seite kann sich nicht selbst einbetten"
        description="Wähle eine andere Seite als Quelle."
        action={chooseSource}
      />
    );
  }
  if (state.isPending) {
    return <LoadingState variant="skeleton" rows={3} label="Eingebetteter Inhalt wird geladen" />;
  }
  if (state.isError || state.data === undefined) {
    return (
      <EmptyState
        title="Quelle nicht erreichbar"
        description="Die eingebettete Seite wurde gelöscht, oder du darfst sie nicht lesen. Der Verweis bleibt bestehen."
        action={chooseSource}
      />
    );
  }
  if (!state.data.resolved) {
    return (
      <EmptyState
        title="Der eingebettete Abschnitt ist nicht mehr da"
        description={`Die Seite „${state.data.title}“ gibt es noch, der Block mit der Kennung ${blockId ?? ''} darin nicht mehr.`}
        action={editable ? { label: 'Ganze Seite zeigen', onClick: onWholePage } : undefined}
      />
    );
  }

  return (
    <div className="p-3" data-testid="transclusion-content">
      <ReadOnlyFragment content={state.data.proseMirrorJson} />
      {state.data.nested === 0 ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Enthält {state.data.nested} weitere Einbettung(en), die hier nicht aufgelöst werden.
        </p>
      )}
    </div>
  );
}

/**
 * The fragment, rendered by the canonical schema and nothing else.
 *
 * A second editor instance rather than a Markdown renderer: this is the
 * source's own content in the source's own vocabulary, and anything that
 * re-derived it would be a second rendering of one document, free to drift from
 * the first. Read-only, so nothing typed here could reach the source -- editing
 * at the place of the embedding is the "synced block" issue #78 explicitly
 * leaves for later.
 */
function ReadOnlyFragment({ content }: { content: unknown }) {
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: buildEditorExtensions(),
      content: content as object,
    },
    [],
  );

  React.useEffect(() => {
    if (editor === null) return;
    editor.commands.setContent(content as object, { emitUpdate: false });
  }, [content, editor]);

  return <EditorContent editor={editor} className="exocortex-editor" />;
}

/** Picks which block of the source the reference addresses. */
function BlockChooser({
  documentId,
  blockId,
  onChoose,
}: {
  documentId: string;
  blockId: string | null;
  onChoose: (blockId: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="embed-action"
            data-testid="transclusion-choose-block"
          >
            <ListTreeIcon aria-hidden />
            {blockId === null ? 'Ganze Seite' : 'Abschnitt'}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
        {/* The label has to sit inside a group: it is `Menu.GroupLabel`, and
            Base UI throws when it finds none, which the editor's error
            boundary turns into a blank page rather than a broken menu. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Was soll hier stehen?</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onChoose(null)}>Die ganze Seite</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {open ? <BlockChoices documentId={documentId} onChoose={onChoose} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The source's blocks, fetched only once the menu is open.
 *
 * Its own component for exactly that reason: the outline of a long page is not
 * small, and a reader who never opens this menu must not pay for it.
 */
function BlockChoices({
  documentId,
  onChoose,
}: {
  documentId: string;
  onChoose: (blockId: string) => void;
}) {
  const outline = useDocumentFragment(documentId, null, { outline: true });

  if (outline.isPending) {
    return <DropdownMenuItem disabled>Blöcke werden gelesen …</DropdownMenuItem>;
  }
  const blocks = outline.data?.blocks ?? [];
  if (blocks.length === 0) {
    return <DropdownMenuItem disabled>Diese Seite hat keine benannten Blöcke.</DropdownMenuItem>;
  }
  return (
    <DropdownMenuGroup>
      {blocks.map((block) => (
        <DropdownMenuItem
          key={block.blockId}
          data-testid={`transclusion-block-${block.blockId}`}
          onClick={() => onChoose(block.blockId)}
        >
          <BlockChoiceLabel block={block} />
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

function BlockChoiceLabel({ block }: { block: DocumentOutlineBlock }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">
        {block.preview.length > 0 ? block.preview : `(${block.type})`}
      </span>
      {block.level === null ? null : (
        <span className="text-xs text-muted-foreground">
          Überschrift {block.level}, mit dem ganzen Abschnitt darunter
        </span>
      )}
    </span>
  );
}
