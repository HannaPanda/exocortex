'use client';

import { ArrowDownIcon, ArrowUpIcon, FilterIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DatabaseFilterCondition,
  type DatabaseFilterOperator,
  type DatabaseProperty,
  type DatabaseSort,
  type DatabaseView,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useUpdateDatabaseView } from '@/lib/api/database-queries';

import { FILTER_OPERATOR_LABELS, operatorsForType } from './property-types';

interface FilterSortBarProps {
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

function propertyName(properties: DatabaseProperty[], propertyId: string): string {
  return properties.find((property) => property.id === propertyId)?.name ?? '?';
}

/** Flat AND-only conditions: this bar builds `{combinator:'and', conditions: [...leaves]}`, never nested groups. */
function leafConditions(view: DatabaseView): DatabaseFilterCondition[] {
  return view.filters.conditions.filter((entry): entry is DatabaseFilterCondition => 'propertyId' in entry);
}

export function FilterSortBar({ documentId, view, properties, readOnly }: FilterSortBarProps) {
  const updateView = useUpdateDatabaseView(documentId);
  const conditions = leafConditions(view);

  const removeCondition = (index: number) => {
    const next = conditions.filter((_, entryIndex) => entryIndex !== index);
    updateView.mutate({ viewId: view.id, request: { filters: { combinator: 'and', conditions: next } } });
  };

  const addCondition = (condition: DatabaseFilterCondition) => {
    updateView.mutate({
      viewId: view.id,
      request: { filters: { combinator: 'and', conditions: [...conditions, condition] } },
    });
  };

  const removeSort = (index: number) => {
    const next = view.sorts.filter((_, entryIndex) => entryIndex !== index);
    updateView.mutate({ viewId: view.id, request: { sorts: next } });
  };

  const addSort = (sort: DatabaseSort) => {
    // A property can only be sorted once; replace an existing sort for it.
    const next = [...view.sorts.filter((entry) => entry.propertyId !== sort.propertyId), sort];
    updateView.mutate({ viewId: view.id, request: { sorts: next } });
  };

  if (properties.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
      {conditions.map((condition, index) => (
        <Badge key={`${condition.propertyId}-${index}`} variant="secondary" className="gap-1">
          {propertyName(properties, condition.propertyId)} {FILTER_OPERATOR_LABELS[condition.operator]}
          {condition.value !== undefined ? ` ${String(condition.value)}` : ''}
          {readOnly ? null : (
            <button type="button" aria-label="Filter entfernen" onClick={() => removeCondition(index)}>
              <XIcon className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {view.sorts.map((sort, index) => (
        <Badge key={`${sort.propertyId}-sort`} variant="secondary" className="gap-1">
          {sort.direction === 'asc' ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />}
          {propertyName(properties, sort.propertyId)}
          {readOnly ? null : (
            <button type="button" aria-label="Sortierung entfernen" onClick={() => removeSort(index)}>
              <XIcon className="size-3" />
            </button>
          )}
        </Badge>
      ))}

      {readOnly ? null : (
        <>
          <AddFilterPopover properties={properties} onAdd={addCondition} />
          <AddSortPopover properties={properties} onAdd={addSort} />
        </>
      )}
    </div>
  );
}

function AddFilterPopover({
  properties,
  onAdd,
}: {
  properties: DatabaseProperty[];
  onAdd: (condition: DatabaseFilterCondition) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [propertyId, setPropertyId] = React.useState(properties[0]?.id ?? '');
  const property = properties.find((entry) => entry.id === propertyId) ?? properties[0];
  const operators = property === undefined ? [] : operatorsForType(property.type);
  const [operator, setOperator] = React.useState<DatabaseFilterOperator>(operators[0] ?? 'equals');
  const [value, setValue] = React.useState('');

  if (property === undefined) return null;
  const needsValue = operator !== 'is_empty' && operator !== 'is_not_empty';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" data-testid="add-filter">
            <FilterIcon /> Filter
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsedValue: DatabaseFilterCondition['value'] =
              !needsValue
                ? undefined
                : property.type === 'NUMBER'
                  ? Number(value)
                  : property.type === 'CHECKBOX'
                    ? value === 'true'
                    : value;
            onAdd({ propertyId: property.id, operator, value: parsedValue });
            setOpen(false);
            setValue('');
          }}
        >
          <Select
            value={propertyId}
            onValueChange={(next) => {
              const id = next ?? '';
              setPropertyId(id);
              // Reset here, in the handler that caused the change, rather
              // than in an effect watching `property.type`: the available
              // operators depend on the newly selected property's type, and
              // the old operator may no longer be valid for it.
              const nextProperty = properties.find((entry) => entry.id === id);
              setOperator(operatorsForType(nextProperty?.type ?? 'TEXT')[0] ?? 'equals');
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {properties.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={operator} onValueChange={(next) => setOperator(next as DatabaseFilterOperator)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {FILTER_OPERATOR_LABELS[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsValue ? (
            <Input
              autoFocus
              type={property.type === 'NUMBER' ? 'number' : property.type === 'DATE' ? 'date' : 'text'}
              value={value}
              placeholder="Wert"
              onChange={(event) => setValue(event.target.value)}
            />
          ) : null}
          <Button type="submit" size="sm">
            Filter hinzufügen
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function AddSortPopover({
  properties,
  onAdd,
}: {
  properties: DatabaseProperty[];
  onAdd: (sort: DatabaseSort) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [propertyId, setPropertyId] = React.useState(properties[0]?.id ?? '');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" data-testid="add-sort">
            <ArrowUpIcon /> Sortieren
          </Button>
        }
      />
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-2">
          <Select value={propertyId} onValueChange={(next) => setPropertyId(next ?? '')}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {properties.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => {
                onAdd({ propertyId, direction: 'asc' });
                setOpen(false);
              }}
            >
              <ArrowUpIcon /> Aufsteigend
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => {
                onAdd({ propertyId, direction: 'desc' });
                setOpen(false);
              }}
            >
              <ArrowDownIcon /> Absteigend
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

