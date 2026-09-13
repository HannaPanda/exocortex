'use client';

import Link from 'next/link';
import * as React from 'react';

import {
  type RenderJob,
  type RenderSource,
  type RenderTemplate,
  type RenderVariable,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCancelRender,
  useRenderJob,
  useRenderJobLog,
  useRenderJobs,
  useRenderTemplates,
  useStartRender,
} from '@/lib/api/render-queries';

import {
  formatBytes,
  RENDER_SOURCE_LABELS,
  RENDER_STATUS_LABELS,
  renderStatusVariant,
} from './render-labels';

/**
 * Publishing the open page as a PDF (issue #44, ADR-026).
 *
 * The dialog is the whole loop in one place, because the loop is what people
 * actually do: pick a template, fill in what the template asks for, build,
 * watch it, open the file -- or read why it failed and try again. Splitting the
 * result onto a second screen would mean the log is somewhere the person who
 * just pressed the button is not.
 *
 * It never touches the page. A PDF is derived from the page's Markdown; the
 * canonical Yjs state is not involved at any point (ADR-007).
 */
export function PageRenderDialog({
  workspaceId,
  documentId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<RenderSource>('DOCUMENT');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showLog, setShowLog] = React.useState(false);

  const model = useRenderModel({ workspaceId, documentId, open, jobId, templateId, showLog });
  const start = useStartRender(workspaceId);
  const cancel = useCancelRender();

  const build = async (): Promise<void> => {
    if (model.templateId === null) return;
    setError(null);
    setShowLog(false);
    try {
      const result = await start.mutateAsync({
        documentId,
        request: {
          templateId: model.templateId,
          source,
          variables: values,
          force: model.rebuilding,
        },
      });
      setJobId(result.job.id);
    } catch (cause) {
      setError(startFailureMessage(cause));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Als PDF veröffentlichen</DialogTitle>
          <DialogDescription>
            Der Inhalt dieser Seite wird mit einer Vorlage gesetzt. Die Seite selbst bleibt
            unverändert.
          </DialogDescription>
        </DialogHeader>

        <RenderNotices
          loaded={model.loaded}
          enabled={model.enabled}
          templateCount={model.templates.length}
        />

        <RenderForm
          templates={model.templates}
          templateId={model.templateId}
          template={model.template}
          source={source}
          values={values}
          onTemplateChange={(value) => {
            setTemplateId(value);
            setValues({});
          }}
          onSourceChange={setSource}
          onValueChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
        />

        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription data-testid="render-error">{error}</AlertDescription>
          </Alert>
        )}

        {model.job === null ? null : (
          <JobPanel
            job={model.job}
            workspaceId={workspaceId}
            log={model.visibleLog}
            onToggleLog={() => setShowLog((previous) => !previous)}
            onCancel={() => void cancel.mutateAsync(model.job?.id ?? '')}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Schließen
          </Button>
          <Button
            data-testid="render-start"
            disabled={
              model.templateId === null || !model.enabled || model.running || start.isPending
            }
            onClick={() => void build()}
          >
            {model.rebuilding ? 'Neu erzeugen' : 'PDF erzeugen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenderModel {
  templates: readonly RenderTemplate[];
  templateId: string | null;
  template: RenderTemplate | null;
  job: RenderJob | null;
  visibleLog: string | null;
  loaded: boolean;
  enabled: boolean;
  running: boolean;
  /** A finished build is on screen, so the button offers to build it again. */
  rebuilding: boolean;
}

/**
 * Everything the dialog reads, in one place.
 *
 * A hook rather than four `useQuery` calls in the component: what the dialog
 * shows is derived from four answers that arrive at different times, and the
 * derivation is the part worth reading on its own.
 */
function useRenderModel(input: {
  workspaceId: string;
  documentId: string;
  open: boolean;
  jobId: string | null;
  templateId: string | null;
  showLog: boolean;
}): RenderModel {
  const templates = useRenderTemplates(input.open ? input.workspaceId : undefined);
  const history = useRenderJobs(input.open ? input.workspaceId : undefined, input.documentId);
  const job = useRenderJob(input.jobId);
  const log = useRenderJobLog(input.jobId, input.showLog);

  const list = templates.data?.templates ?? [];
  const templateId = input.templateId ?? preferredTemplateId(list, history.data?.jobs[0] ?? null);
  const current = job.data?.job ?? null;
  const running =
    current !== null && (current.status === 'PENDING' || current.status === 'RUNNING');

  return {
    templates: list,
    templateId,
    template: list.find((entry) => entry.id === templateId) ?? null,
    job: current,
    visibleLog: input.showLog ? (log.data?.log ?? '') : null,
    loaded: templates.isSuccess,
    enabled: templates.data?.enabledForWorkspace ?? false,
    running,
    rebuilding: current !== null && !running,
  };
}

/** Why nothing can be built right now, when that is the case. */
function RenderNotices({
  loaded,
  enabled,
  templateCount,
}: {
  loaded: boolean;
  enabled: boolean;
  templateCount: number;
}) {
  if (!loaded) return null;
  if (!enabled) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Die PDF-Ausgabe ist für diesen Arbeitsbereich abgeschaltet.
        </AlertDescription>
      </Alert>
    );
  }
  if (templateCount === 0) {
    return (
      <Alert>
        <AlertDescription>
          Es gibt noch keine Vorlage. Eine Administratorin legt sie unter „Vorlagen“ im
          Arbeitsbereich an.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

/**
 * The template of this page's last build, so a second PDF is one click.
 *
 * Falls back to the first template, which in most workspaces is the only one.
 */
function preferredTemplateId(
  templates: readonly RenderTemplate[],
  lastJob: RenderJob | null,
): string | null {
  const lastUsed = lastJob?.templateId ?? null;
  if (lastUsed !== null && templates.some((entry) => entry.id === lastUsed)) return lastUsed;
  return templates[0]?.id ?? null;
}

function startFailureMessage(cause: unknown): string {
  if (cause instanceof ApiError)
    return cause.message.length > 0 ? cause.message : messageForCode(cause.code);
  return 'Der Bau ließ sich nicht starten.';
}

/** Template, scope and whatever the template asks a person to type. */
function RenderForm({
  templates,
  templateId,
  template,
  source,
  values,
  onTemplateChange,
  onSourceChange,
  onValueChange,
}: {
  templates: readonly RenderTemplate[];
  templateId: string | null;
  template: RenderTemplate | null;
  source: RenderSource;
  values: Readonly<Record<string, string>>;
  onTemplateChange: (templateId: string) => void;
  onSourceChange: (source: RenderSource) => void;
  onValueChange: (name: string, value: string) => void;
}) {
  const asked = (template?.variables ?? []).filter((variable) => variable.origin === 'MANUAL');
  const description = template?.description ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="render-template">Vorlage</Label>
        <Select value={templateId ?? ''} onValueChange={onTemplateChange}>
          <SelectTrigger id="render-template" data-testid="render-template">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {templates.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description.length === 0 ? null : (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="render-source">Umfang</Label>
        <Select value={source} onValueChange={(value) => onSourceChange(value as RenderSource)}>
          <SelectTrigger id="render-source" data-testid="render-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RENDER_SOURCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {asked.map((variable: RenderVariable) => (
        <div key={variable.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`render-var-${variable.name}`}>
            {variable.label}
            {variable.required ? ' *' : ''}
          </Label>
          <Input
            id={`render-var-${variable.name}`}
            value={values[variable.name] ?? variable.defaultValue ?? ''}
            onChange={(event) => onValueChange(variable.name, event.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/** What became of the build: its status, its file, and its log when it failed. */
function JobPanel({
  job,
  workspaceId,
  log,
  onToggleLog,
  onCancel,
}: {
  job: RenderJob;
  workspaceId: string;
  log: string | null;
  onToggleLog: () => void;
  onCancel: () => void;
}) {
  const running = job.status === 'PENDING' || job.status === 'RUNNING';

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid="render-job"
    >
      <div className="flex items-center gap-2">
        <Badge variant={renderStatusVariant(job.status)}>{RENDER_STATUS_LABELS[job.status]}</Badge>
        {job.stale ? <Badge variant="outline">Seite hat sich geändert</Badge> : null}
        {job.attachmentByteSize === null ? null : (
          <span className="text-xs text-muted-foreground">
            {formatBytes(job.attachmentByteSize)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={onCancel} data-testid="render-cancel">
              Abbrechen
            </Button>
          ) : null}
          {job.attachmentId === null ? null : (
            <Button
              size="sm"
              variant="outline"
              data-testid="render-open"
              render={
                <Link
                  href={`/api/attachments/${job.attachmentId}/download`}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              PDF öffnen
            </Button>
          )}
        </div>
      </div>

      {job.error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      )}

      {job.logTail === null && log === null ? null : (
        <div className="flex flex-col gap-2">
          <Button variant="ghost" size="sm" className="self-start" onClick={onToggleLog}>
            {log === null ? 'Protokoll anzeigen' : 'Protokoll ausblenden'}
          </Button>
          {log === null ? null : (
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
              {log.length === 0 ? '(leer)' : log}
            </pre>
          )}
        </div>
      )}

      {/* The workspace link is the way out of a template problem: the log says
          what is wrong, and fixing it happens where the templates live. */}
      {job.status === 'FAILED' ? (
        <Link
          href={`/arbeitsbereich/${workspaceId}/vorlagen`}
          className="text-xs text-muted-foreground underline"
        >
          Vorlagen bearbeiten
        </Link>
      ) : null}
    </div>
  );
}
