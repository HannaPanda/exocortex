'use client';

import * as React from 'react';

import { ImageLightbox } from '@exocortex/ui';

/**
 * The one place that decides which click opens an embedded image in the
 * lightbox (issue #134), so no renderer carries lightbox logic of its own.
 *
 * Wraps a piece of content and listens for clicks on `img[data-zoomable]`
 * inside it. Two renderers mark their images that way: the image node of the
 * editor (`packages/editor/src/extensions.ts`), in the page itself as well as
 * in a transcluded fragment, and `ReadingMarkdown` on a shared page, where the
 * image sits in a button so a keyboard can open it too.
 *
 * In an editor somebody is writing in, a click on an image selects it, and
 * that selection is how an image is deleted or dragged. So there the first
 * click only selects, and a second click on the selected image, or a double
 * click, opens it. A read-only editor opens on the first click.
 */
export function ImageLightboxArea({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [image, setImage] = React.useState<{ src: string; alt: string } | null>(null);
  // The image that was already selected when the pointer went down: by the
  // time `click` fires, ProseMirror has already selected the clicked one.
  const selectedOnPress = React.useRef<HTMLImageElement | null>(null);

  const open = (img: HTMLImageElement) => {
    const src = img.currentSrc || img.src;
    if (src.length === 0) return;
    setImage({ src, alt: img.alt });
  };

  const onPointerDownCapture = (event: React.PointerEvent) => {
    const img = zoomableImage(event.target);
    selectedOnPress.current = img?.classList.contains('ProseMirror-selectednode') ? img : null;
  };

  const onClick = (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const img = zoomableImage(event.target);
    if (img === null) return;
    if (!inWritableEditor(img) || selectedOnPress.current === img) open(img);
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const img = zoomableImage(event.target);
    if (img !== null && inWritableEditor(img)) open(img);
  };

  return (
    <div
      className={className}
      onPointerDownCapture={onPointerDownCapture}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {children}
      <ImageLightbox image={image} onClose={() => setImage(null)} />
    </div>
  );
}

/** The zoomable image a click landed on, directly or through the button around it. */
function zoomableImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLImageElement) return target.matches('[data-zoomable]') ? target : null;
  const trigger = target.closest('[data-zoomable-trigger]');
  const img = trigger?.querySelector('img[data-zoomable]');
  return img instanceof HTMLImageElement ? img : null;
}

/** Whether the image belongs to an editor that accepts typing, as opposed to a read-only one. */
function inWritableEditor(img: HTMLImageElement): boolean {
  const editor = img.closest('.ProseMirror');
  return editor instanceof HTMLElement && editor.isContentEditable;
}
