// Turns a recipe photo into the two JPEG variants the Monsieur Cuisine recipe references.

import sharp, { type Metadata } from "sharp";

export const DETAILS_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 800;
export const JPEG_QUALITY = 85;

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
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch (error) {
    throw new UnsupportedImageError("The image could not be decoded", { cause: error });
  }
  const format = meta.format as string | undefined;
  if (format === undefined || !supportedFormats.has(format)) {
    throw new UnsupportedImageError(
      `Unsupported image format ${format ?? "unknown"}; expected JPEG, PNG or WebP`,
    );
  }
  // EXIF orientations 5 to 8 turn the image by 90 degrees.
  const rotated = (meta.orientation ?? 1) >= 5;
  const sourceWidth = (rotated ? meta.height : meta.width) ?? 1;
  const sourceHeight = (rotated ? meta.width : meta.height) ?? 1;
  // The widest crop of the requested aspect that fits into the source.
  const cropWidth = Math.min(sourceWidth, (sourceHeight * aspect.width) / aspect.height);

  const base = sharp(bytes, { failOn: "error" }).autoOrient().flatten({ background: "#ffffff" });
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
