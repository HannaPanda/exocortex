'use client';

import {
  ExternalLinkIcon,
  FilePlusIcon,
  PencilIcon,
  SearchIcon,
  SkipForwardIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type SearchResponse } from '@exocortex/contracts';
import { Button, cn, Input } from '@exocortex/ui';

import { apiRequest } from '@/lib/api/client';
import { documentHref } from '@/lib/document-href';
import { useRelativeTime } from '@/lib/relative-time';

import { type MapNode, type PulseKind } from './map-model';
import { MAP_PANEL } from './map-overlays';
import { type MapActivity } from './use-map-live';

/** How many hits a tour visits, and how long it stays at each. */
export const TOUR_STOPS = 6;
const TOUR_DWELL_MS = 3_200;

export interface MapTour {
  query: string;
  stops: string[];
  index: number;
}

/**
 * "Frag die Karte": the workspace's ordinary search, answered by flying to the
 * hits one after another (issue #189). The same hybrid search as `Strg + K`,
 * so the words and the meaning both count; the map only changes how the
 * answer is shown.
 */
export function MapAsk({
  workspaceId,
  tour,
  titleOf,
  onResults,
  onAdvance,
  onStop,
}: {
  workspaceId: string;
  tour: MapTour | null;
  titleOf: (id: string) => string | null;
  onResults: (query: string, hitIds: string[]) => boolean;
  onAdvance: () => void;
  onStop: () => void;
}) {
  const t = useTranslations('knowledgeMap.ask');
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'searching' | 'empty' | 'failed'>('idle');
  const [asked, setAsked] = React.useState('');

  const advance = React.useRef(onAdvance);
  React.useEffect(() => {
    advance.current = onAdvance;
  }, [onAdvance]);
  React.useEffect(() => {
    if (tour === null || tour.index >= tour.stops.length - 1) return;
    const timer = setTimeout(() => advance.current(), TOUR_DWELL_MS);
    return () => clearTimeout(timer);
  }, [tour]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setState('searching');
    setAsked(trimmed);
    try {
      const result = await apiRequest<SearchResponse>(
        `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(trimmed)}&limit=20`,
      );
      const found = onResults(
        trimmed,
        result.results.map((hit) => hit.documentId),
      );
      setState(found ? 'idle' : 'empty');
    } catch {
      setState('failed');
    }
  };

  const current = tour === null ? null : tour.stops[tour.index];

  return (
    <div className={cn(MAP_PANEL, 'pointer-events-auto w-full max-w-sm p-2')}>
      <form
        role="search"
        aria-label={t('label')}
        onSubmit={(event) => void submit(event)}
        className="flex gap-1"
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
          className="h-8 text-sm"
          data-testid="map-ask-input"
        />
        <Button
          type="submit"
          variant="outline"
          size="icon-sm"
          aria-label={t('submit')}
          title={t('submit')}
          disabled={state === 'searching'}
        >
          <SearchIcon />
        </Button>
      </form>
      <div aria-live="polite" className="text-xs text-muted-foreground">
        {state === 'searching' ? <p className="mt-1.5 px-1">{t('searching')}</p> : null}
        {state === 'empty' ? <p className="mt-1.5 px-1">{t('noHits', { query: asked })}</p> : null}
        {state === 'failed' ? (
          <p className="mt-1.5 px-1 text-destructive-text">{t('failed')}</p>
        ) : null}
        {tour !== null && current !== undefined && current !== null ? (
          <div className="mt-1.5 flex items-center gap-1 px-1">
            <p className="min-w-0 flex-1 truncate">
              <span className="exocortex-numeric">
                {t('station', { current: tour.index + 1, total: tour.stops.length })}
              </span>
              {': '}
              <span className="text-foreground">{titleOf(current) ?? ''}</span>
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('next')}
              title={t('next')}
              disabled={tour.index >= tour.stops.length - 1}
              onClick={onAdvance}
            >
              <SkipForwardIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('stop')}
              title={t('stop')}
              onClick={onStop}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function kindLabelKey(node: MapNode): 'kindEntity' | 'kindCollection' | 'kindProject' | 'kindPage' {
  if (node.kind === 'entity') return 'kindEntity';
  if (node.type === 'COLLECTION') return 'kindCollection';
  if (node.type === 'PROJECT') return 'kindProject';
  return 'kindPage';
}

/** What is known about the selected point, and the way into it. */
export function MapNodeCard({
  workspaceId,
  node,
  onClose,
}: {
  workspaceId: string;
  node: MapNode;
  onClose: () => void;
}) {
  const t = useTranslations('knowledgeMap.node');
  const relative = useRelativeTime();
  return (
    <section
      aria-label={node.title}
      className={cn(MAP_PANEL, 'pointer-events-auto w-full max-w-sm p-3')}
      data-testid="map-node-card"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-nano font-medium tracking-wide text-muted-foreground uppercase">
            {t(kindLabelKey(node))}
          </p>
          <h2 className="truncate text-sm font-semibold" title={node.title}>
            {node.title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('close')}
          title={t('close')}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <dl className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
        <dd className="exocortex-numeric">{t('connections', { count: node.degree })}</dd>
        <dd>{t('created', { when: relative(node.createdAt) })}</dd>
        <dd>{t('edited', { when: relative(node.editedAt) })}</dd>
      </dl>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        render={<Link href={documentHref(workspaceId, node.id, node.type)} />}
      >
        <ExternalLinkIcon />
        {t('open')}
      </Button>
    </section>
  );
}

const ACTIVITY_ICON: Record<PulseKind, React.ComponentType<{ className?: string }>> = {
  read: SparklesIcon,
  write: PencilIcon,
  created: FilePlusIcon,
  removed: Trash2Icon,
};

/** Colour carries the kind on the canvas; here the icon and the verb do (Never-Only-Colour). */
const ACTIVITY_TONE: Record<PulseKind, string> = {
  read: 'text-info',
  write: 'text-primary-text',
  created: 'text-success',
  removed: 'text-destructive-text',
};

/** What a run or an agent is doing, in words, beside the light that shows it. */
export function MapActivityFeed({
  feed,
  titleOf,
}: {
  feed: readonly MapActivity[];
  titleOf: (id: string) => string | null;
}) {
  const t = useTranslations('knowledgeMap.activity');
  return (
    <section
      aria-label={t('title')}
      className={cn(MAP_PANEL, 'pointer-events-auto w-64 p-2')}
      data-testid="map-activity"
    >
      <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            feed.length > 0 ? 'bg-primary' : 'bg-muted-foreground',
          )}
        />
        {t('title')}
      </h2>
      {feed.length === 0 ? (
        <p className="mt-1 px-1 text-xs text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol aria-live="polite" className="mt-1 flex flex-col gap-0.5">
          {feed.map((entry) => {
            const Icon = ACTIVITY_ICON[entry.kind];
            const title = titleOf(entry.documentId) ?? t('unknownPage');
            return (
              <li key={entry.id} className="flex items-center gap-1.5 px-1 text-xs">
                <Icon className={cn('size-3.5 shrink-0', ACTIVITY_TONE[entry.kind])} />
                <span className="min-w-0 truncate">{t(entry.kind, { title })}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
