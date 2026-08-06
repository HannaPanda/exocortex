import sharp from 'sharp';

/**
 * Downscaled copies of uploaded images.
 *
 * A page cover is drawn at roughly 2560×270 CSS pixels at most, and an image
 * block never exceeds the page measure. Serving the 12-megapixel original for
 * that wastes the reader's bandwidth on every single page view, so an upload
 * that is meaningfully larger than it will ever be shown gets a second, small
 * object stored next to it. The original is kept: it is the file the user
 * uploaded, and the preview is derived data that may be rebuilt at any time.
 *
 * Re-encoding also strips EXIF, which means a photo's GPS coordinates never
 * reach the browser through the preview.
 */

/** Longest edge of a preview, in pixels. Covers a 2× retina full-width cover. */
const MAX_EDGE_PIXELS = 2_048;

/**
 * Originals below this stay alone. Re-encoding a 90 KB screenshot buys nothing
 * and costs an object, a column and a request.
 */
const MIN_ORIGINAL_BYTES = 400 * 1_024;

/**
 * Types worth downscaling.
 *
 * `image/svg+xml` is vector and already tiny. GIF and animated WebP are left
 * alone because a single-frame resize would silently drop the animation, and a
 * multi-frame resize is expensive for no gain at these sizes.
 */
const PREVIEWABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

export interface ImagePreview {
  body: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
}

/** `true` when `createImagePreview` would consider this type at all. */
export function isPreviewableImage(mimeType: string): boolean {
  return PREVIEWABLE_MIME_TYPES.has(mimeType);
}

/**
 * Returns a downscaled WebP copy, or `null` when the original is already small
 * enough, is not a previewable image, or cannot be decoded.
 *
 * Never throws: a preview is an optimization, and an upload must not fail
 * because a decoder disliked the file. The caller stores the original either
 * way and treats `null` as "serve the original", and gets the swallowed error
 * through `onError` so it can still be logged.
 */
export async function createImagePreview(
  body: Buffer,
  mimeType: string,
  options?: { onError?: (error: unknown) => void },
): Promise<ImagePreview | null> {
  if (!isPreviewableImage(mimeType)) return null;
  if (body.byteLength < MIN_ORIGINAL_BYTES) return null;

  try {
    const pipeline = sharp(body, { failOn: 'error' });
    const metadata = await pipeline.metadata();
    if (metadata.width === undefined || metadata.height === undefined) return null;
    if (metadata.pages !== undefined && metadata.pages > 1) return null;

    const { data, info } = await pipeline
      .rotate() // Applies the EXIF orientation before the tag is dropped.
      .resize({
        width: MAX_EDGE_PIXELS,
        height: MAX_EDGE_PIXELS,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    // A preview that is not actually smaller is not a preview.
    if (data.byteLength >= body.byteLength) return null;

    return {
      body: data,
      mimeType: 'image/webp',
      extension: 'webp',
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    options?.onError?.(error);
    return null;
  }
}
