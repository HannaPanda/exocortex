'use client';

import { FileTextIcon, PlusIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button, type CommandItem, CommandPalette } from '@exocortex/ui';

import { useDocument } from '@/lib/api/document-queries';
import { useSearch } from '@/lib/api/search-queries';

/**
 * Choosing pages for a workflow node (issue #164): the pages an agent node
 * hands its work item, the subtree an event trigger listens to.
 *
 * A graph stores page ids, which nobody can read, so the chosen pages are
 * shown by title and picked by searching, through the same palette the
 * conversation's sources use. A page that is gone keeps its id on screen,
 * because the check names it and the person has to see what to remove.
 */
export function WorkflowPagePicker({
  workspaceId,
  value,
  max,
  onChange,
  label,
  testId,
}: {
  workspaceId: string;
  value: readonly string[];
  max: number;
  onChange: (ids: string[]) => void;
  label: string;
  testId: string;
}) {
  const t = useTranslations('workflows.pagePicker');
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const search = useSearch(open ? workspaceId : undefined, query);

  const items = React.useMemo<CommandItem[]>(
    () =>
      (search.data?.results ?? [])
        .filter((result) => !value.includes(result.documentId))
        .map((result) => ({
          id: result.documentId,
          group: t('group'),
          label: result.title.trim().length === 0 ? t('untitled') : result.title,
          hint: result.path.map((entry) => entry.title).join(' / '),
          icon: <FileTextIcon className="size-4 text-muted-foreground" />,
          onSelect: () => {
            setOpen(false);
            setQuery('');
            onChange(max === 1 ? [result.documentId] : [...value, result.documentId]);
          },
        })),
    [max, onChange, search.data, t, value],
  );

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {value.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {value.map((id) => (
            <PageChip
              key={id}
              documentId={id}
              onRemove={() => onChange(value.filter((entry) => entry !== id))}
            />
          ))}
        </ul>
      )}
      {value.length >= max && max !== 1 ? null : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setOpen(true)}
          data-testid={`${testId}-add`}
        >
          <PlusIcon className="size-4" />
          {max === 1 && value.length === 1 ? t('replace') : t('add')}
        </Button>
      )}
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        items={items}
        placeholder={t('placeholder')}
        emptyLabel={query.trim().length > 1 ? t('empty') : t('typeToSearch')}
      />
    </div>
  );
}

function PageChip({ documentId, onRemove }: { documentId: string; onRemove: () => void }) {
  const t = useTranslations('workflows.pagePicker');
  const document = useDocument(documentId);
  const title = document.isError
    ? documentId
    : (document.data?.title ?? '').trim().length === 0
      ? document.isPending
        ? '…'
        : t('untitled')
      : document.data!.title;
  return (
    <li className="inline-flex max-w-full items-center gap-1 rounded-sm bg-secondary py-0.5 pr-0.5 pl-2 text-xs text-secondary-foreground">
      <FileTextIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-5"
        aria-label={t('remove', { title })}
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </Button>
    </li>
  );
}
