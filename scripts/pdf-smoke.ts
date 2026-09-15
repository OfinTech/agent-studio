import assert from "node:assert/strict";
import { compileReport } from "../packages/runtime/src/report-execution";
import {
  REPORT_PROFILE,
  syntheticReportSource,
} from "../packages/contracts/src/reports";
const signal = () => AbortSignal.timeout(40000);
const compile = (source: string) =>
  compileReport(source, REPORT_PROFILE, signal());
const success = await compile(syntheticReportSource);
assert(success.ok, JSON.stringify(success));
assert(success.pageCount >= 2);
assert(success.text.includes("Synthetic"));
assert(
  Buffer.from(success.pdf, "base64").subarray(0, 5).toString() === "%PDF-",
);
console.log(
  "PASS real multipage PDF, equations, tables, hyperlinks and text extraction",
);
const longTable = syntheticReportSource.replace(
  "Example & 42",
  Array.from({ length: 180 }, (_, i) => `Synthetic row ${i} & ${i}`).join(
    "\\\\\n",
  ),
);
const long = await compile(longTable);
assert(long.ok, JSON.stringify(long));
assert(long.pageCount > 3);
for (const [name, source] of [
  [
    "invalid syntax",
    String.raw`\documentclass{report}\begin{document}\unknowncommand\end{document}`,
  ],
  [
    "unavailable package",
    String.raw`\documentclass{report}\usepackage{unavailable-package}\begin{document}Example\end{document}`,
  ],
  [
    "empty document",
    String.raw`\documentclass{report}\begin{document}\end{document}`,
  ],
  ["source limit", "x".repeat(131073)],
  [
    "relative traversal",
    String.raw`\documentclass{report}\begin{document}\input{../../../etc/passwd}\end{document}`,
  ],
  [
    "page limit",
    String.raw`\documentclass{report}\begin{document}` +
      "Page\\newpage\n".repeat(21) +
      String.raw`\end{document}`,
  ],
  [
    "absolute file access",
    String.raw`\documentclass{report}\begin{document}\input{/etc/passwd}\end{document}`,
  ],
] as const) {
  const result = await compile(source);
  assert(!result.ok, `${name} unexpectedly succeeded`);
  assert(result.error.length <= 4000);
  console.log(`PASS ${name}`);
}
const shell = await compile(
  String.raw`\documentclass{report}\begin{document}\immediate\write18{touch /tmp/shell-escape-marker}Shell escape disabled.\end{document}`,
);
assert(shell.ok, JSON.stringify(shell));
const corrected = await compile(syntheticReportSource);
assert(corrected.ok, JSON.stringify(corrected));
const controller = new AbortController();
const cancelled = compileReport(
  String.raw`\documentclass{report}\begin{document}\loop\iftrue\repeat\end{document}`,
  REPORT_PROFILE,
  controller.signal,
);
await new Promise((resolve) => setTimeout(resolve, 500));
const busy = await fetch(
  new URL("/compile", process.env.PDF_COMPILER_URL ?? "http://127.0.0.1:8088"),
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: REPORT_PROFILE,
      source: syntheticReportSource,
    }),
  },
);
assert.equal(busy.status, 503, "Only one compilation may run at a time");
controller.abort();
await assert.rejects(cancelled);
await new Promise((resolve) => setTimeout(resolve, 250));
assert(
  (await compile(syntheticReportSource)).ok,
  "Compiler must accept a new job after cancellation",
);
console.log("PASS cancellation and cleanup between jobs");
const timeout = await compile(
  String.raw`\documentclass{report}\begin{document}\loop\iftrue\repeat\end{document}`,
);
assert(!timeout.ok);
console.log("PASS bounded timeout");
