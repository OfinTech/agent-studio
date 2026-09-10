import pg from "pg";
import { ConfigurationError } from "../../contracts/src/index";
import { drizzle } from "drizzle-orm/node-postgres";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as schema from "./schema";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
});
export const db = drizzle(pool, { schema });
export { schema };
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(sql, values)).rows;
}
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function key() {
  const value = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "", "hex");
  if (value.length !== 32)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes in hex");
  return value;
}
export function encrypt(secret: string, credentialId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(credentialId));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    ciphertext.toString("hex"),
  ].join(".");
}
export function decrypt(value: string, credentialId: string) {
  const [iv, tag, data] = value.split(".");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "hex"));
  cipher.setAAD(Buffer.from(credentialId));
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export async function resolveCredential(
  id: string,
  kind: "gemini" | "openai" | "claude" | "api",
) {
  const [row] = await query(
    "SELECT encrypted FROM credentials WHERE id=$1 AND kind=$2",
    [id, kind],
  );
  if (!row) throw new ConfigurationError("Credential unavailable");
  return decrypt(row.encrypted, id);
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  const sensitive = /authorization|api.?key|secret|token|password|encrypted/i;
  function visit(v: unknown): unknown {
    if (typeof v === "string")
      return secrets
        .filter(Boolean)
        .reduce((s, key) => s.split(key).join("[REDACTED]"), v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          sensitive.test(k) ? "[REDACTED]" : visit(x),
        ]),
      );
    return v;
  }
  return visit(value);
}
