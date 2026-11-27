'use client';

import {
  FileIcon,
  Loader2Icon,
  PaperclipIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  attachmentDownloadPath,
  type DatabaseRowFile,
  isAttachmentImageSource,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  ImageLightbox,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { type PropertyCellProps } from './cells';
import { type PendingCellFile, useCellUploads } from './use-cell-uploads';

/** What the picker offers; the server still reads the type from the bytes. */
const FILE_INPUT_ACCEPT = [...ALLOWED_ATTACHMENT_MIME_TYPES, '.md', '.txt', '.json', '.csv'].join(
  ',',
);

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Takes drag, drop and paste of files on the cell for the cell (issue #245).
 *
 * Native listeners rather than React props, because a table can sit inside a
 * page's editor (`databaseEmbed`): ProseMirror listens on the editor's own
 * element, which is below React's root, so it would see a drop on the cell
 * first and put the file into the page's text. A listener on the cell itself
 * stops the event before it gets there.
 */
function useFileZone(
  zone: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onFiles: (files: File[]) => void,
): boolean {
  const [over, setOver] = React.useState(false);
  const onFilesRef = React.useRef(onFiles);
  React.useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  React.useEffect(() => {
    const element = zone.current;
    if (element === null || !enabled) return undefined;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && element.contains(next)) return;
      setOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      onFilesRef.current([...(event.dataTransfer?.files ?? [])]);
    };
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      onFilesRef.current(files);
    };
    element.addEventListener('dragenter', enter);
    element.addEventListener('dragover', enter);
    element.addEventListener('dragleave', leave);
    element.addEventListener('drop', drop);
    element.addEventListener('paste', paste);
    return () => {
      element.removeEventListener('dragenter', enter);
      element.removeEventListener('dragover', enter);
      element.removeEventListener('dragleave', leave);
      element.removeEventListener('drop', drop);
      element.removeEventListener('paste', paste);
    };
  }, [zone, enabled]);

  return over && enabled;
}

/**
 * A FILES cell (issue #245): the files as chips that download, a picture's
 * thumbnail that opens it, a cross that takes a file out of the cell, and a
 * visible way in -- the button, a drop on the cell, or a paste while it has
 * focus. The same cell serves the table, the row sheet, the row's page header
 * and the properties panel.
 *
 * An upload belongs to the cell and nowhere else: it hangs on the row's page,
 * so it ends with the row, but it is never written into the page's text.
 * While files are dragged over it the cell says so in words, because the
 * page below is a drop target too and they are easy to confuse.
 */
export function FilesCell({ property, value, onChange, readOnly, row }: PropertyCellProps) {
  const t = useTranslations('database.files');
  const tCells = useTranslations('database.cells');
  const ids = Array.isArray(value) ? value : [];
  const known = new Map((row?.files ?? []).map((file) => [file.id, file] as const));
  // Without the row there is nowhere to upload to; the cell then only shows.
  const editable = !readOnly && row !== undefined;
  const uploads = useCellUploads({ row, propertyId: property.id });
  const zone = React.useRef<HTMLDivElement | null>(null);
  const input = React.useRef<HTMLInputElement | null>(null);
  const over = useFileZone(zone, editable, uploads.add);
  const [shown, setShown] = React.useState<{ src: string; alt: string } | null>(null);

  const remove = (id: string): void => {
    const next = ids.filter((entry) => entry !== id);
    onChange(next.length === 0 ? null : next);
  };

  return (
    <div
      ref={zone}
      role="group"
      aria-label={t('zone', { column: property.name })}
      data-testid="files-cell"
      data-drop-active={over ? 'true' : undefined}
      className={cn(
        'relative flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-sm',
        // The drop look of the chat's fields (`chat-starter.tsx`), so a drop target
        // reads the same everywhere.
        over && 'bg-accent/40 outline-2 outline-primary outline-dashed',
      )}
    >
      {ids.map((id) => (
        <FileChip
          key={id}
          id={id}
          file={known.get(id)}
          // Without `files` nothing can be said about an id; with them, an id
          // they do not answer for is a file that is gone.
          missing={row?.files !== undefined && !known.has(id)}
          readOnly={!editable}
          onRemove={() => remove(id)}
          onShow={setShown}
        />
      ))}
      {uploads.pending.map((entry) => (
        <PendingChip key={entry.localId} entry={entry} onDismiss={uploads.dismiss} />
      ))}
      {editable ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size={ids.length === 0 ? 'sm' : 'icon-sm'}
                  className={cn(
                    'text-muted-foreground',
                    ids.length === 0 ? 'h-7 px-1.5 has-[>svg]:px-1.5' : 'size-6',
                  )}
                  aria-label={ids.length === 0 ? undefined : t('add')}
                  data-testid="files-cell-add"
                  onClick={() => input.current?.click()}
                >
                  {ids.length === 0 ? (
                    <>
                      <PaperclipIcon aria-hidden />
                      {t('add')}
                    </>
                  ) : (
                    <PlusIcon aria-hidden />
                  )}
                </Button>
              }
            />
            <TooltipContent>{t('addHint', { column: property.name })}</TooltipContent>
          </Tooltip>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={FILE_INPUT_ACCEPT}
            data-testid="files-cell-input"
            onChange={(event) => {
              uploads.add([...(event.target.files ?? [])]);
              // The same file chosen twice in a row is still a change.
              event.target.value = '';
            }}
          />
        </>
      ) : ids.length === 0 ? (
        <span className="px-0.5 text-muted-foreground">{tCells('empty')}</span>
      ) : null}
      {over ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-accent/90 px-2 text-center text-xs font-medium text-accent-foreground"
        >
          {t('dropHere', { column: property.name })}
        </div>
      ) : null}
      <ImageLightbox image={shown} onClose={() => setShown(null)} />
    </div>
  );
}

