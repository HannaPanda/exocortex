import sharp from 'sharp';

/**
 * An image attachment made fit for a model to look at (issue #204).
 *
 * Two promises, in this order. A picture that already fits is handed over
 * byte for byte: a screenshot diff is only worth something if every pixel is
 * the one that was stored. A picture that does not fit is scaled down in its
 * own format, and only GIF and AVIF change format, to PNG, because not every
 * model provider accepts them.
 *
 * "Fits" is two limits: the longest edge the caller asked for, and a byte
 * ceiling that keeps one image under what a provider takes per image. When a
 * scaled copy is still over the ceiling (a noisy photograph as PNG), the edge
 * is halved until it fits or the picture would be too small to say anything.
 */

/** Formats passed through untouched when they fit. */
const PASS_THROUGH = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Below this the picture tells a model nothing, so giving up is the honest answer. */
const SMALLEST_USEFUL_EDGE = 256;

export interface AgentImageOptions {
  maxEdge: number;
  maxBytes: number;
}

export interface AgentImage {
  body: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** False only when `body` is the stored file itself. */
  resized: boolean;
}

/** Why the picture could not be handed over. */
export type AgentImageFailure = 'undecodable' | 'too_large';

export class AgentImageError extends Error {
  constructor(public readonly reason: AgentImageFailure) {
    super(reason === 'undecodable' ? 'Image could not be decoded' : 'Image does not fit the limit');
    this.name = 'AgentImageError';
  }
}

function outputTypeOf(mimeType: string): AgentImage['mimeType'] {
  if (mimeType === 'image/jpeg' || mimeType === 'image/webp') return mimeType;
  return 'image/png';
}

async function encode(
  body: Buffer,
  mimeType: AgentImage['mimeType'],
  edge: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  // `animated: false` reads the first frame of a GIF or an animated WebP,
  // which is what a still picture of it is.
  let pipeline = sharp(body, { failOn: 'error', animated: false })
    .rotate() // Applies the EXIF orientation before the tag is dropped.
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  if (mimeType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
  else if (mimeType === 'image/webp') pipeline = pipeline.webp({ quality: 88 });
  else pipeline = pipeline.png({ compressionLevel: 9 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Throws `AgentImageError`; every other failure of the decoder is one too,
 * because a file that sharp cannot read is a file with nothing to show.
 */
export async function renderImageForAgent(
  body: Buffer,
  mimeType: string,
  options: AgentImageOptions,
): Promise<AgentImage> {
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(body, { failOn: 'error', animated: false }).metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
      throw new AgentImageError('undecodable');
    }
    // An EXIF orientation of 5 to 8 turns the picture on its side.
    const sideways = (metadata.orientation ?? 1) >= 5;
    width = sideways ? metadata.height : metadata.width;
    height = sideways ? metadata.width : metadata.height;
  } catch (error) {
    if (error instanceof AgentImageError) throw error;
    throw new AgentImageError('undecodable');
  }

  if (
    PASS_THROUGH.has(mimeType) &&
    Math.max(width, height) <= options.maxEdge &&
    body.byteLength <= options.maxBytes
  ) {
    return {
      body,
      mimeType: outputTypeOf(mimeType),
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      resized: false,
    };
  }

  const outputType = outputTypeOf(mimeType);
  let edge = Math.min(options.maxEdge, Math.max(width, height));
  for (;;) {
    let encoded: { data: Buffer; width: number; height: number };
    try {
      encoded = await encode(body, outputType, edge);
    } catch {
      throw new AgentImageError('undecodable');
    }
    if (encoded.data.byteLength <= options.maxBytes) {
      return {
        body: encoded.data,
        mimeType: outputType,
        width: encoded.width,
        height: encoded.height,
        originalWidth: width,
        originalHeight: height,
        resized: true,
      };
    }
    edge = Math.floor(edge / 2);
    if (edge < SMALLEST_USEFUL_EDGE) throw new AgentImageError('too_large');
  }
}
