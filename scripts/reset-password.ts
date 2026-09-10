import { randomBytes, scryptSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const password =
  process.env.SETUP_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = salt + ":" + scryptSync(password, salt, 64).toString("hex");
const content = (await readFile(".env", "utf8"))
  .replace(/^ADMIN_PASSWORD_HASH=.*$/m, "ADMIN_PASSWORD_HASH=" + hash)
  .replace(
    /^SESSION_SECRET=.*$/m,
    "SESSION_SECRET=" + randomBytes(32).toString("hex"),
  );
await writeFile(".env", content, { mode: 0o600 });
console.log(
  `New administrator password: ${password}\nRestart web to apply and invalidate existing sessions.`,
);
