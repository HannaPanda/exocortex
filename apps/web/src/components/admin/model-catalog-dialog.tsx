'use client';

import { SearchIcon } from 'lucide-react';
import * as React from 'react';

import { type AiModelCatalogEntry, groupAiModelsByVendor } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  ScrollArea,
  Switch,
} from '@exocortex/ui';

import { useAddAiModelsFromCatalog, useAiModelCatalog } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const numberFormat = new Intl.NumberFormat('de-DE');

/**
 * How many matches are rendered at once. The provider offers several hundred
 * models; a list that long is not read, it is searched, and rendering all of
 * them makes every keystroke in the search field expensive.
 */
const VISIBLE_LIMIT = 60;

function formatPrice(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function matches(entry: AiModelCatalogEntry, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = `${entry.slug} ${entry.displayName}`.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

function CatalogRow({
  entry,
  checked,
  onCheckedChange,
}: {
  entry: AiModelCatalogEntry;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const inputId = `catalog-${entry.slug}`;
  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <Checkbox
        id={inputId}
        className="mt-1"
        checked={checked}
        disabled={entry.registered}
        onCheckedChange={onCheckedChange}
      />
      <Label htmlFor={inputId} className="flex min-w-0 flex-1 flex-col gap-0.5 font-normal">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{entry.displayName}</span>
          {entry.registered ? <Badge variant="muted">im Register</Badge> : null}
          {entry.aliasTargetSlug !== null ? <Badge variant="outline">Alias</Badge> : null}
          {entry.supportsVision ? <Badge variant="secondary">Bild</Badge> : null}
          {entry.supportsTools ? <Badge variant="secondary">Werkzeuge</Badge> : null}
          {entry.reasoningLevels.length > 1 ? <Badge variant="secondary">Denkstufen</Badge> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {entry.slug}
          {entry.aliasTargetSlug !== null ? ` → ${entry.aliasTargetSlug}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          {numberFormat.format(entry.contextWindowTokens)} Tokens Kontext ·{' '}
          {formatPrice(entry.inputMicroUsdPerMTok)} / {formatPrice(entry.outputMicroUsdPerMTok)} pro
          Mio. Tokens
        </span>
      </Label>
    </div>
  );
}

export interface ModelCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Registers models by picking them out of the provider's own list.
 *
 * Everything the registry stores about a model (context window, prices, vision,
 * tools, thinking levels) is already in that list, so the ten fields of
 * `ModelDialog` are only needed for a model the provider does not offer, or for
 * correcting one afterwards.
 */
export function ModelCatalogDialog({ open, onOpenChange }: ModelCatalogDialogProps) {
  const catalogQuery = useAiModelCatalog(open);
  const addModels = useAddAiModelsFromCatalog();

  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [enableImmediately, setEnableImmediately] = React.useState(true);

  const close = (): void => {
    setSearch('');
    setSelected([]);
    addModels.reset();
    onOpenChange(false);
  };

  const entries = catalogQuery.data?.entries ?? [];
  const filtered = entries.filter((entry) => matches(entry, search));
  const visible = filtered.slice(0, VISIBLE_LIMIT);
  const addErrorCode = addModels.error instanceof ApiError ? addModels.error.code : undefined;

  const toggle = (slug: string, checked: boolean): void => {
    setSelected((current) =>
      checked ? [...current, slug] : current.filter((entry) => entry !== slug),
    );
  };

  const handleAdd = (): void => {
    addModels.mutate({ slugs: selected, enabled: enableImmediately }, { onSuccess: () => close() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Modelle aus dem OpenRouter-Katalog</DialogTitle>
          <DialogDescription>
            Auswählen genügt: Kontextfenster, Preise, Bildverständnis, Werkzeuge und Denkstufen
            kommen aus dem Katalog. Bei einem Alias ({'\u201Elatest\u201C'}) zählen die Werte des
            Ziels, und gespeichert wird der vorsichtigste Wert seiner Anbieter.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={'Suchen, etwa \u201Eglm\u201C oder \u201Eopenai gpt\u201C'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="model-catalog-search"
          />
        </div>

        {catalogQuery.isPending ? (
          <LoadingState label="Katalog wird geladen …" variant="skeleton" rows={4} />
        ) : catalogQuery.isError ? (
          <ErrorState
            title="Der Katalog konnte nicht geladen werden"
            description="OpenRouter hat nicht geantwortet."
            onRetry={() => void catalogQuery.refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="Kein Modell passt zur Suche" />
        ) : (
          <ScrollArea className="h-80 pr-2" clampContentWidth>
            <div className="flex flex-col gap-3">
              {groupAiModelsByVendor(visible).map((group) => (
                <div key={group.vendor} className="flex flex-col gap-0.5">
                  <span className="px-2 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </span>
                  {group.models.map((entry) => (
                    <CatalogRow
                      key={entry.slug}
                      entry={entry}
                      checked={selected.includes(entry.slug)}
                      onCheckedChange={(checked) => toggle(entry.slug, checked)}
                    />
                  ))}
                </div>
              ))}
              {filtered.length > visible.length ? (
                <p className="px-2 text-xs text-muted-foreground">
                  {numberFormat.format(filtered.length - visible.length)} weitere Treffer. Suche
                  eingrenzen, um sie zu sehen.
                </p>
              ) : null}
            </div>
          </ScrollArea>
        )}

        {addModels.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{messageForCode(addErrorCode)}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <Label className="flex items-center gap-2 font-normal">
            <Switch
              checked={enableImmediately}
              onCheckedChange={(checked) => setEnableImmediately(checked)}
            />
            Direkt aktivieren
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {selected.length === 0 ? 'nichts ausgewählt' : `${selected.length} ausgewählt`}
            </span>
            <Button variant="outline" onClick={close}>
              Abbrechen
            </Button>
            <Button
              disabled={selected.length === 0 || addModels.isPending}
              onClick={handleAdd}
              data-testid="model-catalog-add"
            >
              Hinzufügen
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
