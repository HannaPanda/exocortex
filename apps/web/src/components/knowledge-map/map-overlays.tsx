'use client';

import { PaletteIcon, PauseIcon, PlayIcon, ScanIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type KnowledgeMapEdgeKind, type KnowledgeMapSemanticState } from '@exocortex/contracts';
import { Button, cn, Label, Slider, Switch, Toggle } from '@exocortex/ui';

/**
 * The quiet furniture around the map (issue #189): the title, the legend that
 * is also the filter, and the timeline. Panels on `surface` like every other
 * panel; the movement belongs to the canvas, never to these.
 */
export const MAP_PANEL = 'rounded-lg border border-border bg-surface/90 shadow-md';

export function MapHeader({
  pages,
  lines,
  semantic,
  onFit,
  appearanceOpen,
  onAppearance,
}: {
  pages: number;
  lines: number;
  semantic: KnowledgeMapSemanticState;
  onFit: () => void;
  appearanceOpen: boolean;
  onAppearance: () => void;
}) {
  const t = useTranslations('knowledgeMap.screen');
  return (
    <div className={cn(MAP_PANEL, 'pointer-events-auto max-w-xs px-3 py-2')}>
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold">{t('title')}</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('fit')}
          title={t('fit')}
          onClick={onFit}
        >
          <ScanIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('appearance')}
          aria-pressed={appearanceOpen}
          title={t('appearance')}
          onClick={onAppearance}
          data-testid="map-appearance-toggle"
        >
          <PaletteIcon />
        </Button>
      </div>
      <p className="exocortex-numeric text-xs text-muted-foreground">
        {t('stats', { pages, lines })}
      </p>
      {semantic !== 'ok' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {semantic === 'partial' ? t('semanticPartial') : t('semanticDisabled')}
        </p>
      ) : null}
    </div>
  );
}

/** The swatch of a line kind. Token classes only, so the legend follows the palette. */
const KIND_SWATCH: Record<KnowledgeMapEdgeKind, string> = {
  link: 'bg-foreground',
  similar: 'bg-content-purple',
  entity: 'bg-warning',
  tree: 'bg-muted-foreground',
};

const KINDS: readonly KnowledgeMapEdgeKind[] = ['link', 'similar', 'entity', 'tree'];

export function MapLegend({
  shown,
  onToggleKind,
  calm,
  onCalmChange,
  follow,
  onFollowChange,
}: {
  shown: ReadonlySet<KnowledgeMapEdgeKind>;
  onToggleKind: (kind: KnowledgeMapEdgeKind) => void;
  calm: boolean;
  onCalmChange: (calm: boolean) => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const t = useTranslations('knowledgeMap.legend');
  const calmId = React.useId();
  const followId = React.useId();
  return (
    <section
      aria-label={t('title')}
      className={cn(MAP_PANEL, 'pointer-events-auto flex w-56 flex-col gap-2 p-2')}
    >
      <h2 className="px-1 text-xs font-medium text-muted-foreground">{t('title')}</h2>
      <div className="flex flex-col gap-0.5">
        {KINDS.map((kind) => (
          <Toggle
            key={kind}
            size="sm"
            pressed={shown.has(kind)}
            onPressedChange={() => onToggleKind(kind)}
            className="justify-start gap-2 text-xs"
            data-testid={`map-kind-${kind}`}
          >
            <span
              aria-hidden
              className={cn(
                'h-0.5 w-4 rounded-full',
                KIND_SWATCH[kind],
                !shown.has(kind) && 'opacity-30',
              )}
            />
            {t(kind)}
          </Toggle>
        ))}
      </div>
      <p className="px-1 text-nano text-muted-foreground">{t('shapes')}</p>
      <div className="flex flex-col gap-1.5 border-t border-border px-1 pt-2">
        <div className="flex items-center justify-between gap-2" title={t('calmHint')}>
          <Label htmlFor={calmId} className="text-xs">
            {t('calm')}
          </Label>
          <Switch id={calmId} size="sm" checked={calm} onCheckedChange={onCalmChange} />
        </div>
        <div className="flex items-center justify-between gap-2" title={t('followHint')}>
          <Label htmlFor={followId} className="text-xs">
            {t('follow')}
          </Label>
          <Switch id={followId} size="sm" checked={follow} onCheckedChange={onFollowChange} />
        </div>
      </div>
    </section>
  );
}

/** Steps of the timeline slider; fine enough that a day is a step for a year of pages. */
const TIMELINE_STEPS = 1000;
/** How long playing the whole history takes. */
const PLAY_MS = 14_000;

export function MapTimeline({
  bounds,
  moment,
  onMomentChange,
  reducedMotion,
}: {
  bounds: [number, number];
  /** `null` is now. */
  moment: number | null;
  onMomentChange: (moment: number | null) => void;
  reducedMotion: boolean;
}) {
  const t = useTranslations('knowledgeMap.timeline');
  const format = useFormatter();
  const [playing, setPlaying] = React.useState(false);
  const [first, last] = bounds;
  const span = Math.max(1, last - first);
  const value =
    moment === null ? TIMELINE_STEPS : Math.round(((moment - first) / span) * TIMELINE_STEPS);

  const latest = React.useRef(onMomentChange);
  React.useEffect(() => {
    latest.current = onMomentChange;
  }, [onMomentChange]);

  React.useEffect(() => {
    if (!playing) return;
    // Reduced motion still gets the history, in eight steps instead of a sweep.
    const start = performance.now();
    let frame = 0;
    let lastStep = -1;
    const tick = (): void => {
      const progress = Math.min(1, (performance.now() - start) / PLAY_MS);
      const step = reducedMotion ? Math.floor(progress * 8) / 8 : progress;
      if (step !== lastStep) {
        lastStep = step;
        latest.current(progress >= 1 ? null : first + step * span);
      }
      if (progress >= 1) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, first, span, reducedMotion]);

  const label =
    moment === null ? t('nowLabel') : format.dateTime(new Date(moment), { dateStyle: 'medium' });

  return (
    <section
      aria-label={t('label')}
      className={cn(
        MAP_PANEL,
        'pointer-events-auto flex w-full max-w-xl items-center gap-3 px-3 py-2',
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={playing ? t('pause') : t('play')}
        title={playing ? t('pause') : t('play')}
        onClick={() => setPlaying((current) => !current)}
        data-testid="map-timeline-play"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Slider
        min={0}
        max={TIMELINE_STEPS}
        value={value}
        thumbLabel={t('thumb')}
        onValueChange={(next) => {
          setPlaying(false);
          const step = Array.isArray(next) ? (next[0] ?? TIMELINE_STEPS) : next;
          onMomentChange(step >= TIMELINE_STEPS ? null : first + (step / TIMELINE_STEPS) * span);
        }}
        className="flex-1"
      />
      <span className="exocortex-numeric w-24 shrink-0 text-right text-xs text-muted-foreground">
        {label}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={moment === null}
        onClick={() => {
          setPlaying(false);
          onMomentChange(null);
        }}
      >
        {t('now')}
      </Button>
    </section>
  );
}
