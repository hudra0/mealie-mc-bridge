// Turns a recipe photo into the two JPEG variants the Monsieur Cuisine recipe references.

import sharp from "sharp";

export const DETAILS_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 800;
export const JPEG_QUALITY = 85;

const supportedFormats = new Set(["jpeg", "png", "webp"]);

export interface PreparedRecipeImage {
  details: Buffer;
  thumbnail: Buffer;
}

export class UnsupportedImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnsupportedImageError";
  }
}

// Decodes JPEG, PNG or WebP, applies the EXIF orientation, fits the image into
// 1600 px (details) and 800 px (thumbnail) on the long side without enlarging it, fills
// transparency with white and encodes JPEG at quality 85. Metadata such as GPS positions
// is not carried over.
export async function prepareRecipeImage(bytes: Uint8Array): Promise<PreparedRecipeImage> {
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch (error) {
    throw new UnsupportedImageError("The image could not be decoded", { cause: error });
  }
  if (format === undefined || !supportedFormats.has(format)) {
    throw new UnsupportedImageError(
      `Unsupported image format ${format ?? "unknown"}; expected JPEG, PNG or WebP`,
    );
  }
  const base = sharp(bytes, { failOn: "error" }).autoOrient().flatten({ background: "#ffffff" });
  const encode = (edge: number) =>
    base
      .clone()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  const [details, thumbnail] = await Promise.all([
    encode(DETAILS_MAX_EDGE),
    encode(THUMBNAIL_MAX_EDGE),
  ]);
  return { details, thumbnail };
}
