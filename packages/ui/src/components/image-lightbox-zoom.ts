'use client';

import * as React from 'react';

/**
 * The zoom and pan behind `ImageLightbox` (issue #134): the geometry as pure
 * functions, and one hook that turns pointer, wheel and key input into it.
 *
 * A view is a scale in natural pixels plus the offset of the image's centre
 * from the viewport's centre. The image is drawn at its natural size and
 * transformed, so a 6000-pixel photograph and a 40-pixel icon take the same
 * path.
 */

/** How far past the fit a picture may be enlarged, and never less than this in natural pixels. */
const MAX_ZOOM_OVER_FIT = 8;
const MIN_MAX_SCALE = 4;
/** One button press or key stroke. */
export const ZOOM_STEP = 1.5;
/** A pointer that moved less than this between down and up clicked. */
const CLICK_SLOP = 4;
/**
 * A press this soon after opening never closes. A double click on an image
 * can open the lightbox with its first click, and the second one then lands
 * on the dark area beside the picture.
 */
const OPEN_GRACE_MS = 500;

export interface Size {
  width: number;
  height: number;
}

export interface View {
  /** Display scale in natural pixels: 1 shows the image at its own size. */
  scale: number;
  /** Offset of the image centre from the viewport centre, in screen pixels. */
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

/** The scale at which the whole image fits, never above its natural size. */
export function fitScale(image: Size, viewport: Size): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }
  return Math.min(1, viewport.width / image.width, viewport.height / image.height);
}

/** The largest scale a zoom may reach for an image whose fit is `fit`. */
export function maxScale(fit: number): number {
  return Math.max(MIN_MAX_SCALE, fit * MAX_ZOOM_OVER_FIT);
}

/** Moves the view so no edge of the image comes loose from the viewport's edge. */
export function clampView(view: View, image: Size, viewport: Size): View {
  const slackX = Math.max(0, (image.width * view.scale - viewport.width) / 2);
  const slackY = Math.max(0, (image.height * view.scale - viewport.height) / 2);
  return {
    scale: view.scale,
    x: Math.min(slackX, Math.max(-slackX, view.x)),
    y: Math.min(slackY, Math.max(-slackY, view.y)),
  };
}

/**
 * Zooms to `scale` while keeping the point under `focus` (relative to the
 * viewport centre) where it is, which is what makes a wheel zoom follow the
 * cursor and a pinch follow the fingers.
 */
export function zoomAt(view: View, scale: number, focus: Point, image: Size, viewport: Size): View {
  const fit = fitScale(image, viewport);
  const next = Math.min(maxScale(fit), Math.max(fit, scale));
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: focus.x - (focus.x - view.x) * ratio,
      y: focus.y - (focus.y - view.y) * ratio,
    },
    image,
    viewport,
  );
}

interface Gesture {
  pointers: Map<number, Point>;
  /** Where the first pointer went down, to tell a click from a drag. */
  start: Point | null;
  /** The press can no longer be a click: it moved, or came too soon after opening. */
  moved: boolean;
  /** Distance and midpoint of two touching fingers at the last move. */
  pinch: { distance: number; mid: Point } | null;
}

