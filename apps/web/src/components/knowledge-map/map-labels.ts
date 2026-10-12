import { CanvasTexture, type Color, LinearFilter, Sprite, SpriteMaterial } from 'three';

import { cssOf } from './map-colors';

/**
 * Height of a label as a share of the canvas height. Fixed on screen rather
 * than in the room: a label sized in world units was unreadable from afar and
 * filled the screen, glowing, once the camera flew up to its point.
 */
const LABEL_HEIGHT = 0.026;
/** Titles longer than this are cut, since a label names a point rather than describing it. */
const MAX_LABEL_CHARS = 38;

/**
 * A page title drawn into a texture and shown as a sprite, which always faces
 * the camera. Built only for the points that need a name at the moment (the
 * hubs, the hovered, the selected, the lit ones), because 800 textures would
 * cost more video memory than the whole rest of the map.
 */
export function makeLabel(text: string, colour: Color): Sprite {
  const title = text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const fontSize = 48;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const font = `500 ${fontSize}px ${family}`;
  if (context !== null) context.font = font;
  const width = Math.ceil((context?.measureText(title).width ?? title.length * 24) + 24);
  canvas.width = width;
  canvas.height = fontSize + 20;
  if (context !== null) {
    context.font = font;
    context.textBaseline = 'middle';
    context.fillStyle = cssOf(colour);
    context.fillText(title, 12, canvas.height / 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // A label is read, not lit: kept out of tone mapping so it stays sharp,
    // and drawn the same size wherever its point is.
    toneMapped: false,
    sizeAttenuation: false,
    depthTest: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set((LABEL_HEIGHT * canvas.width) / canvas.height, LABEL_HEIGHT, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function disposeLabel(sprite: Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
