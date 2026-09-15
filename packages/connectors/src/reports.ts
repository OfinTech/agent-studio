import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  link,
  readFile,
  unlink,
  readdir,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  reportReferenceSchema,
  type ReportReference,
} from "../../contracts/src/reports";
export const reportChecksum = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export class ReportStorage {
  root = resolve(
    /* turbopackIgnore: true */ process.env.ATTACHMENT_DIR ??
      ".data/attachments",
    "generated-reports",
  );
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Email report reference is invalid");
    return resolve(this.root, id + ".pdf");
  }
  async put(id: string, bytes: Buffer) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = this.path(randomUUID());
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic creation refuses to replace an existing immutable report.
    await link(temporary, this.path(id));
    await unlink(temporary);
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async read(reference: ReportReference) {
    const report = reportReferenceSchema.parse(reference);
    const info = await stat(this.path(report.reportId)).catch(() => null);
    if (!info?.isFile() || info.size !== report.size)
      throw new Error("Email report file is missing or invalid");
    const bytes = await readFile(this.path(report.reportId));
    if (
      bytes.length !== report.size ||
      reportChecksum(bytes) !== report.checksum
    )
      throw new Error("Email report checksum does not match");
    return bytes;
  }
  async delete(id: string) {
    await unlink(this.path(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async expireOrphans(keep: Set<string>, before: Date) {
    const files = await readdir(this.root).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const file of files) {
      const id = file.replace(/\.pdf$/, "");
      if (!/^[a-f0-9-]{36}$/.test(id) || keep.has(id)) continue;
      if ((await stat(this.path(id))).mtime < before) await this.delete(id);
    }
  }
}
