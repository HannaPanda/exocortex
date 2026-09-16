'use client';

import { LibraryBigIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import * as React from 'react';

import { type AiModel, type AiReasoningLevel, groupAiModelsByVendor } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  LoadingState,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import {
  useAdminAiModels,
  useDeleteAiModel,
  useSyncAiModels,
  useUpdateAiModel,
} from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

import { ModelCatalogDialog } from './model-catalog-dialog';
import { ModelDialog } from './model-dialog';

const numberFormat = new Intl.NumberFormat('de-DE');

const REASONING_LABELS: Record<AiReasoningLevel, string> = {
  none: 'keine',
  minimal: 'minimal',
  low: 'niedrig',
  medium: 'mittel',
  high: 'hoch',
  xhigh: 'sehr hoch',
  max: 'maximal',
};

/** `$X,XX / $Y,YY per Mio. Tokens`, computed from the micro-USD integers. */
function formatPrice(inputMicroUsd: number, outputMicroUsd: number): string {
  const format = (microUsd: number): string =>
    (microUsd / 1_000_000).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return `$${format(inputMicroUsd)} / $${format(outputMicroUsd)} per Mio. Tokens`;
}

export function ModelTable() {
  const modelsQuery = useAdminAiModels();
  const updateModel = useUpdateAiModel();
  const deleteModel = useDeleteAiModel();
  const syncModels = useSyncAiModels();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [catalogOpen, setCatalogOpen] = React.useState(false);
  const [editingModel, setEditingModel] = React.useState<AiModel | undefined>(undefined);
  const [syncSummary, setSyncSummary] = React.useState<string | null>(null);

  if (modelsQuery.isPending) {
    return <LoadingState label="Modelle werden geladen …" variant="skeleton" rows={5} />;
  }

  if (modelsQuery.isError) {
    return (
      <ErrorState
        title="Modelle konnten nicht geladen werden"
        onRetry={() => void modelsQuery.refetch()}
      />
    );
  }

  const { models, defaultModelSlug } = modelsQuery.data;
  const deleteErrorCode =
    deleteModel.error instanceof ApiError ? deleteModel.error.code : undefined;
  const syncErrorCode = syncModels.error instanceof ApiError ? syncModels.error.code : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Standardmodell:</span>
          <Badge variant="outline">{defaultModelSlug ?? 'nicht gesetzt'}</Badge>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={syncModels.isPending}
            onClick={() =>
              syncModels.mutate(
                { slugs: [], addMissing: false },
                {
                  onSuccess: (result) => {
                    setSyncSummary(
                      `${result.updated.length} aktualisiert, ${result.disabled.length} deaktiviert, ${result.unchanged} unverändert.`,
                    );
                  },
                },
              )
            }
          >
            <RefreshCwIcon /> Von OpenRouter aktualisieren
          </Button>
          <Button onClick={() => setCatalogOpen(true)}>
            <LibraryBigIcon /> Aus dem Katalog hinzufügen
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setEditingModel(undefined);
              setDialogOpen(true);
            }}
          >
            <PlusIcon /> Von Hand anlegen
          </Button>
        </div>
      </div>

      {syncSummary !== null ? (
        <Alert data-testid="sync-summary">
          <AlertDescription>{syncSummary}</AlertDescription>
        </Alert>
      ) : null}
      {syncModels.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{messageForCode(syncErrorCode)}</AlertDescription>
        </Alert>
      ) : null}
      {deleteModel.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{messageForCode(deleteErrorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <Table>
        <TableCaption className="sr-only">Liste der KI-Modelle im Register</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Modell</TableHead>
            <TableHead>Kontext</TableHead>
            <TableHead>Bild</TableHead>
            <TableHead>Denkstufen</TableHead>
            <TableHead>Preis</TableHead>
            <TableHead>Aktiv</TableHead>
            <TableHead className="text-right">Aktionen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupAiModelsByVendor(models).flatMap((group) => [
            <TableRow key={`vendor-${group.vendor}`} className="bg-muted/40 hover:bg-muted/40">
              <TableCell colSpan={7} className="py-1.5 text-xs font-medium text-muted-foreground">
                {group.label}
              </TableCell>
            </TableRow>,
            ...group.models.map((model) => (
              <TableRow key={model.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{model.displayName}</span>
                    <span className="text-xs text-muted-foreground">{model.slug}</span>
                  </div>
                </TableCell>
                <TableCell>{numberFormat.format(model.contextWindowTokens)} Tokens</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={model.supportsVision ? 'default' : 'muted'}>
                      {model.supportsVision ? 'Ja' : 'Nein'}
                    </Badge>
                    {!model.supportsVision && model.visionCompanionSlug !== null ? (
                      <span className="text-xs text-muted-foreground">
                        {model.visionCompanionSlug}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {model.reasoningLevels.map((level) => (
                      <Badge key={level} variant="secondary">
                        {REASONING_LABELS[level]}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {formatPrice(model.inputMicroUsdPerMTok, model.outputMicroUsdPerMTok)}
                </TableCell>
                <TableCell>
                  <Switch
                    aria-label={`${model.displayName} aktiv`}
                    checked={model.enabled}
                    onCheckedChange={(checked) =>
                      updateModel.mutate({ modelId: model.id, request: { enabled: checked } })
                    }
                  />
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Aktionen für ${model.displayName}`}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setEditingModel(model);
                          setDialogOpen(true);
                        }}
                      >
                        Bearbeiten
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => deleteModel.mutate(model.id)}
                      >
                        Entfernen
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )),
          ])}
        </TableBody>
      </Table>

      <ModelCatalogDialog open={catalogOpen} onOpenChange={setCatalogOpen} />

      <ModelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        model={editingModel}
        models={models}
      />
    </div>
  );
}
