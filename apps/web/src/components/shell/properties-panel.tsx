'use client';

import { ChevronDownIcon, ImageIcon, MoveVerticalIcon, SettingsIcon, XIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  ErrorState,
  Leader,
  LoadingState,
  sectionLabelClassName,
  SectionRule,
} from '@exocortex/ui';

import { PropertyCell } from '@/components/database/cells';
import { PROPERTY_TYPE_LABELS } from '@/components/database/property-types';
import { VIEW_TYPE_LABELS } from '@/components/database/view-tabs';
import { DocumentIcon } from '@/components/document/document-icon';
import { PageIconPicker } from '@/components/document/page-icon-picker';
import { PagePropertiesDialog } from '@/components/document/page-properties-dialog';
import {
  useDatabaseProperties,
  useDatabaseViews,
  useDocumentRow,
  useUpdateDatabaseRowValues,
} from '@/lib/api/database-queries';
import { useDocument, useUpdateDocument } from '@/lib/api/document-queries';

/**
 * Values of the row this page is, when it sits inside a database
 * (`detail.parentType === 'COLLECTION'`, ADR-011). Reuses the same
 * `PropertyCell` the table view and the row-peek sheet already edit through, so
 * a value looks and behaves identically no matter where it is touched (issue
 * #17).
 */
