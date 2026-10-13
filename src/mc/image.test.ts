import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { UnsupportedImageError, prepareRecipeImage as prepare } from "./image.js";

// The cover photo aspect of the knowledge file.
const WIDE = { width: 16, height: 9 };
const prepareRecipeImage = (bytes: Uint8Array) => prepare(bytes, WIDE);

const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({
    create: {
      width,
      height,
      channels,
      background: channels === 4 ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 200, g: 60, b: 20 },
    },
  });

describe("prepareRecipeImage", () => {
  it("fits a large WebP into 1600 px and 800 px JPEGs", async () => {
    const input = await solid(3200, 1800).webp().toBuffer();
    const { details, thumbnail } = await prepareRecipeImage(input);
    const d = await sharp(details).metadata();
    const t = await sharp(thumbnail).metadata();
    expect(d).toMatchObject({ format: "jpeg", width: 1600, height: 900 });
    expect(t).toMatchObject({ format: "jpeg", width: 800, height: 450 });
  });

  // The recipe has only landscape slots; the web editor crops every cover to 16:9.
  it("crops a portrait image to 16:9", async () => {
    const input = await solid(1000, 2000).jpeg().toBuffer();
    const { details, thumbnail } = await prepareRecipeImage(input);
    expect(await sharp(details).metadata()).toMatchObject({ width: 1000, height: 563 });
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 800, height: 450 });
  });

  it("crops a square image and follows another aspect", async () => {
    const input = await solid(2000, 2000).png().toBuffer();
    const wide = await prepareRecipeImage(input);
    expect(await sharp(wide.details).metadata()).toMatchObject({ width: 1600, height: 900 });
    const square = await prepare(input, { width: 1, height: 1 });
    expect(await sharp(square.details).metadata()).toMatchObject({ width: 1600, height: 1600 });
    expect(await sharp(square.thumbnail).metadata()).toMatchObject({ width: 800, height: 800 });
  });

  it("refuses an aspect without a positive width and height", async () => {
    const input = await solid(10, 10).png().toBuffer();
    await expect(prepare(input, { width: 0, height: 9 })).rejects.toThrow(RangeError);
  });

  it("does not enlarge a small image", async () => {
    const input = await solid(300, 200).png().toBuffer();
    const { details, thumbnail } = await prepareRecipeImage(input);
    expect(await sharp(details).metadata()).toMatchObject({
      format: "jpeg",
      width: 300,
      height: 169,
    });
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 300, height: 169 });
  });

  it("fills transparency with white", async () => {
    const input = await solid(64, 64, 4).png().toBuffer();
    const { details } = await prepareRecipeImage(input);
    const { data } = await sharp(details).raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data.subarray(0, 3))).toBeGreaterThan(245);
  });

  it("applies the EXIF orientation and drops the metadata", async () => {
    // Orientation 6: the camera was turned by 90 degrees; viewers show the image rotated.
    const input = await solid(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await sharp(input).metadata()).toMatchObject({
      width: 400,
      height: 200,
      orientation: 6,
    });
    const { details } = await prepareRecipeImage(input);
    const meta = await sharp(details).metadata();
    // Upright the photo is 200 wide; without the orientation the crop would be 400 wide.
    expect(meta).toMatchObject({ width: 200, height: 113 });
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("rejects formats other than JPEG, PNG and WebP", async () => {
    const gif = await solid(10, 10).gif().toBuffer();
    await expect(prepareRecipeImage(gif)).rejects.toThrow(
      new UnsupportedImageError("Unsupported image format gif; expected JPEG, PNG or WebP"),
    );
  });

  it("rejects bytes that are not an image", async () => {
    const error = await prepareRecipeImage(new TextEncoder().encode("not an image")).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsupportedImageError);
    expect(error).toMatchObject({ message: "The image could not be decoded" });
  });
});
