'use client';

import {
  FileTextIcon,
  Heading1Icon,
  Link2OffIcon,
  type LucideIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import type {
  AttentionItem,
  OverviewDocument,
  WorkspaceOverviewResponse,
} from '@exocortex/contracts';
import {
  AppPage,
  Button,
  EmptyState,
  ErrorState,
  Leader,
  SectionRule,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useCreateDocument } from '@/lib/api/document-queries';
import { useWorkspaceOverview } from '@/lib/api/workspace-queries';
import { formatRelativeTime } from '@/lib/relative-time';

/**
 * The landing view of a workspace.
 *
 * It deliberately does not list pages: the sidebar tree already does that, and
 * better. What the tree cannot show is *time* — it is sorted by structure — so
 * this view is a readout of recency and loose ends instead. No cards: a card
 * around a list is a box around information that already had a shape.
 */

const NUMBER = new Intl.NumberFormat('de-DE');

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${NUMBER.format(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${NUMBER.format(Math.round(value * 10) / 10)} ${units[unit]}`;
}

/**
 * The one-line readout under the title.
 *
 * A zero is dropped rather than printed: "0 Datenbanken · 0 B" is four words
 * that say nothing happened, and a readout that reports absences is noise a
 * reader has to filter every single time they open the workspace.
 */
function formatPulse(stats: WorkspaceOverviewResponse['stats']): string {
  const parts = [`${NUMBER.format(stats.pageCount)} Seiten`];
  if (stats.databaseCount > 0) {
    parts.push(`${NUMBER.format(stats.databaseCount)} Datenbanken`);
  }
  if (stats.editedThisWeek > 0) {
    parts.push(`${NUMBER.format(stats.editedThisWeek)} diese Woche bearbeitet`);
  }
  if (stats.attachmentBytes > 0) parts.push(formatBytes(stats.attachmentBytes));
  return parts.join(' · ');
}

function documentHref(workspaceId: string, documentId: string): string {
  return `/arbeitsbereich/${workspaceId}/seite/${documentId}`;
}

/** "Technik › Server". Empty at top level, and then it renders nothing. */
function DocumentPath({ path }: { path: OverviewDocument['path'] }) {
  if (path.length === 0) return null;
  return (
    <span className="block truncate text-xs text-muted-foreground">
      {path.map((entry) => entry.title).join(' › ')}
    </span>
  );
}

function RecentRow({
  workspaceId,
  document,
}: {
  workspaceId: string;
  document: WorkspaceOverviewResponse['recentlyEdited'][number];
}) {
  return (
    <li>
      <Link
        href={documentHref(workspaceId, document.id)}
        data-testid={`overview-page-${document.id}`}
        className="-mx-2 flex items-start gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
      >
        <DocumentIcon
          icon={document.icon}
          iconColor={document.iconColor}
          type={document.type}
          className="size-4 shrink-0 translate-y-0.5 text-sm text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          {/* Title and time share one baseline with the leader between them; the
              path hangs underneath, so the leader never runs through it. */}
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{document.title}</span>
            <Leader />
            <time
              dateTime={document.editedAt}
              title={
                document.editedByName === null
                  ? undefined
                  : `Zuletzt bearbeitet von ${document.editedByName}`
              }
              className="exocortex-numeric shrink-0 text-xs text-muted-foreground"
            >
              {formatRelativeTime(document.editedAt)}
            </time>
          </span>
          <DocumentPath path={document.path} />
        </span>
      </Link>
    </li>
  );
}

/**
 * One kind of loose end: how many, and the first few places to go.
 *
 * The count wears amber because it is the one thing on this screen that is
 * *happening*; everything else is a place. A count of zero is never drawn, so
 * the block stays empty until it has something to say.
 */
function AttentionRow({
  workspaceId,
  icon: Icon,
  label,
  item,
}: {
  workspaceId: string;
  icon: LucideIcon;
  label: string;
  item: AttentionItem;
}) {
  if (item.count === 0) return null;
  return (
    <li>
      <span className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="exocortex-numeric text-sm font-medium text-primary-text">
          {NUMBER.format(item.count)}
        </span>
        <span className="text-sm">{label}</span>
      </span>
      <span className="mt-0.5 ml-6 flex flex-wrap gap-x-3 gap-y-0.5">
        {item.documents.map((document) => (
          <Link
            key={document.id}
            href={documentHref(workspaceId, document.id)}
            className="truncate text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {document.title}
          </Link>
        ))}
      </span>
    </li>
  );
}

/** A database as a control, not a card: a chip you press to open the table. */
function DatabaseChip({
  workspaceId,
  database,
}: {
  workspaceId: string;
  database: WorkspaceOverviewResponse['databases'][number];
}) {
  return (
    <Link
      href={documentHref(workspaceId, database.id)}
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 transition-colors hover:border-border-strong hover:bg-accent"
    >
      <DocumentIcon
        icon={database.icon}
        iconColor={database.iconColor}
        type={database.type}
        className="size-4 shrink-0 text-sm text-muted-foreground"
      />
      <span className="truncate text-sm font-medium">{database.title}</span>
      <span className="exocortex-numeric shrink-0 text-xs text-muted-foreground">
        {NUMBER.format(database.rowCount)}
      </span>
    </Link>
  );
}

/**
 * A top-level page with the size of its branch, set like a table of contents:
 * the dotted leader carries the eye across to the number, which is what a
 * two-column list of counts otherwise fails to do.
 */
function SectionRow({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section: WorkspaceOverviewResponse['sections'][number];
}) {
  return (
    <li>
      <Link
        href={documentHref(workspaceId, section.id)}
        className="-mx-2 flex items-baseline gap-2 rounded-md px-2 py-1 transition-colors hover:bg-accent"
      >
        <DocumentIcon
          icon={section.icon}
          iconColor={section.iconColor}
          type={section.type}
          className="size-4 shrink-0 translate-y-0.5 text-sm text-muted-foreground"
        />
        <span className="truncate text-sm">{section.title}</span>
        <Leader />
        <span className="exocortex-numeric shrink-0 text-xs text-muted-foreground">
          {NUMBER.format(section.descendantCount)}
        </span>
      </Link>
    </li>
  );
}

export function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const overview = useWorkspaceOverview(workspaceId);
  const createDocument = useCreateDocument(workspaceId);

  const createPage = React.useCallback(() => {
    void createDocument
      .mutateAsync({ title: 'Unbenannte Seite', type: 'PAGE', parentId: null })
      .then((document) => router.push(documentHref(workspaceId, document.id)));
  }, [createDocument, router, workspaceId]);

  if (overview.isError) {
    return (
      <AppPage maxWidth="max-w-4xl">
        <ErrorState onRetry={() => void overview.refetch()} />
      </AppPage>
    );
  }

  const data = overview.data;

  return (
    <AppPage maxWidth="max-w-4xl">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="exocortex-page-title truncate">{data?.workspaceName ?? 'Übersicht'}</h1>
          {data === undefined ? (
            <Skeleton className="mt-2 h-4 w-72" />
          ) : (
            <p className="exocortex-numeric mt-1 text-xs text-muted-foreground">
              {formatPulse(data.stats)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Arbeitsbereich-Einstellungen"
                  data-testid="open-workspace-settings"
                  render={<Link href={`/arbeitsbereich/${workspaceId}/einstellungen`} />}
                >
                  <SettingsIcon />
                </Button>
              }
            />
            <TooltipContent>Einstellungen</TooltipContent>
          </Tooltip>
          <Button size="sm" data-testid="overview-create-page" onClick={createPage}>
            <PlusIcon /> Neue Seite
          </Button>
        </div>
      </header>

      {data === undefined ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Übersicht wird geladen …">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : (
        <WorkspaceOverviewBody workspaceId={workspaceId} data={data} onCreatePage={createPage} />
      )}
    </AppPage>
  );
}

/**
 * The four blocks. Split out from the shell above so the loading and error
 * paths stay readable, and so this half never renders without data.
 */
function WorkspaceOverviewBody({
  workspaceId,
  data,
  onCreatePage,
}: {
  workspaceId: string;
  data: WorkspaceOverviewResponse;
  onCreatePage: () => void;
}) {
  const hasAttention =
    data.attention.openComments.count > 0 ||
    data.attention.brokenLinks.count > 0 ||
    data.attention.stalledAttachments.count > 0;

  if (data.recentlyEdited.length === 0) {
    return (
      <EmptyState
        title="Noch keine Seiten"
        description="Lege deine erste Seite an. Alles Weitere wächst daran."
        icon={FileTextIcon}
        action={{ label: 'Seite anlegen', onClick: onCreatePage }}
      />
    );
  }

  return (
    /* The rhythm is deliberately uneven: 2.5rem between sections, 0.75rem
       between a rule and the rows under it. Even spacing reads as a list of
       equals; this reads as groups (DESIGN.md, Typography). */
    <div className="flex flex-col gap-10">
      {/* Two columns only when the second one has something in it. An empty
          column would leave the recency list stopping halfway across the page
          while every rule below it runs the full width. */}
      <div
        className={
          hasAttention ? 'grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid gap-10'
        }
      >
        <section className="flex flex-col gap-3" aria-labelledby="overview-recent">
          <SectionRule>
            <span id="overview-recent">Weitermachen</span>
          </SectionRule>
          <ul className="flex flex-col">
            {data.recentlyEdited.map((document) => (
              <RecentRow key={document.id} workspaceId={workspaceId} document={document} />
            ))}
          </ul>
        </section>

        {hasAttention ? (
          <section className="flex flex-col gap-3" aria-labelledby="overview-attention">
            <SectionRule>
              <span id="overview-attention">Liegen geblieben</span>
            </SectionRule>
            <ul className="flex flex-col gap-3">
              <AttentionRow
                workspaceId={workspaceId}
                icon={MessageSquareIcon}
                label="offene Kommentare"
                item={data.attention.openComments}
              />
              <AttentionRow
                workspaceId={workspaceId}
                icon={Link2OffIcon}
                label="Verweise ins Leere"
                item={data.attention.brokenLinks}
              />
              <AttentionRow
                workspaceId={workspaceId}
                icon={PaperclipIcon}
                label="Texte noch nicht gelesen"
                item={data.attention.stalledAttachments}
              />
              <AttentionRow
                workspaceId={workspaceId}
                icon={Heading1Icon}
                label="Titel gleich nochmal als Überschrift"
                item={data.attention.duplicateTitleHeadings}
              />
            </ul>
          </section>
        ) : null}
      </div>

      {data.databases.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="overview-databases">
          <SectionRule>
            <span id="overview-databases">Datenbanken</span>
          </SectionRule>
          <div className="flex flex-wrap gap-2">
            {data.databases.map((database) => (
              <DatabaseChip key={database.id} workspaceId={workspaceId} database={database} />
            ))}
          </div>
        </section>
      ) : null}

      {data.sections.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="overview-sections">
          <SectionRule>
            <span id="overview-sections">Bereiche</span>
          </SectionRule>
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {data.sections.map((section) => (
              <SectionRow key={section.id} workspaceId={workspaceId} section={section} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
