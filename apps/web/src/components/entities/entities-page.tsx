'use client';

import * as React from 'react';

import { ENTITY_TYPE_LABELS, type EntitySummary, type EntityType } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  cn,
  EmptyState,
  Input,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useEntities } from '@/lib/api/entity-queries';

import { EntityCandidates } from './entity-candidates';
import { EntityDatabaseSetup } from './entity-database-setup';
import { EntityDetail } from './entity-detail';
import { EntityDialog } from './entity-dialog';

/**
 * Who and what this deployment knows about (issue #47).
 *
 * The entity layer shipped with nine tools and no screen: an agent could list
 * entities, read a profile, confirm a candidate and draw an edge by hand, and a
 * person could do none of it. Confirming candidates is the half that hurt most
 * -- the extraction pass proposes names all by itself, and every one of them
 * waited for somebody to run a tool.
 *
 * An entity *is* a row of the entity database, so everything here has a second
 * way in through the ordinary database screen. What that screen cannot show is
 * the profile: the facts, the relations and the mentions are gathered across
 * every workspace the reader may see, and no table has that shape.
 */
export function EntitiesPage() {
  const [query, setQuery] = React.useState('');
  const [type, setType] = React.useState<EntityType | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const entities = useEntities({ q: query, type });

  if (entities.isPending) return <LoadingState label="Entitäten werden geladen …" />;

  const databaseId = entities.data?.databaseId ?? null;
  const rows = entities.data?.entities ?? [];

  return (
    <AppPage maxWidth="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Entitäten</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Personen, Hosts, Dienste und Projekte, die in deinen Seiten vorkommen, und was über sie
            bekannt ist.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} data-testid="entity-new">
          Neue Entität
        </Button>
      </div>

      {databaseId === null ? <EntityDatabaseSetup /> : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          placeholder="Name oder Alias"
          className="max-w-xs"
          data-testid="entity-search"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          value={type ?? 'all'}
          onValueChange={(next) => setType(next === 'all' ? null : (next as EntityType))}
        >
          <SelectTrigger className="w-44" data-testid="entity-type-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Typen</SelectItem>
            {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((value) => (
              <SelectItem key={value} value={value}>
                {ENTITY_TYPE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <EntityList rows={rows} selected={selected} onSelect={setSelected} />
        <div>
          {selected === null ? (
            <EmptyState
              title="Nichts ausgewählt"
              description="Links eine Entität anklicken, um Fakten, Verbindungen und Seiten zu sehen."
            />
          ) : (
            <EntityDetail entityId={selected} />
          )}
        </div>
      </div>

      <section className="mt-10 border-t border-border pt-8">
        <h2 className="text-base font-semibold">Vorschläge</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Namen, die auf mehreren Seiten auftauchen und zu denen es noch keine Entität gibt.
        </p>
        <div className="mt-4">
          <EntityCandidates />
        </div>
      </section>

      <EntityDialog open={creating} onOpenChange={setCreating} />
    </AppPage>
  );
}

function EntityList({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly EntitySummary[];
  selected: string | null;
  onSelect: (entityId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Keine Entitäten"
        description="Entweder ist noch keine angelegt, oder der Filter passt auf keine."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="entity-list">
      {rows.map((entity) => (
        <li key={entity.id}>
          <button
            type="button"
            onClick={() => onSelect(entity.id)}
            aria-current={entity.id === selected ? 'true' : undefined}
            data-testid="entity-row"
            className={cn(
              'flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-start',
              entity.id === selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent',
            )}
          >
            <span className="text-sm font-medium">{entity.title}</span>
            <Badge variant="secondary">{ENTITY_TYPE_LABELS[entity.type]}</Badge>
            {entity.aliases.length === 0 ? null : (
              <span className="text-xs text-muted-foreground">
                auch: {entity.aliases.join(', ')}
              </span>
            )}
            <span className="ms-auto text-xs text-muted-foreground">
              {entity.mentionCount === 1 ? '1 Seite' : `${String(entity.mentionCount)} Seiten`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
