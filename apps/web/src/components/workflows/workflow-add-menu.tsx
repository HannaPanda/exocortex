'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkflowNodeType } from '@exocortex/contracts';
import { cn, Input } from '@exocortex/ui';

import { NODE_GROUPS } from './workflow-draft';
import { NODE_ICONS, useWorkflowWording } from './workflow-labels';

/**
 * Choosing what to add (issue #198): a filter field over the node types,
 * grouped in the order a workflow is read. It is the same list wherever it
 * opens -- the `+` at the top of the rail, the `+` beside a node's way out,
 * the `A` key -- so there is one place to learn it.
 *
 * The field keeps the focus while the arrow keys move through the options,
 * which are announced through `aria-activedescendant`, the pattern the slash
 * menu and the command palette use. A trigger is left out when the new node
 * hangs from another one, because nothing may lead into a trigger.
 */
export function WorkflowAddMenu({
  onPick,
  withTriggers,
  context,
}: {
  onPick: (type: WorkflowNodeType) => void;
  withTriggers: boolean;
  /** One line above the field saying where the node will go, if anywhere. */
  context?: string | null;
}) {
  const t = useTranslations('workflows.palette');
  const wording = useWorkflowWording();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listId = React.useId();

  const groups = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('de');
    return NODE_GROUPS.filter((group) => withTriggers || group.key !== 'trigger')
      .map((group) => ({
        key: group.key,
        types: group.types.filter((type) => {
          if (needle.length === 0) return true;
          return `${wording.type(type)} ${wording.typeHint(type)}`
            .toLocaleLowerCase('de')
            .includes(needle);
        }),
      }))
      .filter((group) => group.types.length > 0);
  }, [query, withTriggers, wording]);
  const flat = groups.flatMap((group) => group.types);
  const current = flat[Math.min(active, flat.length - 1)];

  return (
    <div className="flex w-72 flex-col gap-2" data-testid="workflow-add-menu">
      {context ? <p className="px-1 text-meta text-muted-foreground">{context}</p> : null}
      <Input
        autoFocus
        value={query}
        placeholder={t('search')}
        aria-label={t('search')}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={current === undefined ? undefined : `${listId}-${current}`}
        data-testid="workflow-add-search"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, flat.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' && current !== undefined) {
            event.preventDefault();
            onPick(current);
          }
        }}
      />
      {flat.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">{t('empty', { query })}</p>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={t('label')}
          className="flex max-h-80 flex-col gap-1 overflow-y-auto"
        >
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={wording.group(group.key)}>
              <p className="px-2 pt-1 pb-0.5 text-micro tracking-wide text-muted-foreground uppercase">
                {wording.group(group.key)}
              </p>
              {group.types.map((type) => {
                const selected = type === current;
                return (
                  <div
                    key={type}
                    id={`${listId}-${type}`}
                    role="option"
                    aria-selected={selected}
                    data-testid={`workflow-add-${type}`}
                    className={cn(
                      'flex cursor-default items-start gap-2.5 rounded-sm px-2 py-1.5',
                      selected ? 'bg-accent-strong' : 'hover:bg-accent-solid',
                    )}
                    onMouseMove={() => setActive(flat.indexOf(type))}
                    // `onMouseDown`, so the field keeps the focus until the pick.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onPick(type);
                    }}
                  >
                    <NodeTypeMark type={type} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-ui">{wording.type(type)}</span>
                      <span className="block text-meta text-muted-foreground">
                        {wording.typeHint(type)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The family a node type belongs to, which decides the shape of its mark. */
export function nodeFamily(type: WorkflowNodeType): 'trigger' | 'work' | 'control' | 'end' {
  if (type.startsWith('trigger.')) return 'trigger';
  if (type === 'agent') return 'work';
  if (type === 'end') return 'end';
  return 'control';
}

/**
 * A node type's icon in a small tile whose shape names its family: a circle
 * for where a run starts, a square for work, a diamond for a decision about
 * the path, a ringed circle for where it ends. The shape carries the family
 * so the colour does not have to (the One Signal Rule leaves no colour for
 * it anyway), and it reads the same in the add menu, the rail and on the
 * canvas.
 */
export function NodeTypeMark({
  type,
  className,
  size = 'md',
}: {
  type: WorkflowNodeType;
  className?: string;
  size?: 'md' | 'lg';
}) {
  const Icon = NODE_ICONS[type];
  const family = nodeFamily(type);
  const box = size === 'lg' ? 'size-7' : 'size-6';
  const icon = size === 'lg' ? 'size-4' : 'size-3.5';
  if (family === 'control') {
    return (
      <span className={cn('relative grid shrink-0 place-items-center', box, className)} aria-hidden>
        <span className="absolute inset-0.75 rotate-45 rounded-xs border border-border-strong bg-sunken" />
        <Icon className={cn('relative text-foreground', icon)} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center border border-border-strong bg-sunken text-foreground',
        box,
        family === 'work' ? 'rounded-sm' : 'rounded-full',
        family === 'end' && 'outline outline-1 outline-offset-1 outline-border-strong',
        className,
      )}
      aria-hidden
    >
      <Icon className={icon} />
    </span>
  );
}
