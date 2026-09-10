import { randomBytes, scryptSync } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
try {
  await access(".env");
  console.log(
    ".env already exists. Update it directly, or use pnpm exec tsx scripts/reset-password.ts.",
  );
  process.exit(0);
} catch {
  /* first setup */
}
const password =
  process.env.SETUP_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = salt + ":" + scryptSync(password, salt, 64).toString("hex");
const content = (await readFile(".env.example", "utf8"))
  .replace("ADMIN_PASSWORD_HASH=", "ADMIN_PASSWORD_HASH=" + hash)
  .replace(
    "SESSION_SECRET=",
    "SESSION_SECRET=" + randomBytes(32).toString("hex"),
  )
  .replace(
    "CREDENTIAL_ENCRYPTION_KEY=",
    "CREDENTIAL_ENCRYPTION_KEY=" + randomBytes(32).toString("hex"),
  );
await writeFile(".env", content, { mode: 0o600, flag: "wx" });
console.log(
  `Created .env.\nAdministrator: admin@example.com\nInitial password: ${password}\nSave this password; only its hash is stored.`,
);
