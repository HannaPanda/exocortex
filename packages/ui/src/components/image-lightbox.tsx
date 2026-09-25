'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import * as React from 'react';
import { useFormatter, useTranslations } from 'use-intl';

import { cn } from '../lib/utils';

import { useZoomPan, ZOOM_STEP } from './image-lightbox-zoom';
import { Button } from './ui/button';

/**
 * An image opened over the page to look at its details (issue #134).
 *
 * The image first fits the viewport and is never enlarged past its natural
 * size to do so, because a blurry fit says nothing about the picture. From
 * there it zooms by buttons, wheel, trackpad pinch, touch pinch, double click
 * and the keys `+`, `-` and `0`, and pans by drag, touch or the arrow keys
 * whenever it is larger than the viewport. The pan is clamped so the image
 * never leaves the screen: an edge stops at the edge. The geometry lives in
 * `image-lightbox-zoom.ts`.
 *
 * A dialog built on the same Base UI primitive as `Dialog`, so focus trapping,
 * the scroll lock of the page underneath, `Escape` and returning focus to
 * whatever held it before come from there. The popup covers the whole
 * viewport; a click on its empty area closes, unless the pointer moved in
 * between, since that was a pan and not a click.
 *
 * Deliberately knows nothing about where the image came from: the caller
 * decides what opens it (`apps/web/src/components/document/image-lightbox-area.tsx`
 * does so for every embedded image) and hands over `src` and `alt`.
 */

/** Pixels an arrow key pans. */
const PAN_STEP = 80;

export interface ImageLightboxProps {
  /** The image to show, or `null` while closed. */
  image: { src: string; alt: string } | null;
  onClose: () => void;
}

export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const t = useTranslations('ui.imageLightbox');
  const zoom = useZoomPan(image?.src ?? null, onClose);
  const { natural, view } = zoom;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const keys: Record<string, () => void> = {
      '+': () => zoom.zoomBy(ZOOM_STEP),
      '=': () => zoom.zoomBy(ZOOM_STEP),
      '-': () => zoom.zoomBy(1 / ZOOM_STEP),
      '0': () => zoom.zoomTo(zoom.fit),
      ArrowLeft: () => zoom.panBy(PAN_STEP, 0),
      ArrowRight: () => zoom.panBy(-PAN_STEP, 0),
      ArrowUp: () => zoom.panBy(0, PAN_STEP),
      ArrowDown: () => zoom.panBy(0, -PAN_STEP),
    };
    const action = keys[event.key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  };

  return (
    <DialogPrimitive.Root
      open={image !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="image-lightbox-backdrop"
          className={cn(
            'fixed inset-0 z-50 bg-overlay transition-opacity duration-150',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        />
        <DialogPrimitive.Popup
          data-slot="image-lightbox"
          data-testid="image-lightbox"
          onKeyDown={onKeyDown}
          className={cn(
            'fixed inset-0 z-50 outline-none',
            'transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
          )}
        >
          <DialogPrimitive.Title className="exocortex-sr-only">
            {image !== null && image.alt.trim().length > 0 ? image.alt : t('title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="exocortex-sr-only">
            {t('instructions')}
          </DialogPrimitive.Description>

          <div
            {...zoom.viewportProps}
            data-testid="image-lightbox-viewport"
            className={cn(
              'absolute inset-0 touch-none overflow-hidden select-none',
              zoom.pannable
                ? zoom.dragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-default',
            )}
          >
            {image === null ? null : (
              /* oxlint-disable-next-line nextjs/no-img-element --
                 packages/ui knows no Next.js, and the address is a page's
                 content at runtime, which no loader configuration covers. */
              <img
                key={image.src}
                src={image.src}
                alt={image.alt}
                draggable={false}
                data-testid="image-lightbox-image"
                data-scale={view.scale.toFixed(4)}
                onLoad={zoom.onLoad}
                className={cn(
                  'absolute top-1/2 left-1/2 max-w-none origin-center',
                  natural === null ? 'invisible' : null,
                  zoom.dragging
                    ? null
                    : 'transition-transform duration-150 motion-reduce:transition-none',
                )}
                style={
                  natural === null
                    ? undefined
                    : {
                        width: natural.width,
                        height: natural.height,
                        transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                      }
                }
              />
            )}
          </div>

          <DialogPrimitive.Close
            render={
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-3 right-3 size-11 rounded-full shadow-md"
              />
            }
            aria-label={t('close')}
            data-testid="image-lightbox-close"
          >
            <XIcon className="size-5" />
          </DialogPrimitive.Close>

          <ZoomControls zoom={zoom} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The row at the bottom: out, the current scale, in, and back to the fit.
 * Touch targets are 44 pixels, and the row sits under the picture rather than
 * over its middle, where the details are that somebody zoomed in for.
 */
function ZoomControls({ zoom }: { zoom: ReturnType<typeof useZoomPan> }) {
  const t = useTranslations('ui.imageLightbox');
  const format = useFormatter();
  const ready = zoom.natural !== null;
  const percent = format.number(zoom.view.scale, { style: 'percent', maximumFractionDigits: 0 });
  const control = 'size-11 rounded-full';

  return (
    <div
      role="toolbar"
      aria-label={t('controls')}
      className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <Button
        variant="ghost"
        size="icon"
        className={control}
        aria-label={t('zoomOut')}
        disabled={!ready || zoom.atFit}
        onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
        data-testid="image-lightbox-zoom-out"
      >
        <MinusIcon className="size-5" />
      </Button>
      <output
        aria-live="polite"
        className="min-w-14 text-center text-sm tabular-nums"
        data-testid="image-lightbox-zoom-level"
      >
        {ready ? percent : ''}
      </output>
      <Button
        variant="ghost"
        size="icon"
        className={control}
        aria-label={t('zoomIn')}
        disabled={!ready || zoom.atMax}
        onClick={() => zoom.zoomBy(ZOOM_STEP)}
        data-testid="image-lightbox-zoom-in"
      >
        <PlusIcon className="size-5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={control}
        aria-label={t('fit')}
        disabled={!ready || (zoom.atFit && zoom.centred)}
        onClick={() => zoom.zoomTo(zoom.fit)}
        data-testid="image-lightbox-fit"
      >
        <MaximizeIcon className="size-5" />
      </Button>
    </div>
  );
}
