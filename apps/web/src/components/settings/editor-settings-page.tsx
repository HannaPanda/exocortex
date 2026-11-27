'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  OUTLINE_PINNED_MODES,
  OUTLINE_TRANSPARENCIES,
  type OutlinePinnedMode,
  type OutlineTransparency,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  ErrorState,
  Label,
  LoadingState,
  SectionRule,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@exocortex/ui';

import {
  type OutlinePreferenceChange,
  useOutlinePreferences,
  useUserPreferences,
} from '@/lib/api/preferences-queries';

function isOutlinePinnedMode(value: unknown): value is OutlinePinnedMode {
  return typeof value === 'string' && (OUTLINE_PINNED_MODES as readonly string[]).includes(value);
}

function isOutlineTransparency(value: unknown): value is OutlineTransparency {
  return typeof value === 'string' && (OUTLINE_TRANSPARENCIES as readonly string[]).includes(value);
}

/**
 * How pages behave for this account while it reads and writes (issue #283):
 * for now, how a pinned page outline sits beside the text, and whether a list
 * laid over the text steps aside for the line being written on.
 *
 * Selects like the language and chat pages beside it, each with the chosen
 * option explained underneath, because "über dem Text liegen" only says what
 * happens once one has seen it. The transparency is only read for a list
 * laid over the text, and so is stepping aside, so both are disabled, and say
 * why, while the text moves aside. The pin itself stays in the outline: whether it is pinned is a
 * choice per browser, how it is pinned a choice per person.
 */
export function EditorSettingsPage() {
  const t = useTranslations('settings.editor');
  const query = useUserPreferences();
  const outline = useOutlinePreferences();
  const [failed, setFailed] = React.useState(false);

  const change = (value: OutlinePreferenceChange) => {
    setFailed(false);
    outline.change(value, { onError: () => setFailed(true) });
  };

  const pinnedLabel = (mode: OutlinePinnedMode) =>
    mode === 'column' ? t('pinnedColumn') : t('pinnedOverlay');
  const transparencyLabel = (value: OutlineTransparency) =>
    value === 'none'
      ? t('transparencyNone')
      : value === 'light'
        ? t('transparencyLight')
        : t('transparencyStrong');
  const overlay = outline.pinned === 'overlay';
  const transparencyHint = !overlay
    ? t('transparencyColumnHint')
    : outline.transparency === 'none'
      ? t('transparencyNoneHint')
      : t('transparencyHint');

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('saveFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={2} />
      ) : query.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void query.refetch()} />
      ) : (
        <section className="flex flex-col gap-5" aria-labelledby="editor-outline-heading">
          <div className="flex flex-col gap-1">
            <SectionRule as="h2" id="editor-outline-heading">
              {t('outlineHeading')}
            </SectionRule>
            <p className="max-w-measure text-sm text-muted-foreground">{t('outlineIntro')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="outline-pinned">{t('pinnedLegend')}</Label>
            <Select
              value={outline.pinned}
              onValueChange={(value) => {
                if (isOutlinePinnedMode(value)) change({ outlinePinned: value });
              }}
            >
              <SelectTrigger
                id="outline-pinned"
                className="w-full sm:w-72"
                data-testid="outline-pinned"
              >
                <SelectValue>{() => pinnedLabel(outline.pinned)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OUTLINE_PINNED_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {pinnedLabel(mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="max-w-measure text-xs text-muted-foreground">
              {overlay ? t('pinnedOverlayHint') : t('pinnedColumnHint')}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="outline-transparency">{t('transparencyLegend')}</Label>
            <Select
              value={outline.transparency}
              disabled={!overlay}
              onValueChange={(value) => {
                if (isOutlineTransparency(value)) change({ outlineTransparency: value });
              }}
            >
              <SelectTrigger
                id="outline-transparency"
                className="w-full sm:w-72"
                data-testid="outline-transparency"
                aria-describedby="outline-transparency-hint"
              >
                <SelectValue>{() => transparencyLabel(outline.transparency)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OUTLINE_TRANSPARENCIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {transparencyLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              id="outline-transparency-hint"
              className="max-w-measure text-xs text-muted-foreground"
            >
              {transparencyHint}
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Switch
              id="outline-dodge"
              checked={outline.dodge}
              disabled={!overlay}
              onCheckedChange={(checked) => change({ outlineDodge: checked })}
              aria-describedby="outline-dodge-hint"
              data-testid="outline-dodge"
              className="mt-0.5"
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="outline-dodge">{t('dodgeLabel')}</Label>
              <p id="outline-dodge-hint" className="max-w-measure text-xs text-muted-foreground">
                {overlay ? t('dodgeHint') : t('dodgeColumnHint')}
              </p>
            </div>
          </div>
        </section>
      )}
    </AppPage>
  );
}
