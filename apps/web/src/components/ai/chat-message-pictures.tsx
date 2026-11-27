'use client';

import { FileTextIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiChatAttachment, isAttachmentImageSource } from '@exocortex/contracts';
import { ImageLightbox, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

/**
 * The pictures and documents a question was sent with (issue #223), above its
 * bubble and still there after a reload, because they are read from the
 * message rather than from the composer. A click opens a picture large and
 * downloads a document; the tooltip says what the assistant was told about
 * the file.
 */
export function ChatMessagePictures({ attachments }: { attachments: readonly AiChatAttachment[] }) {
  const t = useTranslations('ai.message');
  const [open, setOpen] = React.useState<{ src: string; alt: string } | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div
        className="flex max-w-[85%] flex-wrap justify-end gap-1.5"
        data-testid="ai-question-pictures"
      >
        {attachments.map((attachment) => {
          if (!isAttachmentImageSource(attachment.mimeType)) {
            return <ChatMessageDocument key={attachment.id} attachment={attachment} />;
          }
          const src = `/api/attachments/${attachment.id}/download?variant=preview`;
          const alt = attachment.description ?? attachment.filename;
          return (
            <Tooltip key={attachment.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="overflow-hidden rounded-md border border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={t('attachmentOpen', { name: attachment.filename })}
                    data-testid="ai-question-picture"
                    onClick={() => setOpen({ src, alt })}
                  >
                    {/* oxlint-disable-next-line nextjs/no-img-element -- attachment ids are arbitrary user uploads, not build-time-known assets next/image can optimize. */}
                    <img src={src} alt="" className="size-16 object-cover" draggable={false} />
                  </button>
                }
              />
              <TooltipContent className="max-w-xs">
                {attachment.description === null
                  ? t('attachmentNotDescribed', { name: attachment.filename })
                  : t('attachmentDescribed', { description: attachment.description })}
                {attachment.description === null ? null : (
                  <ScreeningNote screening={attachment.screening} />
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <ImageLightbox image={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** A document on a sent question: its name, a download, and whether its text was read. */
function ChatMessageDocument({ attachment }: { attachment: AiChatAttachment }) {
  const t = useTranslations('ai.message');
  const name = attachment.filename;
  const state = attachment.textState;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={`/api/attachments/${attachment.id}/download`}
            className="flex h-8 max-w-48 items-center gap-1.5 rounded-md border border-border px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={t('documentOpen', { name })}
            data-testid="ai-question-document"
            data-text-state={state}
          >
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{name}</span>
          </a>
        }
      />
      <TooltipContent className="max-w-xs">
        {state === 'ready'
          ? t('documentReady', { name })
          : state === 'pending'
            ? t('documentPending', { name })
            : t('documentUnreadable', { name })}
        {state === 'ready' ? <ScreeningNote screening={attachment.screening} document /> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Why reading this file stops the assistant from changing anything
 * (ADR-096): a finding, or a check that could not be made. A clean file
 * needs no sentence.
 */
function ScreeningNote({
  screening,
  document = false,
}: {
  screening: AiChatAttachment['screening'];
  document?: boolean;
}) {
  const t = useTranslations('ai.message');
  if (screening === 'clean') return null;
  const flagged = screening === 'flagged';
  return (
    <span className="mt-1 block" data-testid="ai-question-picture-screening">
      {document
        ? t(flagged ? 'documentFlagged' : 'documentUnscreened')
        : t(flagged ? 'attachmentFlagged' : 'attachmentUnscreened')}
    </span>
  );
}
