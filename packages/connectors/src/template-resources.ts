import { ConfigurationError } from "../../contracts/src/index";
import sharp from "sharp";
import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { ReportStorage, reportChecksum } from "./reports";
import {
  IMAGE_MAX_BYTES,
  imageResourceSchema,
  type ImageResource,
} from "../../contracts/src/pdf-templates";

export function compilationFilename(filename: string, mime: string) {
  if (!filename || /[/\\]|\.\./.test(filename))
    throw new Error("Invalid image filename");
  const base = filename
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return (
    (base.replace(/^[^a-zA-Z0-9]+/, "") || "image") +
    (mime === "image/png" ? ".png" : ".jpg")
  );
}
export async function validateImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES)
    throw new Error("Images must be at most 5 MiB");
  // Check the signature before invoking a decoder; never decode SVG, PDF, or other formats.
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error("Upload a valid PNG or JPEG image");
  try {
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 16000000,
    });
    const meta = await image.metadata();
    if (!["png", "jpeg"].includes(meta.format ?? "") || (meta.pages ?? 1) !== 1)
      throw new Error();
    await image.raw().toBuffer();
    return png ? ("image/png" as const) : ("image/jpeg" as const);
  } catch {
    throw new Error(
      "Invalid image content; use a single PNG/JPEG image of at most 16 megapixels",
    );
  }
}
export class TemplateResourceStorage extends ReportStorage {
  root = resolve(
    /* turbopackIgnore: true */ process.env.ATTACHMENT_DIR ??
      ".data/attachments",
    "template-resources",
  );
  // Opaque storage names deliberately have no relationship to compilation filenames.
  async readImage(reference: ImageResource) {
    const image = imageResourceSchema.parse(reference);
    const info = await stat(this.path(image.id)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!info?.isFile() || info.size !== image.size)
      throw new ConfigurationError("Template image is missing or invalid");
    const bytes = await readFile(this.path(image.id));
    if (bytes.length !== image.size || reportChecksum(bytes) !== image.checksum)
      throw new ConfigurationError("Template image checksum does not match");
    return bytes;
  }
}
