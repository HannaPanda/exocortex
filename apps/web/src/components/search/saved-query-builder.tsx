'use client';

import { FilterIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DatabaseFilterCondition,
  type DatabaseFilterOperator,
  type DatabaseProperty,
  type DocumentTreeNode,
  type DocumentType,
  type SavedQueryDateRange,
  type SavedQueryDefinition,
  type SavedQuerySort,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  DatePicker,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import {
  FILTER_OPERATOR_LABELS,
  filterValueChoices,
  filterValueLabel,
  operatorsForType,
} from '@/components/database/property-types';
import { useDatabaseProperties } from '@/lib/api/database-queries';
import { useDocumentTree } from '@/lib/api/document-queries';
import { useEntities } from '@/lib/api/entity-queries';

/**
 * The query builder (issue #74): one form for the question behind a saved
 * search, a smart view and a query block.
 *
 * It is deliberately not a filter language with a parser. Every dimension is a
 * control, the controls are always all visible, and a query that matches
 * everything is the starting state rather than an error. Somebody who cannot
 * say what they want in these eight controls is better served by the search
 * box, and somebody who wants more than these eight can have it through the
 * API, where the definition is the same object.
 */

export interface SavedQueryBuilderProps {
  workspaceId: string;
  value: SavedQueryDefinition;
  onChange: (next: SavedQueryDefinition) => void;
}

const TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  PAGE: 'Seiten',
  COLLECTION: 'Datenbanken',
  PROJECT: 'Projekte',
};

const SORT_LABELS: Readonly<Record<SavedQuerySort, string>> = {
  RELEVANCE: 'Relevanz',
  UPDATED_DESC: 'Zuletzt geändert',
  UPDATED_ASC: 'Am längsten unverändert',
  CREATED_DESC: 'Zuletzt angelegt',
  CREATED_ASC: 'Zuerst angelegt',
  TITLE_ASC: 'Titel A bis Z',
  TITLE_DESC: 'Titel Z bis A',
};

const WINDOW_CHOICES = [
  { value: 'any', label: 'egal' },
  { value: '7', label: 'letzte 7 Tage' },
  { value: '30', label: 'letzte 30 Tage' },
  { value: '90', label: 'letzte 90 Tage' },
  { value: '365', label: 'letztes Jahr' },
  { value: 'custom', label: 'eigener Zeitraum' },
] as const;

const NO_VALUE = '__none__';

function flatten(
  nodes: readonly DocumentTreeNode[],
  depth = 0,
): { node: DocumentTreeNode; depth: number }[] {
  const result: { node: DocumentTreeNode; depth: number }[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    result.push(...flatten(node.children, depth + 1));
  }
  return result;
}

/** The picker's `YYYY-MM-DD` for an ISO timestamp, or no date. */
function dateInputValue(iso: string | null): string | null {
  return iso === null ? null : iso.slice(0, 10);
}

