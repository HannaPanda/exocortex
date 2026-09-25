'use client';

import { AlertTriangleIcon, DownloadIcon, FileTextIcon, XCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type ProjectBuild,
  projectBuildErrorKey,
  type ProjectDiagnostic,
  type ProjectSourceArea,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  LoadingState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exocortex/ui';

import { PdfView } from '@/components/pdf/pdf-view';
import { useProjectBuildDiagnostics, useProjectBuildLog } from '@/lib/api/project-queries';

import { ProjectBuildHistory, useBuildStatusLabel } from './project-build-history';

/**
 * The right-hand half of a project: the PDF, the errors and the log
 * (issue #43, ADR-027).
 *
 * The pages are drawn by pdf.js rather than shown in the browser's own viewer,
 * and the whole reason is the click (issue #53): an `<object>` will not say
 * where it was clicked, so the SyncTeX map beside the file answers a question
 * nobody can ask. With our own pages, a click on a line of the result opens the
 * source line that produced it, and the caret in the source marks its place
 * here.
 *
 * The error list is the other half, and the one that matters more while
 * writing: a diagnostic carries a file and a line, and clicking it opens that
 * file at that line. The same list is what an agent reads.
 */

interface ProjectBuildPanelProps {
  build: ProjectBuild | null;
  builds: readonly ProjectBuild[];
  /** Where the caret in the source pane ended up on paper (issue #53). */
  highlights: readonly ProjectSourceArea[];
  /** Why the last click in the PDF had no answer, in the reader's language, or null. */
  pickError: string | null;
  onOpenDiagnostic: (file: string, line: number | null) => void;
  onPickSource: (position: { page: number; x: number; y: number }) => void;
  onSelectBuild: (buildId: string) => void;
  onDeleteBuild: (buildId: string) => void;
}

export function ProjectBuildPanel({
  build,
  builds,
  highlights,
  pickError,
  onOpenDiagnostic,
  onPickSource,
  onSelectBuild,
  onDeleteBuild,
}: ProjectBuildPanelProps) {
  const t = useTranslations('projects.panel');
  if (build === null) {
    return <EmptyState title={t('notBuiltTitle')} description={t('notBuiltDescription')} />;
  }
  // Keyed on the build, so the tab a previous run ended on does not carry over
  // to the next one -- it says nothing about it. Picking a build out of the
  // history is the same move: it lands on that build's own first tab.
  return (
    <BuildPanel
      key={build.id}
      build={build}
      builds={builds}
      highlights={highlights}
      pickError={pickError}
      onOpenDiagnostic={onOpenDiagnostic}
      onPickSource={onPickSource}
      onSelectBuild={onSelectBuild}
      onDeleteBuild={onDeleteBuild}
    />
  );
}

function BuildPanel({
  build,
  builds,
  highlights,
  pickError,
  onOpenDiagnostic,
  onPickSource,
  onSelectBuild,
  onDeleteBuild,
}: {
  build: ProjectBuild;
  builds: readonly ProjectBuild[];
  highlights: readonly ProjectSourceArea[];
  pickError: string | null;
  onOpenDiagnostic: (file: string, line: number | null) => void;
  onPickSource: (position: { page: number; x: number; y: number }) => void;
  onSelectBuild: (buildId: string) => void;
  onDeleteBuild: (buildId: string) => void;
}) {
  /**
   * `null` means "whatever the build's state suggests".
   *
   * Derived rather than corrected in an effect: a failed build should open on
   * the error list, and setting that from an effect would render the PDF pane
   * first and then replace it -- a flash of the previous run's file under a red
   * status line, which reads as "it worked".
   */
  const t = useTranslations('projects.panel.tabs');
  const tError = useTranslations('projects.buildErrors');
  // From the code rather than `build.error`, which is in the requester's
  // language and not necessarily this reader's (ADR-062).
  const errorKey = projectBuildErrorKey(build.errorCode);
  const [chosenTab, setChosenTab] = React.useState<string | null>(null);
  const running = build.status === 'PENDING' || build.status === 'RUNNING';
  const tab = chosenTab ?? (build.status === 'FAILED' ? 'errors' : 'pdf');

  const diagnostics = useProjectBuildDiagnostics(build.id, !running);
  const entries = diagnostics.data?.diagnostics ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BuildHeader build={build} />

      {errorKey === null ? null : (
        <p className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {tError(errorKey)}
        </p>
      )}

      <Tabs value={tab} onValueChange={setChosenTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 mt-2 self-start">
          <TabsTrigger value="pdf">{t('pdf')}</TabsTrigger>
          <TabsTrigger value="errors">
            {entries.length === 0 ? t('errors') : t('errorsWithCount', { count: entries.length })}
          </TabsTrigger>
          <TabsTrigger value="log">{t('log')}</TabsTrigger>
          <TabsTrigger value="history" data-testid="project-build-history-tab">
            {t('history')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pdf" className="min-h-0 flex-1 pt-2">
          <PdfPane
            running={running}
            downloadPath={build.downloadPath}
            hasSourceMap={build.sourceMapAttachmentId !== null}
            highlights={highlights}
            pickError={pickError}
            onPickSource={onPickSource}
          />
        </TabsContent>

        <TabsContent value="errors" className="min-h-0 flex-1 overflow-y-auto p-3 pt-2">
          <ErrorPane running={running} entries={entries} onOpen={onOpenDiagnostic} />
        </TabsContent>

        <TabsContent value="log" className="min-h-0 flex-1 overflow-auto p-3 pt-2">
          <LogPane buildId={build.id} enabled={tab === 'log'} />
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-3 pt-2">
          <ProjectBuildHistory
            builds={builds}
            selectedBuildId={build.id}
            onSelect={onSelectBuild}
            onDelete={onDeleteBuild}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The raw log. Fetched only while its tab is the one being looked at. */
function LogPane({ buildId, enabled }: { buildId: string; enabled: boolean }) {
  const t = useTranslations('projects.panel');
  const log = useProjectBuildLog(buildId, enabled);
  if (log.data === undefined) return <LoadingState label={t('logLoading')} />;
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted-foreground">
      {log.data.log.length === 0 ? t('noLog') : log.data.log}
    </pre>
  );
}

/** Status, counts and the download, in one line. */
function BuildHeader({ build }: { build: ProjectBuild }) {
  const t = useTranslations('projects.panel');
  const statusLabel = useBuildStatusLabel();
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Badge variant={build.status === 'FAILED' ? 'destructive' : 'secondary'}>
        {statusLabel(build.status)}
      </Badge>
      {build.stale ? <Badge variant="outline">{t('stale')}</Badge> : null}
      {build.errorCount > 0 ? (
        <span className="text-xs text-destructive">
          {t('errorCount', { count: build.errorCount })}
        </span>
      ) : null}
      {build.warningCount > 0 ? (
        <span className="text-xs text-muted-foreground">
          {t('warningCount', { count: build.warningCount })}
        </span>
      ) : null}
      {build.pageCount === null ? null : (
        <span className="text-xs text-muted-foreground">
          {t('pageCount', { count: build.pageCount })}
        </span>
      )}
      {build.downloadPath === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto"
          render={<a href={build.downloadPath} download />}
        >
          <DownloadIcon className="size-4" /> {t('download')}
        </Button>
      )}
    </div>
  );
}

/**
 * The finished file, drawn page by page.
 *
 * A build with no SyncTeX map still shows: the map is written by the engine and
 * an old build, or one whose map was too large to keep, simply has none. The
 * pages are the point; the click is what it gains when there is a map.
 */
function PdfPane({
  running,
  downloadPath,
  hasSourceMap,
  highlights,
  pickError,
  onPickSource,
}: {
  running: boolean;
  downloadPath: string | null;
  hasSourceMap: boolean;
  highlights: readonly ProjectSourceArea[];
  pickError: string | null;
  onPickSource: (position: { page: number; x: number; y: number }) => void;
}) {
  const t = useTranslations('projects.panel');
  if (running) return <LoadingState label={t('running')} />;
  if (downloadPath === null) {
    return <EmptyState title={t('noPdfTitle')} description={t('noPdfDescription')} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {pickError === null ? null : (
        <p className="px-3 pb-1 text-xs text-muted-foreground">{pickError}</p>
      )}
      <div className="min-h-0 flex-1">
        <PdfView
          url={downloadPath}
          highlights={hasSourceMap ? highlights : []}
          onPickSource={hasSourceMap ? onPickSource : undefined}
        />
      </div>
    </div>
  );
}

function ErrorPane({
  running,
  entries,
  onOpen,
}: {
  running: boolean;
  entries: readonly ProjectDiagnostic[];
  onOpen: (file: string, line: number | null) => void;
}) {
  const t = useTranslations('projects.panel');
  if (running) return <LoadingState label={t('running')} />;
  if (entries.length === 0) {
    return <EmptyState title={t('noErrorsTitle')} description={t('noErrorsDescription')} />;
  }
  return (
    <ul className="space-y-1" data-testid="project-diagnostics">
      {entries.map((entry, index) => (
        <DiagnosticRow
          key={`${entry.file ?? ''}:${String(entry.line ?? 0)}:${String(index)}`}
          entry={entry}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function DiagnosticRow({
  entry,
  onOpen,
}: {
  entry: ProjectDiagnostic;
  onOpen: (file: string, line: number | null) => void;
}) {
  const clickable = entry.file !== null;
  const Icon =
    entry.severity === 'ERROR'
      ? XCircleIcon
      : entry.severity === 'WARNING'
        ? AlertTriangleIcon
        : FileTextIcon;

  return (
    <li>
      <button
        type="button"
        disabled={!clickable}
        onClick={clickable ? () => onOpen(entry.file as string, entry.line) : undefined}
        className={cn(
          'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-start text-xs',
          clickable ? 'hover:bg-accent' : 'cursor-default',
        )}
      >
        <Icon
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            entry.severity === 'ERROR' ? 'text-destructive' : 'text-muted-foreground',
          )}
        />
        <span className="min-w-0">
          {entry.file === null ? null : (
            <span className="font-mono text-micro text-muted-foreground">
              {entry.file}
              {entry.line === null ? '' : `:${String(entry.line)}`}{' '}
            </span>
          )}
          <span className="break-words">{entry.message}</span>
        </span>
      </button>
    </li>
  );
}
