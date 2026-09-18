'use client';

import { CheckIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  type Feature,
  FEATURE_AREA_LABELS,
  FEATURE_AREAS,
  type FeatureArea,
} from '@exocortex/contracts';
import { AppPage, Badge, Button, EmptyState, Input, LoadingState } from '@exocortex/ui';

import { useFeatures, useMarkFeaturesSeen } from '@/lib/api/feature-queries';

/**
 * What eXocortex can do, in a person's words (issue #80, ADR-040).
 *
 * The problem this page exists for is not that the system is undocumented. It
 * is that it grew faster than anybody's memory of it: a feature gets built,
 * used twice and forgotten, and a year later somebody does by hand what a
 * screen already does. So the list is searchable, and everything newer than
 * the reader's marker is called out, because "what happened since I last
 * looked" is the question people actually have.
 *
 * The prose comes from `packages/features`, which a hard gate keeps complete.
 */

function matches(feature: Feature, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [
    feature.title,
    feature.summary,
    feature.access.ui?.where ?? '',
    ...feature.access.shortcuts,
    ...feature.access.tools,
    ...feature.access.settings,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function AccessLine({ feature }: { feature: Feature }) {
  const parts: React.ReactNode[] = [];
  if (feature.access.ui !== null) {
    const { where, path } = feature.access.ui;
    parts.push(
      path === null ? (
        <span key="ui">{where}</span>
      ) : (
        <Link key="ui" href={path} className="underline underline-offset-2 hover:text-foreground">
          {where}
        </Link>
      ),
    );
  }
  for (const shortcut of feature.access.shortcuts) {
    parts.push(
      <kbd key={shortcut} className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">
        {shortcut}
      </kbd>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {parts}
    </div>
  );
}

function TechnicalLine({ feature }: { feature: Feature }) {
  const rows: { label: string; values: readonly string[] }[] = [
    { label: 'Für Agenten', values: feature.access.tools },
    { label: 'Einstellungen', values: feature.access.settings },
  ].filter((row) => row.values.length > 0);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap gap-x-2 gap-y-1">
          <dt className="font-medium">{row.label}:</dt>
          <dd className="font-mono">{row.values.join(', ')}</dd>
        </div>
      ))}
    </dl>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article id={feature.id} className="scroll-mt-20 border-b border-border py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-medium">{feature.title}</h3>
        {feature.isNew ? <Badge variant="default">Neu</Badge> : null}
        <span className="text-xs text-muted-foreground">seit {feature.since}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{feature.summary}</p>
      <AccessLine feature={feature} />
      <TechnicalLine feature={feature} />
    </article>
  );
}

export function HelpPage() {
  const [search, setSearch] = React.useState('');
  const [onlyNew, setOnlyNew] = React.useState(false);
  const features = useFeatures();
  const markSeen = useMarkFeaturesSeen();

  const needle = search.trim().toLowerCase();
  const all = features.data?.features ?? [];
  const shown = all.filter((feature) => matches(feature, needle) && (!onlyNew || feature.isNew));
  const newCount = features.data?.newCount ?? 0;

  const byArea = new Map<FeatureArea, Feature[]>();
  for (const feature of shown) {
    const bucket = byArea.get(feature.area);
    if (bucket === undefined) byArea.set(feature.area, [feature]);
    else bucket.push(feature);
  }

  return (
    <AppPage maxWidth="max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Funktionen</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Was diese Installation kann, in ganzen Sätzen. Die Liste wird beim Bauen erzwungen: eine
          neue Fähigkeit kommt nicht durch, ohne hier beschrieben zu sein.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Suchen, zum Beispiel nach PDF oder Kalender"
          aria-label="Funktionen durchsuchen"
          data-testid="feature-search"
          className="max-w-sm flex-1"
        />
        {newCount > 0 ? (
          <>
            <Button
              variant={onlyNew ? 'default' : 'outline'}
              size="sm"
              onClick={() => setOnlyNew((value) => !value)}
              data-testid="feature-filter-new"
            >
              <SparklesIcon />
              Neu für dich ({newCount})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markSeen.mutate()}
              disabled={markSeen.isPending}
              data-testid="feature-mark-seen"
            >
              <CheckIcon />
              Zur Kenntnis genommen
            </Button>
          </>
        ) : null}
      </div>

      {features.isPending ? <LoadingState label="Funktionen werden geladen …" /> : null}

      {!features.isPending && shown.length === 0 ? (
        <EmptyState
          title="Nichts gefunden"
          description={
            onlyNew
              ? 'Seit deinem letzten Besuch ist nichts dazugekommen.'
              : 'Kein Eintrag passt zu dieser Suche.'
          }
        />
      ) : null}

      <div className="mt-6 space-y-8">
        {FEATURE_AREAS.filter((area) => byArea.has(area)).map((area) => (
          <section key={area}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {FEATURE_AREA_LABELS[area]}
            </h2>
            <div className="mt-2">
              {(byArea.get(area) ?? []).map((feature) => (
                <FeatureCard key={feature.id} feature={feature} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppPage>
  );
}
