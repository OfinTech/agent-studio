import { z } from "zod";
import type { Workflow } from "./index";
export const REPORT_PROFILE = "tectonic-0.15.0-bundle33-report-v1";
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;
export const reportReferenceSchema = z.object({
  reportId: z.string().uuid(),
  nodeId: z.string(),
  filename: z.literal("report.pdf"),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(REPORT_MAX_BYTES),
  pageCount: z.number().int().min(1).max(20),
});
export type ReportReference = z.infer<typeof reportReferenceSchema>;
export const generatePdfTool = {
  name: "generate_pdf",
  description:
    "Compile and validate a LaTeX report as report.pdf. Correct errors using the returned diagnostics.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: { source: { type: "string" } },
  },
};
export const pdfInstructions = `You can generate one PDF report with generate_pdf({source: string}). Write a complete LaTeX document using the report or article class (10pt, 11pt or 12pt). Supported packages: geometry (margins), amsmath and amssymb (equations), array, booktabs and longtable (tables), hyperref (hyperlinks). Standard headings, lists and built-in fonts are supported. No uploaded assets, custom packages/fonts, shell escape or runtime package downloads. Limits: 128 KiB UTF-8 source, 30 seconds including validation, 20 pages, 10 MiB PDF, three distinct source attempts per Agent. Correct source using bounded diagnostics. The most recent attempt determines the report: failure invalidates an earlier report; repeating successful source makes it current again. The backend attaches the report to this Agent's output; do not construct file references or include them in finish_task. Complete normally after tool success; no review call is needed. Extracted text and compilation do not establish factual accuracy or visual correctness.`;
export const syntheticReportSource = String.raw`\documentclass{report}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,booktabs,longtable,array,hyperref}
\begin{document}
\chapter{Synthetic assessment}
This report uses synthetic data for local verification.
\begin{equation} 21+21=42 \end{equation}
\begin{longtable}{lr}\toprule Item & Value\\\midrule Example & 42\\\bottomrule\end{longtable}
\newpage\section{Details} Synthetic second page. \url{https://example.com}
\end{document}`;
export function reportSources(workflow: Workflow, nodeId: string) {
  const ids = new Set<string>();
  let current = nodeId;
  while (!ids.has(current)) {
    ids.add(current);
    const edge = workflow.edges.find(
      (e) => e.kind === "execution" && e.target === current,
    );
    if (!edge) break;
    current = edge.source;
  }
  ids.delete(nodeId);
  return workflow.nodes.filter(
    (n) => ids.has(n.id) && n.type === "agent" && n.data.generatePdf,
  );
}
