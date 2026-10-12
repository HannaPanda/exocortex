'use client';

import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  KNOWLEDGE_MAP_POINT_COLOURS,
  KNOWLEDGE_MAP_PULSE_COLOURS,
  type KnowledgeMapPointColour,
  type KnowledgeMapPulseColour,
} from '@exocortex/contracts';
import { Button, cn, Label, Slider, Switch } from '@exocortex/ui';

import { MAP_PANEL } from './map-overlays';
import { type MapAppearanceState } from './use-map-appearance';

/** The swatch of each tunable colour, as token classes: the panel follows the palette. */
const SWATCH: Record<KnowledgeMapPointColour | KnowledgeMapPulseColour, string> = {
  blue: 'bg-content-blue',
  green: 'bg-content-green',
  purple: 'bg-content-purple',
  orange: 'bg-content-orange',
  pink: 'bg-content-pink',
  yellow: 'bg-content-yellow',
  red: 'bg-content-red',
  brown: 'bg-content-brown',
  gray: 'bg-content-gray',
  entity: 'bg-warning',
  read: 'bg-info',
  write: 'bg-primary',
  created: 'bg-success',
  removed: 'bg-destructive',
};

function Tuning({
  label,
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  testId?: string;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.25rem] items-center gap-2">
      <span className="truncate text-xs">{label}</span>
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        thumbLabel={label}
        onValueChange={(next) => {
          const picked = Array.isArray(next) ? next[0] : next;
          if (typeof picked === 'number') onChange(picked);
        }}
        data-testid={testId}
      />
      <span className="exocortex-numeric text-right text-nano text-muted-foreground">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border pt-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The map's look, tuned on the map itself (issue #189): the stars, the glow
 * and every colour, with the canvas behind as the live preview. Personal, and
 * saved as soon as a slider rests.
 */
export function MapAppearancePanel({
  state,
  onClose,
}: {
  state: MapAppearanceState;
  onClose: () => void;
}) {
  const t = useTranslations('knowledgeMap.appearance');
  const correctionId = React.useId();
  const { appearance: look, change } = state;

  return (
    <section
      aria-label={t('title')}
      className={cn(
        MAP_PANEL,
        'pointer-events-auto flex max-h-120 w-72 flex-col gap-2 overflow-y-auto p-3',
      )}
      data-testid="map-appearance"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
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

      <Group title={t('stars')}>
        <Tuning
          label={t('core')}
          value={look.star.core}
          min={0.2}
          max={1}
          step={0.01}
          onChange={(core) => change({ star: { core } })}
        />
        <Tuning
          label={t('halo')}
          value={look.star.halo}
          min={1}
          max={6}
          step={0.05}
          onChange={(halo) => change({ star: { halo } })}
          testId="map-appearance-halo"
        />
        <Tuning
          label={t('softness')}
          value={look.star.softness}
          min={0.8}
          max={5}
          step={0.05}
          onChange={(softness) => change({ star: { softness } })}
        />
      </Group>

      <Group title={t('glow')}>
        <Tuning
          label={t('bloomStrength')}
          value={look.bloom.strength}
          min={0}
          max={2.5}
          step={0.01}
          onChange={(strength) => change({ bloom: { strength } })}
        />
        <Tuning
          label={t('bloomRadius')}
          value={look.bloom.radius}
          min={0}
          max={1.5}
          step={0.01}
          onChange={(radius) => change({ bloom: { radius } })}
        />
        <Tuning
          label={t('bloomThreshold')}
          value={look.bloom.threshold}
          min={0}
          max={1}
          step={0.01}
          onChange={(threshold) => change({ bloom: { threshold } })}
        />
        <Tuning
          label={t('saturation')}
          value={look.saturation}
          min={0.5}
          max={3}
          step={0.05}
          onChange={(saturation) => change({ saturation })}
        />
        <div className="flex items-center justify-between gap-2" title={t('correctionHint')}>
          <Label htmlFor={correctionId} className="text-xs">
            {t('correction')}
          </Label>
          <Switch
            id={correctionId}
            size="sm"
            checked={look.colourCorrection}
            onCheckedChange={(colourCorrection) => change({ colourCorrection })}
          />
        </div>
      </Group>

      <Group title={t('points')}>
        <p className="text-nano text-muted-foreground">{t('pointsHint')}</p>
        {KNOWLEDGE_MAP_POINT_COLOURS.map((key) => (
          <div key={key} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden className={cn('size-2 rounded-full', SWATCH[key])} />
              {t(`colours.${key}`)}
            </span>
            <Tuning
              label={t('pointGlow')}
              value={look.points[key].glow}
              min={0}
              max={3}
              step={0.01}
              onChange={(glow) => change({ points: { [key]: { glow } } })}
            />
            <Tuning
              label={t('pointLightness')}
              value={look.points[key].lightness}
              min={0.25}
              max={0.85}
              step={0.01}
              onChange={(lightness) => change({ points: { [key]: { lightness } } })}
            />
          </div>
        ))}
      </Group>

      <Group title={t('pulses')}>
        {KNOWLEDGE_MAP_PULSE_COLOURS.map((key) => (
          <div key={key} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden className={cn('size-2 rounded-full', SWATCH[key])} />
              {t(`colours.${key}`)}
            </span>
            <Tuning
              label={t('pointGlow')}
              value={look.pulses[key].glow}
              min={0}
              max={3}
              step={0.01}
              onChange={(glow) => change({ pulses: { [key]: { glow } } })}
            />
          </div>
        ))}
      </Group>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {state.saving ? t('saving') : state.isDefault ? t('isDefault') : t('saved')}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={state.isDefault}
          onClick={state.reset}
          data-testid="map-appearance-reset"
        >
          {t('reset')}
        </Button>
      </div>
    </section>
  );
}
