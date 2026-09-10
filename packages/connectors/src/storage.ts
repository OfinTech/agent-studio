import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  readdir,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Attachment } from "../../contracts/src/index";
export interface AttachmentStorage {
  put(
    emailId: string,
    id: string,
    filename: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<Attachment>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export function validateAttachment(mime: string, bytes: Buffer) {
  const valid =
    mime === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : false;
  if (!valid) throw new Error("Unsupported or invalid attachment content");
}
export class LocalStorage implements AttachmentStorage {
  root = resolve(
    /* turbopackIgnore: true */ process.env.ATTACHMENT_DIR ??
      ".data/attachments",
  );
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
    return resolve(this.root, key);
  }
  async put(
    emailId: string,
    id: string,
    filename: string,
    mimeType: string,
    bytes: Buffer,
  ) {
    validateAttachment(mimeType, bytes);
    const storageKey = createHash("sha256")
      .update(emailId + ":" + id)
      .digest("hex");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(storageKey), bytes, { mode: 0o600 });
    return { id, filename, mimeType, size: bytes.length, storageKey };
  }
  read(key: string) {
    return readFile(this.path(key));
  }
  async expireOrphans(before: Date) {
    // Includes files written before an interrupted email normalization transaction.
    let keys: string[];
    try {
      keys = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const key of keys) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const info = await stat(this.path(key));
      if (info.isFile() && info.mtime < before) await this.delete(key);
    }
  }
  async delete(key: string) {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
