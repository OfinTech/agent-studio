import { spawn } from "node:child_process";
import { resolve } from "node:path";
try {
  process.loadEnvFile(".env");
} catch {
  /* environment can be supplied directly */
}
process.env.ATTACHMENT_DIR = resolve(
  process.env.ATTACHMENT_DIR ?? ".data/attachments",
);
const child = spawn(
  process.execPath,
  [
    "apps/web/node_modules/next/dist/bin/next",
    "dev",
    "apps/web",
    "--hostname",
    "0.0.0.0",
  ],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
