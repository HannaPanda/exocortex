'use client';

import { CheckIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type Feature, FEATURE_AREAS, type FeatureArea } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  Input,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exocortex/ui';

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
 * It started as one flat column of one-line teasers, which answered "does this
 * exist" and nothing else: you could tell that page templates are a thing, but
 * not how to make one or what the copy keeps. Two things changed. The prose in
 * `packages/features` carries paragraphs now, and they are shown in full; and
 * the fourteen areas became a side navigation, so a reader meets one area at a
 * time instead of sixty entries at once.
 *
 * The search still spans every area, because somebody looking for "PDF" does
 * not know which drawer it is in. When it matches nothing in the open area,
 * the page falls back to "Alle Funktionen" rather than jumping to whichever
 * area happens to match first -- a tab that moves under you while you type is
 * worse than a list that grew.
 */

/** The side navigation's first entry: every area at once, in one column. */
const ALL = 'alle';

type Selection = FeatureArea | typeof ALL;

function matches(feature: Feature, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [
    feature.title,
    feature.summary,
    ...feature.details,
    feature.access.ui?.where ?? '',
    ...feature.access.shortcuts,
    ...feature.access.tools,
    ...feature.access.settings,
    ...feature.references,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * The doors into a feature, as a definition list.
 *
 * One box rather than three loose lines, because on a page where every entry
 * now carries three paragraphs, the facts a reader scans for (where is it,
 * which key, which tool) have to be findable without reading the prose again.
 */
function AccessBox({ feature }: { feature: Feature }) {
  const t = useTranslations('help.access');
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (feature.access.ui !== null) {
    const { where, path } = feature.access.ui;
    rows.push({
      label: t('where'),
      value:
        path === null ? (
          where
        ) : (
          <>
            {where}{' '}
            <Link href={path} className="underline underline-offset-2 hover:text-foreground">
              {t('open')}
            </Link>
          </>
        ),
    });
  }

  if (feature.access.shortcuts.length > 0) {
    rows.push({
      label: t('shortcuts'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          {feature.access.shortcuts.map((shortcut) => (
            <kbd
              key={shortcut}
              className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs"
            >
              {shortcut}
            </kbd>
          ))}
        </span>
      ),
    });
  }

  for (const [label, values] of [
    [t('tools'), feature.access.tools],
    [t('settings'), feature.access.settings],
    [t('references'), feature.references],
  ] as const) {
    if (values.length > 0)
      rows.push({ label, value: <span className="font-mono">{values.join(', ')}</span> });
  }

  if (rows.length === 0) return null;
  return (
    <dl className="mt-4 grid gap-x-4 gap-y-1.5 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground sm:grid-cols-[8rem_1fr]">
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt className="font-medium text-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function FeatureArticle({ feature }: { feature: Feature }) {
  const t = useTranslations('help.entry');
  return (
    <article
      id={feature.id}
      data-testid="feature-entry"
      className="scroll-mt-24 border-t border-border pt-8 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold">{feature.title}</h3>
        {feature.isNew ? <Badge variant="default">{t('new')}</Badge> : null}
        <span className="text-xs text-muted-foreground">{t('since', { date: feature.since })}</span>
      </div>
      <p className="mt-2 text-sm font-medium">{feature.summary}</p>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
        {feature.details.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <AccessBox feature={feature} />
    </article>
  );
}

function AreaSection({ area, features }: { area: FeatureArea; features: Feature[] }) {
  const t = useTranslations('help.areas');
  return (
    <section className="scroll-mt-24">
      <h2 className="text-lg font-semibold">{t(`${area}.label`)}</h2>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t(`${area}.description`)}</p>
      <div className="mt-6 space-y-8">
        {features.map((feature) => (
          <FeatureArticle key={feature.id} feature={feature} />
        ))}
      </div>
    </section>
  );
}

/** Area label plus how many entries are visible in it under the current filter. */
function NavLabel({ area, count }: { area: Selection; count: number }) {
  const areaLabel = useAreaLabel();
  return (
    <>
      <span>{areaLabel(area)}</span>
      <span className="shrink-0 text-xs tabular-nums opacity-60">{count}</span>
    </>
  );
}

/** The name of an area in the side navigation, or of the whole list. */
function useAreaLabel(): (area: Selection) => string {
  const t = useTranslations('help');
  return React.useCallback(
    (area: Selection) => (area === ALL ? t('page.allAreas') : t(`areas.${area}.label`)),
    [t],
  );
}

export function HelpPage() {
  const t = useTranslations('help.page');
  const areaLabel = useAreaLabel();
  const [search, setSearch] = React.useState('');
  const [onlyNew, setOnlyNew] = React.useState(false);
  const [selected, setSelected] = React.useState<Selection>('hilfe');
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
  const areas = FEATURE_AREAS.filter((area) => byArea.has(area));

  // Derived rather than stored: a filter that empties the open area falls back
  // to the whole list, and the reader's choice comes back untouched as soon as
  // it has entries again.
  const active: Selection =
    selected === ALL || byArea.has(selected) ? selected : shown.length > 0 ? ALL : selected;
  const countOf = (area: Selection) =>
    area === ALL ? shown.length : (byArea.get(area)?.length ?? 0);

  return (
    <AppPage maxWidth="max-w-5xl">
      <div>
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
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
              {t('onlyNew', { count: newCount })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markSeen.mutate()}
              disabled={markSeen.isPending}
              data-testid="feature-mark-seen"
            >
              <CheckIcon />
              {t('markSeen')}
            </Button>
          </>
        ) : null}
      </div>

      {features.isPending ? <LoadingState label={t('loading')} /> : null}

      {!features.isPending && shown.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          description={onlyNew ? t('emptyNew') : t('emptySearch')}
        />
      ) : null}

      {shown.length === 0 ? null : (
        <Tabs
          value={active}
          onValueChange={(value) => setSelected(value as Selection)}
          orientation="vertical"
          className="mt-8 flex flex-col gap-6 md:flex-row md:items-start md:gap-10"
        >
          {/* The mobile door into the same selection: fourteen rows above the
              content would push the content off a phone screen entirely. */}
          <Select value={active} onValueChange={(value) => setSelected(value as Selection)}>
            <SelectTrigger className="w-full md:hidden" data-testid="feature-area-select">
              <SelectValue>{() => areaLabel(active)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {([ALL, ...areas] as Selection[]).map((area) => (
                <SelectItem key={area} value={area}>
                  {t('areaWithCount', { area: areaLabel(area), count: countOf(area) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="hidden md:sticky md:top-6 md:block md:w-60 md:shrink-0">
            <TabsList data-testid="feature-areas">
              {([ALL, ...areas] as Selection[]).map((area) => (
                <TabsTrigger key={area} value={area} data-testid={`feature-area-${area}`}>
                  <NavLabel area={area} count={countOf(area)} />
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="min-w-0 flex-1">
            <TabsContent value={ALL} className="space-y-12">
              {areas.map((area) => (
                <AreaSection key={area} area={area} features={byArea.get(area) ?? []} />
              ))}
            </TabsContent>
            {areas.map((area) => (
              <TabsContent key={area} value={area}>
                <AreaSection area={area} features={byArea.get(area) ?? []} />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      )}
    </AppPage>
  );
}