function FileChip({
  id,
  file,
  missing,
  readOnly,
  onRemove,
  onShow,
}: {
  id: string;
  file: DatabaseRowFile | undefined;
  missing: boolean;
  readOnly: boolean;
  onRemove: () => void;
  onShow: (image: { src: string; alt: string }) => void;
}) {
  const t = useTranslations('database.files');
  const name = file?.filename ?? (missing ? t('missing') : id);
  const href = attachmentDownloadPath(id);
  const picture = file !== undefined && isAttachmentImageSource(file.mimeType);
  return (
    <Badge
      variant="outline"
      className="max-w-full gap-1 py-0.5 pr-0.5 pl-1 font-normal"
      data-testid="files-cell-file"
      data-missing={missing ? 'true' : undefined}
    >
      {picture ? (
        <button
          type="button"
          className="shrink-0 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={t('show', { name })}
          onClick={() => onShow({ src: href, alt: name })}
        >
          {/* oxlint-disable-next-line nextjs/no-img-element -- an uploaded attachment, which next/image cannot know at build time. */}
          <img
            src={`${href}?variant=preview`}
            alt=""
            width={20}
            height={20}
            className="size-5 rounded-sm object-cover"
            loading="lazy"
          />
        </button>
      ) : missing ? (
        <TriangleAlertIcon aria-hidden className="shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon aria-hidden className="shrink-0 text-muted-foreground" />
      )}
      {missing ? (
        <span className="min-w-0 truncate text-muted-foreground">{name}</span>
      ) : (
        <a
          href={href}
          download={name}
          title={t('download', { name })}
          className="min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          data-testid="files-cell-download"
        >
          {name}
        </a>
      )}
      {readOnly ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5 shrink-0 rounded-sm"
          aria-label={t('remove', { name })}
          data-testid="files-cell-remove"
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      )}
    </Badge>
  );
}

function PendingChip({
  entry,
  onDismiss,
}: {
  entry: PendingCellFile;
  onDismiss: (localId: string) => void;
}) {
  const t = useTranslations('database.files');
  if (entry.error !== null) {
    return (
      <Badge
        variant="outline"
        role="alert"
        className="max-w-full gap-1 border-destructive py-0.5 pr-0.5 pl-1 font-normal whitespace-normal text-destructive-text"
        data-testid="files-cell-error"
      >
        <TriangleAlertIcon aria-hidden className="shrink-0" />
        <span className="min-w-0">{entry.error}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5 shrink-0 rounded-sm"
          aria-label={t('dismiss')}
          onClick={() => onDismiss(entry.localId)}
        >
          <XIcon />
        </Button>
      </Badge>
    );
  }
  const percent = Math.round(entry.progress * 100);
  return (
    <Badge
      variant="outline"
      className="max-w-full gap-1 py-0.5 pr-1.5 pl-1 font-normal text-muted-foreground"
      data-testid="files-cell-uploading"
    >
      <Loader2Icon aria-hidden className="shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{entry.name}</span>
      <span
        role="progressbar"
        aria-label={t('uploading', { name: entry.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="shrink-0 tabular-nums"
      >
        {t('percent', { percent })}
      </span>
    </Badge>
  );
}
