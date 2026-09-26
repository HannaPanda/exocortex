'use client';

import { ArrowRightLeftIcon, MinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type DocumentDiffBlock } from '@exocortex/contracts';

/**
 * The pieces a block diff is drawn with (issue #77), shared by the snapshot
 * comparison and the changeset review (issue #141), so a change reads the
 * same wherever it is shown.
 */

/**
 * The block types the catalogue names. `DIFF_BLOCK_TYPE_LABELS` in
 * `packages/editor` is the German reference the agent tool reads; a type
 * missing here reads as its raw name, as it does there.
 */
const NAMED_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'horizontalRule',
  'table',
  'callout',
  'details',
  'columnList',
  'blockMath',
  'tableOfContents',
  'pageLink',
  'breadcrumb',
  'databaseEmbed',
  'savedQueryEmbed',
  'transclusion',
  'fileAttachment',
  'image',
  'video',
  'audio',
  'pdf',
  'embed',
  'bookmark',
] as const;
type NamedBlockType = (typeof NAMED_BLOCK_TYPES)[number];

function isNamedBlockType(nodeType: string): nodeType is NamedBlockType {
  return (NAMED_BLOCK_TYPES as readonly string[]).includes(nodeType);
}

/** A block type's name in the reader's language, from `nodeType` rather than the server's label. */
export function useBlockTypeLabel(): (nodeType: string) => string {
  const t = useTranslations('document.snapshotDiff.blockTypes');
  return (nodeType) => (isNamedBlockType(nodeType) ? t(nodeType) : nodeType);
}

export function KindIcon({ block }: { block: DocumentDiffBlock }) {
  const className = 'size-4 shrink-0';
  if (block.kind === 'added')
    return <PlusIcon className={`${className} text-success`} aria-hidden />;
  if (block.kind === 'removed') {
    return <MinusIcon className={`${className} text-destructive-text`} aria-hidden />;
  }
  if (block.kind === 'changed') {
    return <PencilIcon className={`${className} text-muted-foreground`} aria-hidden />;
  }
  return <ArrowRightLeftIcon className={`${className} text-muted-foreground`} aria-hidden />;
}

/**
 * The word diff of one changed block.
 *
 * Deletions keep their strike-through *and* their colour: colour alone is not a
 * difference everybody can see, and this is the one place in the dialog where
 * the two directions have to be told apart at a glance.
 */
export function Segments({ block }: { block: DocumentDiffBlock }) {
  if (block.segments.length === 0) {
    return <p className="text-sm whitespace-pre-wrap">{block.afterText ?? block.beforeText}</p>;
  }
  return (
    <p className="text-sm leading-relaxed whitespace-pre-wrap">
      {block.segments.map((segment, index) => {
        if (segment.kind === 'equal') return <span key={index}>{segment.text}</span>;
        if (segment.kind === 'inserted') {
          return (
            <span key={index} data-segment="inserted" className="rounded-xs bg-success/25 px-0.5">
              {segment.text}
            </span>
          );
        }
        return (
          <span
            key={index}
            data-segment="removed"
            className="rounded-xs bg-destructive/25 px-0.5 line-through"
          >
            {segment.text}
          </span>
        );
      })}
    </p>
  );
}

/** One block of a diff, read-only: what changed, as the reader sees it. */
export function DiffBlockView({ block }: { block: DocumentDiffBlock }) {
  const t = useTranslations('document.snapshotDiff');
  const blockTypeLabel = useBlockTypeLabel();
  const text = block.kind === 'removed' ? block.beforeText : block.afterText;
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2"
      data-testid="diff-block"
      data-block-kind={block.kind}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <KindIcon block={block} />
        <span>{t(`kinds.${block.kind}`)}</span>
        <span>· {blockTypeLabel(block.nodeType)}</span>
        {block.moved ? <span>· {t('moved')}</span> : null}
      </span>
      {block.kind === 'changed' ? (
        <Segments block={block} />
      ) : (
        <p className="text-sm whitespace-pre-wrap">{text}</p>
      )}
    </div>
  );
}
