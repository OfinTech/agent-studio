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

// Real template compilation covers both raster formats and hostile resource metadata.
const { defaultPdfTemplate, renderTemplate, TEMPLATE_PROFILE } =
  await import("../packages/contracts/src/pdf-templates");
const { reportChecksum } = await import("../packages/connectors/src/reports");
const { default: sharp } = await import("sharp");
const resources: (import("../packages/contracts/src/pdf-templates").ImageResource & {
  content: string;
})[] = [];
for (const format of ["png", "jpeg"] as const) {
  const bytes = await sharp({
    create: { width: 40, height: 20, channels: 3, background: "blue" },
  })
    .toFormat(format)
    .toBuffer();
  resources.push({
    id: "11111111-1111-4111-8111-111111111111",
    filename: format === "png" ? "logo.png" : "logo.jpg",
    mimeType: `image/${format}` as "image/png" | "image/jpeg",
    checksum: reportChecksum(bytes),
    size: bytes.length,
    content: bytes.toString("base64"),
  });
}
const templateSource = renderTemplate(
  {
    ...defaultPdfTemplate,
    source: defaultPdfTemplate.source.replace(
      "<<assessment>>",
      String.raw`\includegraphics[width=1cm]{assets/logo.png}\includegraphics[width=1cm]{assets/logo.jpg} <<assessment>>`,
    ),
  },
  {
    title: "Synthetic assessment",
    assessment: String.raw`\section{Agent section} Synthetic agent-provided assessment.`,
  },
);
const imageReport = await compileReport(
  templateSource,
  TEMPLATE_PROFILE,
  signal(),
  resources,
);
assert(imageReport.ok, JSON.stringify(imageReport));
assert(imageReport.text.includes("Synthetic agent-provided assessment"));
for (const invalid of [
  [],
  [{ ...resources[0], filename: "../logo.png" }],
  [resources[0], resources[0]],
  [{ ...resources[0], checksum: "0".repeat(64) }],
  [{ ...resources[0], content: "broken" }],
  Array.from({ length: 11 }, (_, i) => ({
    ...resources[0],
    filename: `logo${i}.png`,
  })),
]) {
  assert(
    !(await compileReport(templateSource, TEMPLATE_PROFILE, signal(), invalid))
      .ok,
    "Invalid resources must fail",
  );
}
assert(
  !(await compileReport(templateSource, REPORT_PROFILE, signal(), resources))
    .ok,
  "Old renderer rejects uploaded resources",
);
console.log(
  "PASS offline template logos, raw Agent sections, missing/corrupt resources and filename isolation",
);

// Both published template profiles remain usable with their original resources.
const { LEGACY_TEMPLATE_PROFILE } =
  await import("../packages/contracts/src/pdf-templates");
const legacyImageReport = await compileReport(
  templateSource,
  LEGACY_TEMPLATE_PROFILE,
  signal(),
  resources,
);
assert(legacyImageReport.ok, JSON.stringify(legacyImageReport));
assert.equal(legacyImageReport.profile, LEGACY_TEMPLATE_PROFILE);
const { readFile } = await import("node:fs/promises");
const diagrams = await readFile(
  "services/pdf-compiler/warmup-diagrams.tex",
  "utf8",
);
const diagramReport = await compileReport(diagrams, TEMPLATE_PROFILE, signal());
assert(diagramReport.ok, JSON.stringify(diagramReport));
assert(diagramReport.text.includes("Synthetic graphs"));
assert(
  !(await compileReport(diagrams, LEGACY_TEMPLATE_PROFILE, signal())).ok,
  "New packages must not change the v2 cache",
);
assert(
  !(await compileReport(diagrams, REPORT_PROFILE, signal())).ok,
  "New packages must not change the v1 cache",
);
const logo = await readFile("reports/ofintech/ofintech-logo.png");
const branded = renderTemplate(
  {
    ...defaultPdfTemplate,
    source: await readFile("reports/ofintech/report.tex", "utf8"),
  },
  JSON.parse(await readFile("reports/ofintech/sample-parameters.json", "utf8")),
);
const brandedReport = await compileReport(branded, TEMPLATE_PROFILE, signal(), [
  {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "ofintech-logo.png",
    mimeType: "image/png",
    checksum: reportChecksum(logo),
    size: logo.length,
    content: logo.toString("base64"),
  },
]);
assert(brandedReport.ok, JSON.stringify(brandedReport));
assert(brandedReport.pageCount >= 2);
assert(brandedReport.text.includes("OFINTECH"));
assert(brandedReport.text.includes("Sources and limitations"));
assert(
  !brandedReport.warnings.some((warning) => /overfull/i.test(warning)),
  JSON.stringify(brandedReport.warnings),
);
console.log(
  "PASS v1/v2 compatibility, isolated v3 diagrams/plots/tables and branded Ofintech multipage layout",
);