function RowPropertiesSection({
  collectionDocumentId,
  rowId,
  readOnly,
}: {
  collectionDocumentId: string;
  rowId: string;
  readOnly: boolean;
}) {
  const t = useTranslations('document.propertiesPanel');
  const properties = useDatabaseProperties(collectionDocumentId);
  const row = useDocumentRow(rowId);
  const updateValues = useUpdateDatabaseRowValues(collectionDocumentId);

  if (properties.isPending) {
    return <LoadingState variant="skeleton" rows={3} label={t('loading')} />;
  }
  if (row.isPending) {
    return <LoadingState variant="skeleton" rows={3} label={t('loading')} />;
  }
  if (properties.isError) {
    return <ErrorState title={t('unavailable')} onRetry={() => void properties.refetch()} />;
  }
  if (row.isError) {
    return <ErrorState title={t('unavailable')} onRetry={() => void row.refetch()} />;
  }
  // The parent could have stopped being a database, or the row could have been
  // moved out from under it, between the detail load that decided to render
  // this section and this query's own answer; both settle to "nothing to show"
  // rather than an error, the same way `getForDocument` on the API answers null.
  if (row.data === null) return null;

  const values = row.data.values;

  return (
    <section className="flex flex-col gap-2" data-testid="row-properties">
      <SectionRule as="h3">{t('properties')}</SectionRule>
      {properties.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noDatabaseProperties')}</p>
      ) : (
        properties.data.map((property) => (
          <div key={property.id} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{property.name}</span>
            <div className="rounded-md border border-border">
              <PropertyCell
                property={property}
                value={values.find((entry) => entry.propertyId === property.id)?.value ?? null}
                readOnly={readOnly}
                rowHeight="tall"
                onChange={(next) => {
                  void updateValues.mutateAsync({
                    rowId,
                    request: { values: [{ propertyId: property.id, value: next }] },
                  });
                }}
              />
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/** Compact cover control: a thumbnail plus "Position ändern" and "Entfernen". */
function CoverSection({
  workspaceId,
  detail,
  readOnly,
}: {
  workspaceId: string;
  detail: DocumentDetail;
  readOnly: boolean;
}) {
  const t = useTranslations('document.propertiesPanel');
  const updateDocument = useUpdateDocument(workspaceId);
  const [repositioning, setRepositioning] = React.useState(false);
  const [draft, setDraft] = React.useState(detail.coverPosition);

  if (detail.coverAttachmentId === null) return null;
  const attachmentId = detail.coverAttachmentId;

  return (
    <section className="flex flex-col gap-1.5" data-testid="properties-cover">
      <SectionRule as="h3">{t('cover')}</SectionRule>
      <div className="h-16 w-full overflow-hidden rounded-md bg-surface">
        {/* oxlint-disable-next-line nextjs/no-img-element -- attachment ids are arbitrary user uploads, not build-time-known assets next/image can optimize. */}
        <img
          src={`/api/attachments/${attachmentId}/download?variant=preview`}
          alt=""
          className="size-full object-cover"
          style={{ objectPosition: `50% ${draft}%` }}
        />
      </div>
      {readOnly ? null : repositioning ? (
        <div className="flex flex-col gap-1.5">
          <input
            type="range"
            min={0}
            max={100}
            value={draft}
            aria-label={t('coverPositionLabel')}
            data-testid="properties-cover-position"
            onChange={(event) => setDraft(Number(event.target.value))}
          />
          <div className="flex gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(detail.coverPosition);
                setRepositioning(false);
              }}
            >
              <XIcon /> {t('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={updateDocument.isPending}
              data-testid="properties-cover-save"
              onClick={() => {
                void updateDocument
                  .mutateAsync({ documentId: detail.id, request: { coverPosition: draft } })
                  .then(() => setRepositioning(false));
              }}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid="properties-cover-reposition"
            onClick={() => setRepositioning(true)}
          >
            <MoveVerticalIcon /> {t('reposition')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={updateDocument.isPending}
            data-testid="properties-cover-remove"
            onClick={() =>
              void updateDocument.mutateAsync({
                documentId: detail.id,
                request: { coverAttachmentId: null },
              })
            }
          >
            <ImageIcon /> {t('remove')}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Who created and last changed the page, and where it sits in the tree. */
function ProvenanceSection({ detail }: { detail: DocumentDetail }) {
  const t = useTranslations('document.propertiesPanel');
  const format = useFormatter();
  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="flex flex-col gap-1.5" data-testid="provenance">
      <SectionRule as="h3">{t('provenance')}</SectionRule>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">{t('createdAt')}</dt>
        <dd>
          <span className="exocortex-numeric">{dateTime(detail.createdAt)}</span> ·{' '}
          {detail.createdByName}
        </dd>
        <dt className="text-muted-foreground">{t('changedAt')}</dt>
        <dd>
          <span className="exocortex-numeric">{dateTime(detail.updatedAt)}</span> ·{' '}
          {detail.updatedByName}
        </dd>
        <dt className="text-muted-foreground">{t('path')}</dt>
        <dd className="break-words">
          {detail.breadcrumb.length === 0
            ? t('topLevel')
            : detail.breadcrumb.map((entry) => entry.title).join(' / ')}
        </dd>
      </dl>
    </section>
  );
}

/** Schema version and materialization state: useful for debugging, not for a first glance. */
function TechnicalSection({ detail }: { detail: DocumentDetail }) {
  const t = useTranslations('document.propertiesPanel');
  const format = useFormatter();
  const [open, setOpen] = React.useState(false);

  return (
    <section className="flex flex-col gap-1.5 border-t border-border pt-3">
      <button
        type="button"
        // The mark's typography from one place. This stays a button rather
        // than a `SectionRule`, because it is a control and the rule is not --
        // what it borrows is the family resemblance, not the device.
        className={cn(
          'flex items-center gap-2 transition-colors hover:text-foreground',
          sectionLabelClassName,
        )}
        aria-expanded={open}
        data-testid="technical-section-toggle"
        onClick={() => setOpen((next) => !next)}
      >
        <ChevronDownIcon
          className={cn('size-3.5 transition-transform', open ? 'rotate-180' : undefined)}
        />
        {t('technical')}
        <span className="h-px w-6 shrink-0 bg-signal-line" aria-hidden />
      </button>
      {/* Leaders rather than a two-column grid: both values are short and
          right-aligned, which is the case a table of contents solved long ago
          and a grid solves badly at panel width. */}
      {open ? (
        <dl className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0">{t('schemaVersion')}</dt>
            <Leader />
            <dd className="exocortex-numeric shrink-0">{detail.schemaVersion}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0">{t('lastProcessed')}</dt>
            <Leader />
            <dd
              className={cn(
                'shrink-0',
                detail.materializedAt === null ? undefined : 'exocortex-numeric',
              )}
              data-testid="materialized-at"
            >
              {detail.materializedAt === null
                ? t('notYet')
                : format.dateTime(new Date(detail.materializedAt), {
                    dateStyle: 'short',
                    timeStyle: 'medium',
                  })}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

/** Type and access, always visible: cheap orientation before anything else. */
function MetaLine({ detail }: { detail: DocumentDetail }) {
  const t = useTranslations('document');
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>{t(`types.${detail.type}`)}</span>
      <Badge variant={detail.access === 'write' ? 'outline' : 'muted'}>
        {detail.access === 'write'
          ? t('propertiesPanel.accessWrite')
          : t('propertiesPanel.accessRead')}
      </Badge>
    </div>
  );
}

/** Properties tab content for an ordinary page or a database row. */
function PageProperties({ workspaceId, detail }: { workspaceId: string; detail: DocumentDetail }) {
  const t = useTranslations('document.propertiesPanel');
  const tDocument = useTranslations('document');
  const readOnly = detail.access === 'read';
  const updateDocument = useUpdateDocument(workspaceId);
  const [aiRuleDialogOpen, setAiRuleDialogOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="page-properties">
      <MetaLine detail={detail} />

      {/* `PageIconPicker` directly, not the page header's `PageIconButton` /
          `PageIconAddButton`: those hard-code the testid a hovering page
          header already uses, and both controls can be on screen together
          (this panel open next to the page it describes). */}
      <div className="flex items-center gap-3">
        <PageIconPicker
          icon={detail.icon}
          iconColor={detail.iconColor}
          type={detail.type}
          onSelect={(selection) => {
            void updateDocument.mutateAsync({ documentId: detail.id, request: selection });
          }}
          trigger={
            <button
              type="button"
              disabled={readOnly}
              aria-label={t('chooseSymbol')}
              data-testid="properties-icon-button"
              className="grid size-9 place-items-center rounded-md border border-border transition-colors hover:border-border-strong disabled:opacity-50"
            >
              <DocumentIcon
                icon={detail.icon}
                iconColor={detail.iconColor}
                type={detail.type}
                className="size-5 text-lg text-muted-foreground"
              />
            </button>
          }
        />
        <span className="text-xs text-muted-foreground">
          {detail.icon === null ? t('noSymbol') : t('symbol')}
        </span>
      </div>

      {detail.type === 'PAGE' && detail.parentId !== null && detail.parentType === 'COLLECTION' ? (
        <RowPropertiesSection
          collectionDocumentId={detail.parentId}
          rowId={detail.id}
          readOnly={readOnly}
        />
      ) : null}

      <CoverSection workspaceId={workspaceId} detail={detail} readOnly={readOnly} />

      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3">{t('aiRule')}</SectionRule>
        {detail.aiRuleMode === 'off' ? (
          <p className="text-xs text-muted-foreground">
            {t('aiRuleOff')}{' '}
            {readOnly ? null : (
              <button
                type="button"
                className="underline hover:text-foreground"
                data-testid="open-ai-rule-from-properties"
                onClick={() => setAiRuleDialogOpen(true)}
              >
                {t('setAsRule')}
              </button>
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant="muted">{tDocument(`aiRuleModes.${detail.aiRuleMode}`)}</Badge>
              {readOnly ? null : (
                <button
                  type="button"
                  className="text-xs underline hover:text-foreground"
                  data-testid="open-ai-rule-from-properties"
                  onClick={() => setAiRuleDialogOpen(true)}
                >
                  {t('editRule')}
                </button>
              )}
            </div>
            {detail.aiRuleTrigger === null ? null : (
              <p className="text-xs text-muted-foreground">{detail.aiRuleTrigger}</p>
            )}
          </div>
        )}
      </section>

      <ProvenanceSection detail={detail} />
      <TechnicalSection detail={detail} />

      {/* Reused rather than re-implemented: this is the same dialog the
          document actions menu opens (`document-view.tsx`), so the AI-rule
          fields have exactly one editor. */}
      <PagePropertiesDialog
        workspaceId={workspaceId}
        detail={detail}
        open={aiRuleDialogOpen}
        onOpenChange={setAiRuleDialogOpen}
      />
    </div>
  );
}

/** Properties tab content for a database itself: a different question than a page's. */
function CollectionProperties({ detail }: { detail: DocumentDetail }) {
  const t = useTranslations('document.propertiesPanel');
  const properties = useDatabaseProperties(detail.id);
  const views = useDatabaseViews(detail.id);

  const propertiesSection = properties.isPending ? (
    <LoadingState variant="skeleton" rows={2} />
  ) : properties.isError ? (
    <ErrorState title={t('unavailable')} onRetry={() => void properties.refetch()} />
  ) : properties.data.length === 0 ? (
    <p className="text-xs text-muted-foreground">{t('noPropertiesYet')}</p>
  ) : (
    properties.data.map((property) => (
      <div
        key={property.id}
        className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-xs"
      >
        <span>{property.name}</span>
        <span className="text-muted-foreground">{PROPERTY_TYPE_LABELS[property.type]}</span>
      </div>
    ))
  );

  const viewsSection = views.isPending ? (
    <LoadingState variant="skeleton" rows={2} />
  ) : views.isError ? (
    <ErrorState title={t('viewsUnavailable')} onRetry={() => void views.refetch()} />
  ) : views.data.length === 0 ? (
    <p className="text-xs text-muted-foreground">{t('noViewsYet')}</p>
  ) : (
    views.data.map((view) => (
      <div key={view.id} className="rounded-md border border-border px-2 py-1.5 text-xs">
        {view.name} <span className="text-muted-foreground">· {VIEW_TYPE_LABELS[view.type]}</span>
      </div>
    ))
  );

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="collection-properties">
      <MetaLine detail={detail} />

      <div>
        <span className="text-xs text-muted-foreground">{t('rows')}</span>
        <p className="exocortex-numeric text-lg" data-testid="collection-row-count">
          {detail.rowCount ?? 0}
        </p>
      </div>

      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3" trailing={properties.data?.length}>
          {t('properties')}
        </SectionRule>
        {propertiesSection}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3" trailing={views.data?.length}>
          {t('views')}
        </SectionRule>
        {viewsSection}
      </section>

      <ProvenanceSection detail={detail} />
      <TechnicalSection detail={detail} />
    </div>
  );
}

export interface PropertiesPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/**
 * The "Eigenschaften" tab: everything about the open document that is not its
 * content (issue #17).
 *
 * A database and a page answer a different question here — a database's
 * properties are "how many rows, which columns, which views", a page's
 * properties are its own metadata plus, when it is a row, the column values
 * that make it one — so the two render through entirely separate components
 * rather than one branching tree of conditionals.
 */
export function PropertiesPanel({ workspaceId, documentId }: PropertiesPanelProps) {
  const t = useTranslations('document.propertiesPanel');
  const document = useDocument(documentId ?? undefined);

  if (documentId === null || workspaceId === null) {
    return (
      <EmptyState
        title={t('noPageTitle')}
        description={t('noPageDescription')}
        icon={SettingsIcon}
      />
    );
  }

  if (document.isPending) {
    return <LoadingState variant="skeleton" rows={5} label={t('loading')} />;
  }
  if (document.isError) {
    return (
      <ErrorState
        title={t('unavailable')}
        description={t('pageLoadFailed')}
        onRetry={() => void document.refetch()}
      />
    );
  }

  const detail = document.data;
  return detail.type === 'COLLECTION' ? (
    <CollectionProperties detail={detail} />
  ) : (
    <PageProperties workspaceId={workspaceId} detail={detail} />
  );
}
