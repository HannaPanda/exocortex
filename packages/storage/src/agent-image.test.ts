import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AgentImageError, renderImageForAgent } from './index';

async function flatPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

/**
 * Deterministic noise from a xorshift generator, so a PNG of it stays large:
 * PNG's row filters flatten any pattern that is a function of the index.
 */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  let state = 0x9e3779b9;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

const LIMITS = { maxEdge: 1_568, maxBytes: 3_750_000 };

describe('renderImageForAgent', () => {
  it('hands a small PNG over byte for byte', async () => {
    const original = await flatPng(800, 600);
    const image = await renderImageForAgent(original, 'image/png', LIMITS);

    expect(image.resized).toBe(false);
    expect(image.body.equals(original)).toBe(true);
    expect(image).toMatchObject({ mimeType: 'image/png', width: 800, height: 600 });
  });

  it('scales a picture over the edge down in its own format', async () => {
    const original = await sharp(await flatPng(3_000, 1_000))
      .jpeg()
      .toBuffer();
    const image = await renderImageForAgent(original, 'image/jpeg', LIMITS);

    expect(image.resized).toBe(true);
    expect(image).toMatchObject({
      mimeType: 'image/jpeg',
      width: 1_568,
      originalWidth: 3_000,
      originalHeight: 1_000,
    });
    expect((await sharp(image.body).metadata()).format).toBe('jpeg');
  });

  it('turns a GIF into a PNG even when it fits', async () => {
    const gif = await sharp(await flatPng(100, 50))
      .gif()
      .toBuffer();
    const image = await renderImageForAgent(gif, 'image/gif', LIMITS);

    expect(image).toMatchObject({ mimeType: 'image/png', resized: true, width: 100, height: 50 });
  });

  it('halves the edge until the bytes fit', { timeout: 30_000 }, async () => {
    const original = await noisyPng(1_200, 1_200);
    const image = await renderImageForAgent(original, 'image/png', {
      maxEdge: 1_568,
      maxBytes: 600_000,
    });

    expect(image.resized).toBe(true);
    expect(image.body.byteLength).toBeLessThanOrEqual(600_000);
    expect(image.width).toBeLessThan(1_200);
  });

  it('gives up with too_large when even a small copy does not fit', async () => {
    const original = await noisyPng(600, 600);
    await expect(
      renderImageForAgent(original, 'image/png', { maxEdge: 600, maxBytes: 1_000 }),
    ).rejects.toEqual(new AgentImageError('too_large'));
  });

  it('refuses bytes that are no picture', async () => {
    await expect(
      renderImageForAgent(Buffer.from('not an image at all'), 'image/png', LIMITS),
    ).rejects.toMatchObject({ reason: 'undecodable' });
  });
});
