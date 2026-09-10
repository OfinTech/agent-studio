import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const root = resolve(process.env.MOCK_STATE_DIR ?? ".data/mock");
await mkdir(root, { recursive: true });
const file = resolve(root, "receipts.json");
let receipts: Record<string, unknown> = {};
try {
  receipts = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
let writes = Promise.resolve();
createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/health") {
    res.end('{"ok":true}');
    return;
  }
  if (req.url !== "/receipts" || req.method !== "POST") {
    res.writeHead(404).end('{"error":"Not found"}');
    return;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) {
      res.writeHead(413).end();
      return;
    }
  }
  const key = String(req.headers["idempotency-key"] ?? randomUUID());
  let args: unknown;
  try {
    args = JSON.parse(body);
  } catch {
    res.writeHead(400).end('{"error":"Invalid JSON"}');
    return;
  }
  // Serialize persistence so concurrent requests with the same key see one receipt.
  writes = writes
    .then(async () => {
      if (!receipts[key]) {
        receipts[key] = { id: randomUUID(), accepted: true, receipt: args };
        await writeFile(file + ".tmp", JSON.stringify(receipts, null, 2));
        await rename(file + ".tmp", file);
      }
      res.writeHead(201).end(JSON.stringify(receipts[key]));
    })
    .catch(() => {
      res.writeHead(500).end('{"error":"Persistence failed"}');
    });
}).listen(4010, () =>
  console.log(
    "Mock client API listening on :4010; receipt records are persisted.",
  ),
);
