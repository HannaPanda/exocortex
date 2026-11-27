'use client';

import { Loader2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { type PendingChatFile } from './use-chat-attachments';

/**
 * A picture that goes with the next message (issue #223), drawn like the
 * selection chip beside it: it is sent once and is gone after, and the cross
 * takes it away before that. The thumbnail is the file itself, so it shows
 * while the upload is still on its way.
 */
export function ChatFileChip({
  file,
  onRemove,
  disabled,
}: {
  file: PendingChatFile;
  onRemove: () => void;
  disabled: boolean;
}) {
  const t = useTranslations('ai.context');
  const uploading = file.status === 'uploading';
  return (
    <Badge
      variant="outline"
      className="max-w-full gap-1 py-0.5 pr-1 pl-0.5"
      data-testid="ai-file-chip"
      data-status={file.status}
    >
      {/* oxlint-disable-next-line nextjs/no-img-element --
          an object URL of a file in the browser, which no loader can serve. */}
      <img
        src={file.previewUrl}
        alt=""
        className="size-5 shrink-0 rounded-sm object-cover"
        aria-hidden
      />
      <span className="min-w-0 truncate" title={t('fileOnce')}>
        {uploading ? t('fileUploading', { name: file.name }) : t('file', { name: file.name })}
      </span>
      {uploading ? (
        <Loader2Icon aria-hidden className="shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-4 shrink-0 rounded-sm"
              aria-label={t('fileRemove', { name: file.name })}
              data-testid="ai-file-remove"
              disabled={disabled}
              onClick={onRemove}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipContent>{t('doNotSend')}</TooltipContent>
      </Tooltip>
    </Badge>
  );
}