export function SavedQueryBuilder({ workspaceId, value, onChange }: SavedQueryBuilderProps) {
  const tree = useDocumentTree(workspaceId);
  const entries = React.useMemo(() => flatten(tree.data?.nodes ?? []), [tree.data]);
  const collections = entries.filter((entry) => entry.node.type === 'COLLECTION');
  const properties = useDatabaseProperties(value.collectionId ?? undefined);
  const entities = useEntities({ q: '', type: null });

  const patch = (next: Partial<SavedQueryDefinition>): void => onChange({ ...value, ...next });

  return (
    <div className="grid gap-4" data-testid="saved-query-builder">
      <div className="grid gap-1.5">
        <Label htmlFor="saved-query-text">Suchbegriff</Label>
        <Input
          id="saved-query-text"
          data-testid="saved-query-text"
          value={value.text ?? ''}
          placeholder="Leer lassen, um nur nach Ort, Typ und Zeit zu filtern"
          onChange={(event) =>
            patch({ text: event.target.value.length === 0 ? null : event.target.value })
          }
        />
        <Label htmlFor="saved-query-semantic" className="gap-2 text-sm font-normal">
          <Switch
            id="saved-query-semantic"
            checked={value.textMode === 'HYBRID'}
            onCheckedChange={(checked) => patch({ textMode: checked ? 'HYBRID' : 'KEYWORD' })}
          />
          Auch nach Bedeutung suchen, nicht nur nach dem Wort
        </Label>
      </div>

      <div className="grid gap-1.5">
        <Label id="saved-query-types-label">Art</Label>
        <ToggleGroup
          aria-labelledby="saved-query-types-label"
          value={value.types}
          multiple
          onValueChange={(next) => patch({ types: next as DocumentType[] })}
        >
          {(Object.keys(TYPE_LABELS) as DocumentType[]).map((type) => (
            <Toggle key={type} value={type} variant="outline" size="sm">
              {TYPE_LABELS[type]}
            </Toggle>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">Nichts gewählt heißt: alles.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="saved-query-under">Nur unterhalb von</Label>
          <Select
            value={value.underDocumentId ?? NO_VALUE}
            onValueChange={(next) =>
              patch({ underDocumentId: next === NO_VALUE || next === null ? null : next })
            }
          >
            <SelectTrigger id="saved-query-under" data-testid="saved-query-under">
              <SelectValue>
                {() =>
                  entries.find((entry) => entry.node.id === value.underDocumentId)?.node.title ??
                  'überall'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_VALUE}>überall</SelectItem>
              {entries.map((entry) => (
                <SelectItem key={entry.node.id} value={entry.node.id}>
                  {' '.repeat(entry.depth * 2)}
                  {entry.node.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Der Unterbaum wird bei jeder Ausführung neu bestimmt, verschobene Seiten wandern also
            mit.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="saved-query-collection">Nur Zeilen der Datenbank</Label>
          <Select
            value={value.collectionId ?? NO_VALUE}
            onValueChange={(next) => {
              const collectionId = next === NO_VALUE || next === null ? null : next;
              // A property filter only means something inside the database
              // that defines the properties, so changing the database drops it
              // rather than leaving ids behind that point nowhere.
              patch({ collectionId, propertyFilter: null });
            }}
          >
            <SelectTrigger id="saved-query-collection" data-testid="saved-query-collection">
              <SelectValue>
                {() =>
                  collections.find((entry) => entry.node.id === value.collectionId)?.node.title ??
                  'keine'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_VALUE}>keine</SelectItem>
              {collections.map((entry) => (
                <SelectItem key={entry.node.id} value={entry.node.id}>
                  {entry.node.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {value.collectionId === null ? null : (
        <PropertyFilterEditor
          properties={properties.data ?? []}
          conditions={conditionsOf(value)}
          onChange={(conditions) =>
            patch({
              propertyFilter:
                conditions.length === 0 ? null : { combinator: 'and', conditions: [...conditions] },
            })
          }
        />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="saved-query-entity">Erwähnt die Entität</Label>
        <Select
          value={value.entityIds[0] ?? NO_VALUE}
          onValueChange={(next) =>
            patch({ entityIds: next === NO_VALUE || next === null ? [] : [next] })
          }
        >
          <SelectTrigger id="saved-query-entity" data-testid="saved-query-entity">
            <SelectValue>
              {() =>
                entities.data?.entities.find((entity) => entity.id === value.entityIds[0])?.title ??
                'keine'
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_VALUE}>keine</SelectItem>
            {(entities.data?.entities ?? []).map((entity) => (
              <SelectItem key={entity.id} value={entity.id}>
                {entity.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateRangeField
          id="saved-query-updated"
          label="Geändert"
          range={value.updated}
          onChange={(updated) => patch({ updated })}
        />
        <DateRangeField
          id="saved-query-created"
          label="Angelegt"
          range={value.created}
          onChange={(created) => patch({ created })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="saved-query-sort">Reihenfolge</Label>
          <Select
            value={value.sort}
            onValueChange={(next) => patch({ sort: (next ?? 'RELEVANCE') as SavedQuerySort })}
          >
            <SelectTrigger id="saved-query-sort" data-testid="saved-query-sort">
              <SelectValue>{() => SORT_LABELS[value.sort]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SavedQuerySort[]).map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {SORT_LABELS[sort]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {value.sort === 'RELEVANCE' && (value.text ?? '').length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Ohne Suchbegriff gibt es keine Relevanz. Sortiert wird dann nach zuletzt geändert.
            </p>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="saved-query-limit">Höchstens</Label>
          <Input
            id="saved-query-limit"
            data-testid="saved-query-limit"
            type="number"
            min={1}
            max={200}
            value={value.limit}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) patch({ limit: Math.min(Math.max(parsed, 1), 200) });
            }}
          />
        </div>

        <div className="flex items-end">
          <Label htmlFor="saved-query-archived" className="gap-2 text-sm font-normal">
            <Switch
              id="saved-query-archived"
              checked={value.includeArchived}
              onCheckedChange={(checked) => patch({ includeArchived: checked })}
            />
            Papierkorb einbeziehen
          </Label>
        </div>
      </div>
    </div>
  );
}

/** The flat leaf conditions of a definition; the builder never nests groups. */
function conditionsOf(definition: SavedQueryDefinition): DatabaseFilterCondition[] {
  if (definition.propertyFilter === null) return [];
  return definition.propertyFilter.conditions.filter(
    (entry): entry is DatabaseFilterCondition => 'propertyId' in entry,
  );
}

/**
 * A time window, relative by default.
 *
 * Relative is the whole point of a *saved* window: "die letzten 30 Tage" has
 * to keep meaning that next month. The absolute pair is behind "eigener
 * Zeitraum" for the report that really is about one quarter.
 */
function DateRangeField({
  id,
  label,
  range,
  onChange,
}: {
  id: string;
  label: string;
  range: SavedQueryDateRange;
  onChange: (next: SavedQueryDateRange) => void;
}) {
  const isCustom = range.withinDays === null && (range.after !== null || range.before !== null);
  const [custom, setCustom] = React.useState(isCustom);
  const selection = custom
    ? 'custom'
    : range.withinDays === null
      ? 'any'
      : String(range.withinDays);

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={selection}
        onValueChange={(next) => {
          if (next === 'custom') {
            setCustom(true);
            onChange({ withinDays: null, after: range.after, before: range.before });
            return;
          }
          setCustom(false);
          onChange({
            withinDays: next === 'any' || next === null ? null : Number.parseInt(next, 10),
            after: null,
            before: null,
          });
        }}
      >
        <SelectTrigger id={id} data-testid={id}>
          <SelectValue>
            {() => WINDOW_CHOICES.find((choice) => choice.value === selection)?.label ?? 'egal'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {WINDOW_CHOICES.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {custom ? (
        <div className="flex items-center gap-2">
          <DatePicker
            clearable
            aria-label={`${label}: ab`}
            value={dateInputValue(range.after)}
            onChange={(day) =>
              onChange({
                withinDays: null,
                after: day === null ? null : `${day}T00:00:00Z`,
                before: range.before,
              })
            }
          />
          <span className="text-xs text-muted-foreground">bis</span>
          <DatePicker
            clearable
            aria-label={`${label}: bis`}
            value={dateInputValue(range.before)}
            onChange={(day) =>
              onChange({
                withinDays: null,
                after: range.after,
                before: day === null ? null : `${day}T00:00:00Z`,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Property conditions, flat and joined with AND.
 *
 * The same shape and the same helpers the database view's filter bar uses, so
 * "Status ist Offen" means one thing in the workspace. Nested groups are
 * deliberately missing here for the same reason they are missing there.
 */
function PropertyFilterEditor({
  properties,
  conditions,
  onChange,
}: {
  properties: readonly DatabaseProperty[];
  conditions: readonly DatabaseFilterCondition[];
  onChange: (next: readonly DatabaseFilterCondition[]) => void;
}) {
  if (properties.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Diese Datenbank hat noch keine Eigenschaften, nach denen sich filtern ließe.
      </p>
    );
  }

  const nameOf = (propertyId: string): string =>
    properties.find((property) => property.id === propertyId)?.name ?? '?';

  return (
    <div className="grid gap-1.5">
      <Label>Eigenschaften</Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {conditions.map((condition, index) => (
          <Badge key={`${condition.propertyId}-${index}`} variant="secondary" className="gap-1">
            {nameOf(condition.propertyId)} {FILTER_OPERATOR_LABELS[condition.operator]}
            {condition.value === undefined
              ? ''
              : ` ${filterValueLabel(
                  properties.find((property) => property.id === condition.propertyId),
                  condition.value,
                )}`}
            <button
              type="button"
              aria-label="Filter entfernen"
              onClick={() => onChange(conditions.filter((_, entry) => entry !== index))}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        <AddConditionPopover
          properties={properties}
          onAdd={(condition) => onChange([...conditions, condition])}
        />
      </div>
    </div>
  );
}

function AddConditionPopover({
  properties,
  onAdd,
}: {
  properties: readonly DatabaseProperty[];
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
  const choices = filterValueChoices(property);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" data-testid="saved-query-add-filter">
            <FilterIcon /> Eigenschaft
          </Button>
        }
      />
      <PopoverContent className="grid w-72 gap-2">
        <Select
          value={propertyId}
          onValueChange={(next) => {
            const chosen = next ?? propertyId;
            setPropertyId(chosen);
            const chosenProperty = properties.find((entry) => entry.id === chosen);
            const available =
              chosenProperty === undefined ? [] : operatorsForType(chosenProperty.type);
            setOperator(available[0] ?? 'equals');
            setValue(
              chosenProperty === undefined
                ? ''
                : (filterValueChoices(chosenProperty)[0]?.value ?? ''),
            );
          }}
        >
          <SelectTrigger>
            <SelectValue>{() => property.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {properties.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={operator}
          onValueChange={(next) => setOperator((next ?? 'equals') as DatabaseFilterOperator)}
        >
          <SelectTrigger>
            <SelectValue>{() => FILTER_OPERATOR_LABELS[operator]}</SelectValue>
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
          choices.length > 0 ? (
            <Select value={value} onValueChange={(next) => setValue(next ?? '')}>
              <SelectTrigger>
                <SelectValue>
                  {() => choices.find((choice) => choice.value === value)?.label ?? 'Wert'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={value}
              placeholder="Wert"
              onChange={(event) => setValue(event.target.value)}
            />
          )
        ) : null}

        <Button
          size="sm"
          data-testid="saved-query-add-filter-submit"
          onClick={() => {
            onAdd({
              propertyId,
              operator,
              ...(needsValue ? { value } : {}),
            });
            setOpen(false);
          }}
        >
          Hinzufügen
        </Button>
      </PopoverContent>
    </Popover>
  );
}
