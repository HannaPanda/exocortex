'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiChatAttachment } from '@exocortex/contracts';
import { ImageLightbox, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

/**
 * The pictures a question was sent with (issue #223), above its bubble and
 * still there after a reload, because they are read from the message rather
 * than from the composer. A click opens the picture large; the tooltip says
 * what the assistant was told about it, which is all it ever saw.
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

/**
 * Why reading this picture stops the assistant from changing anything
 * (ADR-096): a finding, or a check that could not be made. A clean picture
 * needs no sentence.
 */
function ScreeningNote({ screening }: { screening: AiChatAttachment['screening'] }) {
  const t = useTranslations('ai.message');
  if (screening === 'clean') return null;
  return (
    <span className="mt-1 block" data-testid="ai-question-picture-screening">
      {t(screening === 'flagged' ? 'attachmentFlagged' : 'attachmentUnscreened')}
    </span>
  );
}
