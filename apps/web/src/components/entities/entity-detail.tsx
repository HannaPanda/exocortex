'use client';

import Link from 'next/link';
import * as React from 'react';

import {
  ENTITY_TYPE_LABELS,
  type EntityMention,
  type EntityProfile,
  type EntityType,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useEntityProfile, useUnlinkEntityPage, useUpdateEntity } from '@/lib/api/entity-queries';

import { EntityLinkPage } from './entity-link-page';

/**
 * What is known about one entity (issue #47).
 *
 * The three layers are in the order the profile answers them: facts the memory
 * holds to be true (issue #46), what it is connected to, then the pages to
 * read. Without the first layer this is a link list; with it, it is a
 * statement.
 *
 * `exo_entity_profile` returns the same thing as one block of German prose for
 * a prompt. This is that answer laid out for a reader, with the two edits the
 * profile makes possible: the type and the aliases, which is what decides what
 * attaches itself next.
 */
export function EntityDetail({ entityId }: { entityId: string }) {
  const profile = useEntityProfile(entityId);
  if (profile.data === undefined) return <LoadingState label="Profil wird geladen …" />;
  return <Profile key={entityId} profile={profile.data} />;
}

function Profile({ profile }: { profile: EntityProfile }) {
  const { entity } = profile;
  const update = useUpdateEntity();
  const [aliases, setAliases] = React.useState(entity.aliases.join(', '));

  const saveAliases = (): void => {
    const next = aliases
      .split(',')
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 1);
    if (next.join('|') === entity.aliases.join('|')) return;
    update.mutate({ entityId: entity.id, request: { aliases: next } });
  };

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold" data-testid="entity-detail-title">
          {entity.title}
        </h2>
        <Link
          href={`/arbeitsbereich/${entity.workspaceId}/seite/${entity.id}`}
          className="text-xs underline"
        >
          Seite öffnen
        </Link>
      </div>

      {profile.summary.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">{profile.summary}</p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`type-${entity.id}`}>Typ</Label>
          <Select
            value={entity.type}
            onValueChange={(next) =>
              update.mutate({ entityId: entity.id, request: { type: next as EntityType } })
            }
          >
            <SelectTrigger id={`type-${entity.id}`} className="w-40" data-testid="entity-set-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {ENTITY_TYPE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor={`aliases-${entity.id}`}>Aliasse</Label>
          <Input
            id={`aliases-${entity.id}`}
            value={aliases}
            data-testid="entity-set-aliases"
            onChange={(event) => setAliases(event.target.value)}
            onBlur={saveAliases}
          />
        </div>
      </div>
      {update.data?.rescanQueued === true ? (
        <p className="text-xs text-muted-foreground">
          Die Seiten werden neu durchsucht; neue Treffer erscheinen in ein paar Minuten.
        </p>
      ) : null}

      <Facts facts={profile.facts} />
      <Relations relations={profile.relations} />
      <Mentions entityId={entity.id} mentions={profile.mentions} hidden={profile.hiddenMentions} />
      <EntityLinkPage entityId={entity.id} />
    </div>
  );
}

function Facts({ facts }: { facts: EntityProfile['facts'] }) {
  if (facts.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">Fakten</h3>
      <ul className="flex flex-col gap-1" data-testid="entity-facts">
        {facts.map((fact) => (
          <li key={fact.id} className="text-sm">
            {fact.statement}
            <span className="ms-2 text-xs text-muted-foreground">
              {fact.confirmations === 1
                ? '1 Bestätigung'
                : `${String(fact.confirmations)} Bestätigungen`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Relations({ relations }: { relations: EntityProfile['relations'] }) {
  if (relations.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">Verbindungen</h3>
      <ul className="flex flex-wrap gap-1" data-testid="entity-relations">
        {relations.map((relation) => (
          <li key={`${relation.id}-${relation.direction}`}>
            <Badge variant="outline">
              {relation.direction === 'outgoing' ? '→ ' : '← '}
              {relation.title}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The pages that talk about it.
 *
 * An extracted mention comes back on the next pass, so removing one is only
 * worth offering for the edges a person or an agent drew by hand -- an
 * extracted one would reappear and look like the click did nothing.
 */
function Mentions({
  entityId,
  mentions,
  hidden,
}: {
  entityId: string;
  mentions: readonly EntityMention[];
  hidden: number;
}) {
  const unlink = useUnlinkEntityPage();

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">Seiten</h3>
      {mentions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Noch keine Seite nennt diesen Namen.</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="entity-mentions">
          {mentions.map((mention) => (
            <li
              key={mention.documentId}
              className="flex flex-wrap items-baseline gap-2 rounded-sm px-1 py-1 hover:bg-accent"
            >
              <Link
                href={`/arbeitsbereich/${mention.workspaceId}/seite/${mention.documentId}`}
                className="text-sm underline-offset-2 hover:underline"
              >
                {mention.title}
              </Link>
              <span className="text-xs text-muted-foreground">
                {mention.workspaceName} · „{mention.alias}“
                {mention.occurrences > 1 ? ` · ${String(mention.occurrences)}×` : ''}
              </span>
              {mention.source === 'manual' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate({ entityId, documentId: mention.documentId })}
                  data-testid="entity-unlink"
                >
                  Verknüpfung lösen
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {hidden === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {hidden === 1
            ? 'Eine weitere Seite in einem Arbeitsbereich, den du nicht sehen kannst.'
            : `${String(hidden)} weitere Seiten in Arbeitsbereichen, die du nicht sehen kannst.`}
        </p>
      )}
    </section>
  );
}
