import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { buildAttachmentPreviewKey, createImagePreview, isPreviewableImage } from './index';

/**
 * A noisy image, so the encoders cannot compress it down to nothing and the
 * "is the original actually large" branches are exercised for real.
 */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let index = 0; index < pixels.length; index += 1) {
    // Deterministic pseudo-noise: no random, so a failure is reproducible.
    pixels[index] = (index * 2_654_435_761) % 251;
  }
  return sharp(pixels, { raw: { width, height, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

describe('createImagePreview', () => {
  it('downscales a large image to a smaller WebP', async () => {
    const original = await noisyPng(3_000, 2_000);
    expect(original.byteLength).toBeGreaterThan(400 * 1_024);

    const preview = await createImagePreview(original, 'image/png');

    expect(preview).not.toBeNull();
    expect(preview?.mimeType).toBe('image/webp');
    expect(preview?.extension).toBe('webp');
    // Fitted inside the 2048px box, aspect ratio kept.
    expect(preview?.width).toBe(2_048);
    expect(preview?.height).toBe(1_365);
    expect(preview?.body.byteLength).toBeLessThan(original.byteLength);
  });

  it('leaves a small original alone', async () => {
    const small = await noisyPng(64, 64);
    expect(await createImagePreview(small, 'image/png')).toBeNull();
  });

  it('refuses types it must not re-encode', async () => {
    const large = await noisyPng(3_000, 2_000);
    // An SVG is vector, a GIF may be animated: re-encoding either loses more
    // than it saves.
    expect(await createImagePreview(large, 'image/svg+xml')).toBeNull();
    expect(await createImagePreview(large, 'image/gif')).toBeNull();
    expect(await createImagePreview(large, 'application/pdf')).toBeNull();
  });

  it('reports a broken image instead of throwing', async () => {
    const errors: unknown[] = [];
    const garbage = Buffer.alloc(500 * 1_024, 0x7f);

    const preview = await createImagePreview(garbage, 'image/png', {
      onError: (error) => errors.push(error),
    });

    expect(preview).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('knows which types it would consider', () => {
    expect(isPreviewableImage('image/jpeg')).toBe(true);
    expect(isPreviewableImage('image/gif')).toBe(false);
  });
});

describe('buildAttachmentPreviewKey', () => {
  it('keeps the original key as its prefix', () => {
    expect(
      buildAttachmentPreviewKey({
        storageKey: 'workspaces/ws1/2026/08/att1.png',
        extension: 'webp',
      }),
    ).toBe('workspaces/ws1/2026/08/att1.preview.webp');
  });

  it('refuses an extension it cannot vouch for', () => {
    expect(
      buildAttachmentPreviewKey({
        storageKey: 'workspaces/ws1/2026/08/att1.png',
        extension: '../../etc/passwd',
      }),
    ).toBe('workspaces/ws1/2026/08/att1.preview.bin');
  });
});
