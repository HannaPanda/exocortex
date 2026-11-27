'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseRow, type UploadAttachmentResponse } from '@exocortex/contracts';

import { ApiError, uploadRequestWithProgress } from '@/lib/api/client';
import { invalidateDatabaseAfterEvent } from '@/lib/api/database-queries';
import { useFormatter } from '@/lib/formatter';

/** A file on its way into a FILES cell, or one that did not get there (issue #245). */
export interface PendingCellFile {
  /** Local, so a chip has a key before the server has answered. */
  localId: string;
  name: string;
  /** Share of the bytes sent, 0 to 1. */
  progress: number;
  /** The sentence for a failed upload; null while it is still going. */
  error: string | null;
}

export interface CellUploads {
  pending: readonly PendingCellFile[];
  /** Chosen, dropped or pasted files; each one goes up on its own. */
  add: (files: readonly File[]) => void;
  /** Takes a failed upload's notice away. */
  dismiss: (localId: string) => void;
}

type SetPending = React.Dispatch<React.SetStateAction<PendingCellFile[]>>;

/** Changes one pending entry, by its local id. */
function patchEntry(setPending: SetPending, localId: string, patch: Partial<PendingCellFile>) {
  setPending((current) =>
    current.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry)),
  );
}

function dropEntry(setPending: SetPending, localId: string) {
  setPending((current) => current.filter((entry) => entry.localId !== localId));
}

let counter = 0;
function nextLocalId(): string {
  counter += 1;
  return `cell-file-${String(counter)}`;
}

function maxBytesOf(error: ApiError): number | null {
  const details = error.details as { maxBytes?: unknown } | null | undefined;
  return typeof details?.maxBytes === 'number' ? details.maxBytes : null;
}

/**
 * Uploads into one FILES cell of one row (issue #245).
 *
 * Every file goes to the ordinary upload route with the row as its page and
 * the column as `propertyId`, so the server checks it like any upload (size,
 * type read from the bytes, the right to edit the row) and appends it to the
 * cell itself. The cell does not write its own value afterwards: two files
 * dropped at once would otherwise race each other's list. When one arrives
 * the row is read again, the way an edit from another tab arrives.
 */
export function useCellUploads(input: {
  row: DatabaseRow | undefined;
  propertyId: string;
}): CellUploads {
  const t = useTranslations('database.files');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<PendingCellFile[]>([]);
  const { row, propertyId } = input;

  const failure = React.useCallback(
    (name: string, caught: unknown): string => {
      if (!(caught instanceof ApiError)) return t('failed', { name, reason: t('failedPlain') });
      if (caught.code === 'payload_too_large') {
        const max = maxBytesOf(caught);
        return max === null
          ? t('tooLargePlain', { name })
          : t('tooLarge', {
              name,
              limit: format.number(max / 1_000_000, { maximumFractionDigits: 1 }),
            });
      }
      if (caught.code === 'unsupported_media_type') return t('typeRefused', { name });
      if (caught.status === 0) return t('offline', { name });
      return t('failed', { name, reason: caught.message });
    },
    [format, t],
  );

  const send = React.useCallback(
    async (target: DatabaseRow, file: File) => {
      const localId = nextLocalId();
      setPending((current) => [...current, { localId, name: file.name, progress: 0, error: null }]);
      const form = new FormData();
      // The page and the column before the file part: the server reads the
      // fields it has seen when the file starts.
      form.append('documentId', target.document.id);
      form.append('propertyId', propertyId);
      form.append('file', file, file.name);
      try {
        await uploadRequestWithProgress<UploadAttachmentResponse>(
          `/api/workspaces/${target.document.workspaceId}/attachments`,
          form,
          (progress) => patchEntry(setPending, localId, { progress }),
        );
      } catch (caught) {
        patchEntry(setPending, localId, { error: failure(file.name, caught) });
        return;
      }
      dropEntry(setPending, localId);
      if (target.document.parentId !== null) {
        invalidateDatabaseAfterEvent(queryClient, {
          kind: 'row',
          documentId: target.document.parentId,
        });
      }
    },
    [failure, propertyId, queryClient],
  );

  const add = React.useCallback(
    (files: readonly File[]) => {
      if (row === undefined) return;
      for (const file of files) void send(row, file);
    },
    [row, send],
  );

  const dismiss = React.useCallback((localId: string) => dropEntry(setPending, localId), []);

  return { pending, add, dismiss };
}
