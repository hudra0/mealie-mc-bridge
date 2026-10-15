// Turns a recipe photo into the two JPEG variants the Monsieur Cuisine recipe references.

import sharp, { type Metadata } from "sharp";

export const DETAILS_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 800;
export const JPEG_QUALITY = 85;
// A recipe photo larger than this is not decoded: a small file can declare a huge image
// (a decompression bomb), and sharp's own pixel limit is 268 million pixels.
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;

const supportedFormats = new Set(["jpeg", "png", "webp"]);

export interface PreparedRecipeImage {
  details: Buffer;
  thumbnail: Buffer;
}

// Width to height, for example { width: 16, height: 9 }. The cover photo's aspect lives in
// knowledge/device-programs.json (recipeLimits.coverPhoto); DeviceLimits exposes it as
// recipe.coverPhotoAspect.
export interface ImageAspect {
  width: number;
  height: number;
}

export class UnsupportedImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnsupportedImageError";
  }
}

// Decodes JPEG, PNG or WebP, applies the EXIF orientation, crops to the given aspect the
// way the web editor does (keeping the most interesting region), scales to 1600 px
// (details) and 800 px (thumbnail) wide without enlarging, fills transparency with white
// and encodes JPEG at quality 85. Metadata such as GPS positions is not carried over.
export async function prepareRecipeImage(
  bytes: Uint8Array,
  aspect: ImageAspect,
): Promise<PreparedRecipeImage> {
  if (!(aspect.width > 0 && aspect.height > 0)) {
    throw new RangeError(`Invalid image aspect ${aspect.width}:${aspect.height}`);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new UnsupportedImageError(
      `The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB (${Math.ceil(bytes.byteLength / 1024 / 1024)} MB)`,
    );
  }
  let meta: Metadata;
  try {
    // Reads the header only; the pixel count is checked below with a clear message.
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw new UnsupportedImageError("The image could not be decoded", { cause: error });
  }
  const format = meta.format as string | undefined;
  if (format === undefined || !supportedFormats.has(format)) {
    throw new UnsupportedImageError(
      `Unsupported image format ${format ?? "unknown"}; expected JPEG, PNG or WebP`,
    );
  }
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new UnsupportedImageError(
      `The image has ${meta.width ?? 0} x ${meta.height ?? 0} pixels, more than the limit of ${MAX_IMAGE_PIXELS / 1_000_000} million`,
    );
  }
  // EXIF orientations 5 to 8 turn the image by 90 degrees.
  const rotated = (meta.orientation ?? 1) >= 5;
  const sourceWidth = (rotated ? meta.height : meta.width) ?? 1;
  const sourceHeight = (rotated ? meta.width : meta.height) ?? 1;
  // The widest crop of the requested aspect that fits into the source.
  const cropWidth = Math.min(sourceWidth, (sourceHeight * aspect.width) / aspect.height);

  const base = sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS })
    .autoOrient()
    .flatten({ background: "#ffffff" });
  const encode = (edge: number) => {
    const width = Math.max(1, Math.floor(Math.min(edge, cropWidth)));
    const height = Math.max(1, Math.round((width * aspect.height) / aspect.width));
    return base
      .clone()
      .resize({ width, height, fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  };
  const [details, thumbnail] = await Promise.all([
    encode(DETAILS_MAX_EDGE),
    encode(THUMBNAIL_MAX_EDGE),
  ]);
  return { details, thumbnail };
}
