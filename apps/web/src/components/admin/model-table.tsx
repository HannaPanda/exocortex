'use client';

import {
  ChevronDownIcon,
  ChevronRightIcon,
  LibraryBigIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiModel, groupAiModelsByVendor } from '@exocortex/contracts';
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

import { useDestructiveConfirmDialog } from '@/components/editor/destructive-confirm';
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
import { ModelEndpoints } from './model-endpoints';

type Formatter = ReturnType<typeof useFormatter>;

/** Micro-USD per million tokens as a dollar amount with two decimals. */
function formatPrice(format: Formatter, microUsd: number): string {
  return format.number(microUsd / 1_000_000, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface SyncSummary {
  updated: number;
  disabled: number;
  unchanged: number;
}

export function ModelTable() {
  const modelsQuery = useAdminAiModels();
  const updateModel = useUpdateAiModel();
  const deleteModel = useDeleteAiModel();
  const syncModels = useSyncAiModels();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [catalogOpen, setCatalogOpen] = React.useState(false);
  const [expandedModelId, setExpandedModelId] = React.useState<string | null>(null);
  const [editingModel, setEditingModel] = React.useState<AiModel | undefined>(undefined);
  const [syncSummary, setSyncSummary] = React.useState<SyncSummary | null>(null);
  const confirmDialog = useDestructiveConfirmDialog();
  const t = useTranslations('admin.models');
  const reasoningLabel = useTranslations('admin.reasoningLevels');
  const format = useFormatter();

  if (modelsQuery.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={5} />;
  }

  if (modelsQuery.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void modelsQuery.refetch()} />;
  }

  const { models, defaultModelSlug } = modelsQuery.data;
  const deleteErrorCode =
    deleteModel.error instanceof ApiError ? deleteModel.error.code : undefined;
  const syncErrorCode = syncModels.error instanceof ApiError ? syncModels.error.code : undefined;

  return (
    <div className="flex flex-col gap-4">
      {confirmDialog.element}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('defaultModel')}</span>
          <Badge variant="outline">{defaultModelSlug ?? t('defaultModelUnset')}</Badge>
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
                    setSyncSummary({
                      updated: result.updated.length,
                      disabled: result.disabled.length,
                      unchanged: result.unchanged,
                    });
                  },
                },
              )
            }
          >
            <RefreshCwIcon /> {t('sync')}
          </Button>
          <Button onClick={() => setCatalogOpen(true)}>
            <LibraryBigIcon /> {t('addFromCatalog')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setEditingModel(undefined);
              setDialogOpen(true);
            }}
          >
            <PlusIcon /> {t('addManually')}
          </Button>
        </div>
      </div>

      {syncSummary !== null ? (
        <Alert data-testid="sync-summary">
          <AlertDescription>{t('syncSummary', { ...syncSummary })}</AlertDescription>
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

      <Table narrow="list">
        <TableCaption className="sr-only">{t('caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.model')}</TableHead>
            <TableHead>{t('columns.context')}</TableHead>
            <TableHead>{t('columns.vision')}</TableHead>
            <TableHead>{t('columns.reasoning')}</TableHead>
            <TableHead>{t('columns.price')}</TableHead>
            <TableHead>{t('columns.enabled')}</TableHead>
            <TableHead className="text-right">{t('columns.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupAiModelsByVendor(models).flatMap((group) => [
            <TableRow key={`vendor-${group.vendor}`} className="bg-muted/40 hover:bg-muted/40">
              <TableCell colSpan={7} className="py-1.5 text-xs font-medium text-muted-foreground">
                {group.label}
              </TableCell>
            </TableRow>,
            ...group.models.flatMap((model) => [
              <TableRow key={model.id}>
                <TableCell cell="title">
                  <div className="flex items-start gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(
                        expandedModelId === model.id ? 'hideEndpoints' : 'showEndpoints',
                        { name: model.displayName },
                      )}
                      onClick={() =>
                        setExpandedModelId((current) => (current === model.id ? null : model.id))
                      }
                    >
                      {expandedModelId === model.id ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    </Button>
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium">{model.displayName}</span>
                      <span className="text-xs text-muted-foreground">
                        {model.slug}
                        {model.aliasTargetSlug !== null ? ` → ${model.aliasTargetSlug}` : ''}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell label={t('columns.context')}>
                  {t('tokens', { count: model.contextWindowTokens })}
                </TableCell>
                <TableCell label={t('columns.vision')}>
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={model.supportsVision ? 'default' : 'muted'}>
                      {model.supportsVision ? t('yes') : t('no')}
                    </Badge>
                    {!model.supportsVision && model.visionCompanionSlug !== null ? (
                      <span className="text-xs text-muted-foreground">
                        {model.visionCompanionSlug}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell label={t('columns.reasoning')}>
                  <div className="flex flex-wrap gap-1">
                    {model.reasoningLevels.map((level) => (
                      <Badge key={level} variant="secondary">
                        {reasoningLabel(level)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell label={t('columns.price')}>
                  {t('price', {
                    input: formatPrice(format, model.inputMicroUsdPerMTok),
                    output: formatPrice(format, model.outputMicroUsdPerMTok),
                  })}
                </TableCell>
                <TableCell label={t('columns.enabled')}>
                  <Switch
                    aria-label={t('enabledToggle', { name: model.displayName })}
                    checked={model.enabled}
                    onCheckedChange={(checked) =>
                      updateModel.mutate({ modelId: model.id, request: { enabled: checked } })
                    }
                  />
                </TableCell>
                <TableCell cell="actions" className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('actionsFor', { name: model.displayName })}
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
                        {t('edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          void confirmDialog
                            .confirm({
                              title: t('removeTitle', { name: model.displayName }),
                              description: t('removeDescription'),
                              confirmLabel: t('remove'),
                            })
                            .then((confirmed) => {
                              if (confirmed) deleteModel.mutate(model.id);
                            });
                        }}
                      >
                        {t('remove')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>,
              ...(expandedModelId === model.id
                ? [
                    <TableRow key={`${model.id}-endpoints`} className="hover:bg-transparent">
                      <TableCell colSpan={7} className="bg-muted/30">
                        <ModelEndpoints modelId={model.id} modelSlug={model.slug} />
                      </TableCell>
                    </TableRow>,
                  ]
                : []),
            ]),
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