function pinchOf(pointers: Map<number, Point>): Gesture['pinch'] {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return null;
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/**
 * The state of one open picture. Both the measured size and the view are
 * stored with the key they belong to (the address, and the address plus its
 * fit), and read back as absent when the key moved on: a new picture starts
 * unmeasured and a new fit starts fitted, without an effect resetting them.
 */
export function useZoomPan(src: string | null, onBackgroundClick: () => void) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState<Size>({ width: 0, height: 0 });
  const [measured, setMeasured] = React.useState<{ src: string; size: Size } | null>(null);
  const [stored, setStored] = React.useState<{ key: string; view: View } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const gesture = React.useRef<Gesture>({
    pointers: new Map(),
    start: null,
    moved: false,
    pinch: null,
  });
  const openedAt = React.useRef(0);

  React.useEffect(() => {
    openedAt.current = performance.now();
  }, [src]);

  const natural = measured !== null && measured.src === src ? measured.size : null;
  const fit = natural === null ? 1 : fitScale(natural, viewport);
  const key = `${src ?? ''}|${fit}`;
  const view = stored !== null && stored.key === key ? stored.view : { scale: fit, x: 0, y: 0 };

  /** Applies `change` to the view the reader currently sees. */
  const update = (change: (current: View, image: Size) => View) => {
    if (natural === null) return;
    setStored((previous) => {
      const current =
        previous !== null && previous.key === key ? previous.view : { scale: fit, x: 0, y: 0 };
      return { key, view: change(current, natural) };
    });
  };

  const zoomTo = (scale: number, focus: Point = { x: 0, y: 0 }) =>
    update((current, image) => zoomAt(current, scale, focus, image, viewport));
  const zoomBy = (factor: number, focus?: Point) =>
    update((current, image) =>
      zoomAt(current, current.scale * factor, focus ?? { x: 0, y: 0 }, image, viewport),
    );
  const panBy = (dx: number, dy: number) =>
    update((current, image) =>
      clampView({ ...current, x: current.x + dx, y: current.y + dy }, image, viewport),
    );

  /** A client coordinate relative to the viewport's centre. */
  const fromCentre = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  // `ctrlKey` is how a trackpad pinch arrives, with much smaller deltas.
  const wheelHandler = React.useRef<(event: WheelEvent) => void>(() => undefined);
  React.useLayoutEffect(() => {
    wheelHandler.current = (event) => {
      event.preventDefault();
      const speed = event.ctrlKey ? 0.01 : 0.002;
      zoomBy(Math.exp(-event.deltaY * speed), fromCentre(event.clientX, event.clientY));
    };
  });

  // The viewport is measured rather than read from `window`, because the
  // popup is the area the image lives in, and a phone's toolbar changes it.
  const measureViewport = React.useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    // Registered by hand: React's wheel listener is passive, and a passive
    // listener cannot stop the page behind from receiving the wheel. Here and
    // not in an effect, because the portal mounts the element a render late.
    const onWheel = (event: WheelEvent) => wheelHandler.current(event);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  /** Whether a client point lies on the picture, asked geometrically because the pointer capture retargets every event. */
  const onImage = (clientX: number, clientY: number): boolean => {
    if (natural === null) return false;
    const point = fromCentre(clientX, clientY);
    return (
      Math.abs(point.x - view.x) <= (natural.width * view.scale) / 2 &&
      Math.abs(point.y - view.y) <= (natural.height * view.scale) / 2
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    // Controls handle their own clicks.
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    const state = gesture.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 1) {
      state.start = { x: event.clientX, y: event.clientY };
      state.moved = event.timeStamp - openedAt.current < OPEN_GRACE_MS;
    }
    state.pinch = pinchOf(state.pointers);
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    const previous = state.pointers.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    state.pointers.set(event.pointerId, current);
    if (
      state.start !== null &&
      Math.hypot(current.x - state.start.x, current.y - state.start.y) > CLICK_SLOP
    ) {
      state.moved = true;
    }
    if (state.pointers.size < 2) {
      panBy(current.x - previous.x, current.y - previous.y);
      return;
    }
    const next = pinchOf(state.pointers);
    const last = state.pinch;
    state.pinch = next;
    if (next === null || last === null || last.distance === 0) return;
    const focus = fromCentre(next.mid.x, next.mid.y);
    update((view, image) => {
      const zoomed = zoomAt(
        view,
        view.scale * (next.distance / last.distance),
        focus,
        image,
        viewport,
      );
      const moved = {
        ...zoomed,
        x: zoomed.x + next.mid.x - last.mid.x,
        y: zoomed.y + next.mid.y - last.mid.y,
      };
      return clampView(moved, image, viewport);
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state.pointers.delete(event.pointerId)) return;
    state.pinch = pinchOf(state.pointers);
    if (state.pointers.size > 0) return;
    setDragging(false);
    const clicked = !state.moved && event.type === 'pointerup';
    state.start = null;
    // A click on the dark area around the picture closes, a click on the
    // picture does nothing, and a drag that ended anywhere was a pan.
    if (clicked && !onImage(event.clientX, event.clientY)) onBackgroundClick();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onImage(event.clientX, event.clientY)) return;
    // Toggles between the fit and a close look at the point clicked.
    const zoomed = view.scale > fit * 1.01;
    zoomTo(zoomed ? fit : fit * ZOOM_STEP * ZOOM_STEP, fromCentre(event.clientX, event.clientY));
  };

  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (src === null) return;
    const img = event.currentTarget;
    setMeasured({ src, size: { width: img.naturalWidth, height: img.naturalHeight } });
  };

  const pannable =
    natural !== null &&
    (natural.width * view.scale > viewport.width + 1 ||
      natural.height * view.scale > viewport.height + 1);

  return {
    natural,
    fit,
    view,
    dragging,
    pannable,
    atFit: view.scale <= fit * 1.001,
    atMax: view.scale >= maxScale(fit) * 0.999,
    centred: view.x === 0 && view.y === 0,
    zoomTo,
    zoomBy,
    panBy,
    onLoad,
    viewportProps: {
      ref: measureViewport,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick,
    },
  };
}
