'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EntitySummary, type EntityType } from '@exocortex/contracts';
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
import { ENTITY_TYPES, useEntityTypeLabel } from './entity-type-label';

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
  const t = useTranslations('entities.page');
  const typeLabel = useEntityTypeLabel();

  const entities = useEntities({ q: query, type });

  if (entities.isPending) return <LoadingState label={t('loading')} />;

  const databaseId = entities.data?.databaseId ?? null;
  const rows = entities.data?.entities ?? [];

  return (
    <AppPage maxWidth="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <Button onClick={() => setCreating(true)} data-testid="entity-new">
          {t('create')}
        </Button>
      </div>

      {databaseId === null ? <EntityDatabaseSetup /> : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          placeholder={t('searchPlaceholder')}
          className="max-w-xs"
          data-testid="entity-search"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          value={type ?? 'all'}
          onValueChange={(next) => setType(next === 'all' ? null : (next as EntityType))}
        >
          <SelectTrigger className="w-44" data-testid="entity-type-filter">
            <SelectValue>{() => (type === null ? t('allTypes') : typeLabel(type))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('allTypes')}</SelectItem>
            {ENTITY_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {typeLabel(value)}
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
              title={t('nothingSelectedTitle')}
              description={t('nothingSelectedDescription')}
            />
          ) : (
            <EntityDetail entityId={selected} />
          )}
        </div>
      </div>

      <section className="mt-10 border-t border-border pt-8">
        <h2 className="text-base font-semibold">{t('candidatesTitle')}</h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('candidatesIntro')}</p>
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
  const t = useTranslations('entities.page');
  const typeLabel = useEntityTypeLabel();

  if (rows.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
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
            <Badge variant="secondary">{typeLabel(entity.type)}</Badge>
            {entity.aliases.length === 0 ? null : (
              <span className="text-xs text-muted-foreground">
                {t('aliases', { aliases: entity.aliases.join(', ') })}
              </span>
            )}
            <span className="ms-auto text-xs text-muted-foreground">
              {t('mentionCount', { count: entity.mentionCount })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
