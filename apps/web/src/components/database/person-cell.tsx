'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseRow, type DatabaseRowHeight } from '@exocortex/contracts';
import {
  Avatar,
  AvatarFallback,
  cn,
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exocortex/ui';

import { initialsOf } from '@/components/shell/document-session';
import { useWorkspacePeople } from '@/lib/api/workspace-queries';

import { type PropertyCellProps } from './cells';
import {
  personIdsOfValue,
  pickerChoices,
  type ResolvedPerson,
  resolvePerson,
  samePeople,
} from './person-values';
import { ROW_HEIGHT_BOX_CLAMP } from './table-columns';

/**
 * The cell of a PERSON column, and the read-only face of who created or last
 * changed a row (issue #314): names with their initials, and a picker with
 * search over the members of the workspace.
 *
 * A column holds a list, as Notion's "Personen" does; the schema has no
 * single-person setting and none was added. Names come from two places: the
 * row's own `people`, which the server reads from the accounts themselves so
 * somebody who left stays named, and the workspace's member list, asked once
 * per workspace and kept in the browser. The member list is only asked by a
 * member -- a guest holding a share sees the names already in the cell and can
 * take somebody out, but is shown nobody to add.
 *
 * The picker keeps its own draft while it is open and commits when it closes
 * (Escape, a click outside, Tab away), the same contract as the text cells.
 * That keeps the cell unkeyed -- a refetch while choosing does not close it --
 * and sends one write for one decision.
 */

/** The name a person goes by here, or the word for an account nobody can name. */
function usePersonLabel(): (person: ResolvedPerson) => string {
  const t = useTranslations('database.cells');
  return React.useCallback(
    (person: ResolvedPerson) =>
      person.name ?? (person.state === 'deleted' ? t('personDeleted') : t('personUnknown')),
    [t],
  );
}

function PersonChip({ person, label }: { person: ResolvedPerson; label: string }) {
  const t = useTranslations('database.cells');
  const quiet = person.state !== 'member';
  return (
    <span
      className="inline-flex max-w-48 min-w-0 items-center gap-1.5 text-sm"
      title={person.state === 'former' ? t('personFormerHint', { name: label }) : label}
      data-person-state={person.state}
    >
      <Avatar className="size-5" aria-hidden>
        <AvatarFallback className={cn('text-nano', quiet && 'text-muted-foreground')}>
          {person.name === null ? '?' : initialsOf(person.name)}
        </AvatarFallback>
      </Avatar>
      <span
        className={cn(
          'truncate',
          quiet && 'text-muted-foreground',
          person.state === 'deleted' && 'italic',
        )}
      >
        {label}
        {person.state === 'former' ? <span className="sr-only">, {t('personFormer')}</span> : null}
      </span>
    </span>
  );
}

/** Everything the cell and the card need to name the people in a value. */
function usePeopleOf(value: unknown, row: DatabaseRow | undefined, workspaceId?: string) {
  const directory = useWorkspacePeople(row?.document.workspaceId ?? workspaceId);
  const label = usePersonLabel();
  const resolve = React.useCallback(
    (id: string) => resolvePerson(id, row?.people, directory.members),
    [row?.people, directory.members],
  );
  return { ids: personIdsOfValue(value), resolve, label, directory };
}

function PeopleChips({
  ids,
  resolve,
  label,
  rowHeight,
}: {
  ids: readonly string[];
  resolve: (id: string) => ResolvedPerson;
  label: (person: ResolvedPerson) => string;
  rowHeight: DatabaseRowHeight;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 overflow-hidden',
        ROW_HEIGHT_BOX_CLAMP[rowHeight],
      )}
    >
      {ids.map((id) => {
        const person = resolve(id);
        return <PersonChip key={id} person={person} label={label(person)} />;
      })}
    </div>
  );
}

export function PersonCell({
  property,
  value,
  onChange,
  readOnly,
  rowHeight = 'short',
  row,
  workspaceId,
}: PropertyCellProps) {
  const t = useTranslations('database.cells');
  const { ids, resolve, label, directory } = usePeopleOf(value, row, workspaceId);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string[]>([]);
  const [openedWith, setOpenedWith] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  if (readOnly) {
    return (
      <div
        className="flex min-h-8 items-start px-1.5 py-1.5"
        data-testid={`person-cell-${property.id}`}
      >
        <PeopleChips ids={ids} resolve={resolve} label={label} rowHeight={rowHeight} />
      </div>
    );
  }

  const changeOpen = (next: boolean): void => {
    if (next) {
      setDraft(ids);
      setOpenedWith(ids);
    } else if (open && !samePeople(draft, ids)) {
      onChange(draft.length === 0 ? null : draft);
    }
    setOpen(next);
  };

  const shown = open ? draft : ids;
  const choices = pickerChoices(directory.members, openedWith);
  const loading = directory.isMember && directory.members === null;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-h-8 w-full items-start rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-testid={`person-cell-${property.id}`}
          >
            {shown.length === 0 ? (
              <span className="text-sm text-muted-foreground">{t('empty')}</span>
            ) : (
              <PeopleChips ids={shown} resolve={resolve} label={label} rowHeight={rowHeight} />
            )}
          </button>
        }
      />
      <PopoverContent
        align="start"
        className="w-72 p-0"
        initialFocus={inputRef}
        data-testid="person-picker"
      >
        <Combobox
          inline
          open
          multiple
          items={choices}
          value={draft}
          onValueChange={(next: string[]) => setDraft(next)}
          itemToStringLabel={(id: string) => label(resolve(id))}
        >
          <ComboboxChips className="rounded-b-none border-x-0 border-t-0 shadow-none focus-within:ring-0">
            {draft.map((id) => {
              const person = resolve(id);
              const name = label(person);
              return (
                <ComboboxChip key={id} removeLabel={t('personRemove', { name })}>
                  <span
                    className={cn(
                      'max-w-36 truncate',
                      person.state !== 'member' && 'text-muted-foreground',
                    )}
                  >
                    {name}
                  </span>
                </ComboboxChip>
              );
            })}
            <ComboboxChipsInput
              ref={inputRef}
              placeholder={draft.length === 0 ? t('personSearch') : undefined}
              aria-label={t('personSearchLabel', { name: property.name })}
              autoComplete="off"
              spellCheck={false}
              data-testid="person-search"
            />
          </ComboboxChips>
          <ComboboxEmpty>
            {loading ? t('personLoading') : choices.length === 0 ? null : t('personNoMatch')}
          </ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {(id: string) => {
              const person = resolve(id);
              return (
                <ComboboxItem key={id} value={id} data-testid="person-option">
                  <PersonChip person={person} label={label(person)} />
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </Combobox>
        {directory.isMember ? null : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {t('personNoDirectory')}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The names in a value for a board or gallery card: a summary, not a control. */
export function PeopleValueDisplay({
  value,
  row,
}: {
  value: unknown;
  row: DatabaseRow | undefined;
}) {
  const { ids, resolve, label } = usePeopleOf(value, row);
  if (ids.length === 0) return null;
  const names = ids.map((id) => label(resolve(id))).join(', ');
  return (
    <span className="truncate text-xs text-muted-foreground" title={names}>
      {names}
    </span>
  );
}
