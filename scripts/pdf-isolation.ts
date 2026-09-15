import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const args = [
  "compose",
  ...(process.env.PDF_COMPOSE_PROJECT
    ? ["-p", process.env.PDF_COMPOSE_PROJECT]
    : []),
];
async function docker(extra: string[], input?: string) {
  const child = spawn("docker", [...args, ...extra], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
}
await docker(
  ["exec", "-T", "pdf-compiler", "python3", "-"],
  await readFile("services/pdf-compiler/test-isolation.py", "utf8"),
);
await docker([
  "exec",
  "-T",
  "pdf-compiler",
  "python3",
  "-c",
  "from pathlib import Path; Path('/tmp/jobs/abandoned').mkdir(); Path('/tmp/jobs/abandoned/report.tex').write_text('synthetic')",
]);
await docker(["restart", "pdf-compiler"]);
await docker([
  "exec",
  "-T",
  "pdf-compiler",
  "python3",
  "-c",
  "import urllib.request; from pathlib import Path; urllib.request.urlopen('http://localhost:8080/health'); assert not list(Path('/tmp/jobs').iterdir())",
]);
console.log("PASS abandoned jobs cleaned before accepting work after restart");
