import {
  TEMPLATE_PROFILES,
  renderTemplate,
  type ImageResource,
} from "../../contracts/src/pdf-templates";
import { compilationResources } from "./template-resources";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction } from "../../persistence/src/index";
import {
  ConfigurationError,
  type ToolResult,
  type WorkflowNode,
} from "../../contracts/src/index";
import {
  REPORT_MAX_BYTES,
  REPORT_PROFILE,
  reportReferenceSchema,
  type ReportReference,
} from "../../contracts/src/reports";
import { ReportStorage, reportChecksum } from "../../connectors/src/reports";
import { RetryError } from "./run-lifecycle";
const input = z
  .object({
    source: z
      .string()
      .min(1)
      .refine((s) => Buffer.byteLength(s) <= 131072),
  })
  .strict();
const compiled = z.object({
  ok: z.literal(true),
  profile: z.enum([REPORT_PROFILE, ...TEMPLATE_PROFILES]),
  pdf: z.string().max(13981016),
  pageCount: z.number().int().min(1).max(20),
  warnings: z.array(z.string().max(500)).max(10),
  text: z.string().min(1).max(20000),
  textTruncated: z.boolean(),
});
export type CompileReport = (
  source: string,
  profile: string,
  signal: AbortSignal,
  resources?: (ImageResource & { content: string })[],
) => Promise<z.infer<typeof compiled> | { ok: false; error: string }>;
export const compileReport: CompileReport = async (
  source,
  profile,
  signal,
  resources = [],
) => {
  let response: Response;
  try {
    response = await fetch(
      new URL(
        "/compile",
        process.env.PDF_COMPILER_URL ?? "http://127.0.0.1:8088",
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, profile, resources }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
        redirect: "error",
      },
    );
    if (response.status === 503) throw new RetryError("PDF compiler busy");
    if (!response.ok) throw new RetryError("PDF compiler unavailable");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 14100000) {
        await reader.cancel();
        throw new Error("Oversized compiler response");
      }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (data.ok === false)
      return { ok: false, error: String(data.error).slice(0, 4000) };
    return compiled.parse(data);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RetryError) throw error;
    throw new RetryError("PDF compiler connection or validation failed");
  }
};
type Attempt = {
  id: string;
  status: string;
  source_hash: string;
  generation_fingerprint: string | null;
  renderer_profile: string;
  result: ToolResult;
  report_id: string | null;
};
export async function generateReport(
  runId: string,
  node: WorkflowNode,
  callId: string,
  args: unknown,
  signal: AbortSignal,
  compile: CompileReport = compileReport,
  templateNode?: WorkflowNode,
): Promise<ToolResult> {
  let rendered: unknown = args;
  let templateError: string | undefined;
  if (templateNode) {
    try {
      rendered = {
        source: renderTemplate(templateNode.data.pdfTemplate!, args),
      };
    } catch (error) {
      templateError = (error as Error).message;
      rendered = undefined;
    }
  }
  const parsed = input.safeParse(rendered);
  const hash = createHash("sha256")
    .update(
      parsed.success ? parsed.data.source : (JSON.stringify(args) ?? "null"),
    )
    .digest("hex");
  const profile = (templateNode ?? node).data.rendererProfile;
  const images = templateNode?.data.pdfTemplate?.images ?? [];
  const fingerprintFor = (
    sourceHash: string,
    profile: string | undefined,
    images: ImageResource[],
  ) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          sourceHash,
          profile,
          images: [...images]
            .sort((a, b) => a.filename.localeCompare(b.filename))
            .map((image) => ({
              filename: image.filename,
              checksum: image.checksum,
            })),
        }),
      )
      .digest("hex");
  const fingerprint = fingerprintFor(hash, profile, images);
  const attempt = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
      runId + ":" + node.id,
    ]);
    const { rows } = await client.query<Attempt>(
      "SELECT * FROM report_attempts WHERE run_id=$1 AND node_id=$2 ORDER BY attempt_order",
      [runId, node.id],
    );
    const existing = rows.find((r) => r.id === callId);
    if (existing) return existing;
    const same = rows.find(
      (r) =>
        (r.generation_fingerprint === fingerprint ||
          (!templateNode &&
            !r.generation_fingerprint &&
            r.source_hash === hash &&
            r.renderer_profile === profile)) &&
        r.status !== "running",
    );
    const limit =
      !same &&
      new Set(
        rows.map(
          (r) =>
            r.generation_fingerprint ??
            fingerprintFor(r.source_hash, r.renderer_profile, []),
        ),
      ).size >= 3;
    const result: ToolResult | null = !parsed.success
      ? {
          ok: false,
          error:
            templateError ??
            "Provide nonempty LaTeX, at most 128 KiB UTF-8, using only the required parameters.",
        }
      : !(templateNode
            ? TEMPLATE_PROFILES.some((supported) => profile === supported)
            : profile === REPORT_PROFILE)
        ? {
            ok: false,
            error:
              "Unsupported renderer profile. Publish with a supported compiler.",
          }
        : limit
          ? {
              ok: false,
              error:
                "Three distinct PDF generation attempts exhausted. Reuse successful source or complete with an explanation.",
            }
          : (same?.result ?? null);
    const {
      rows: [created],
    } = await client.query<Attempt>(
      "INSERT INTO report_attempts(id,run_id,node_id,attempt_order,source_hash,renderer_profile,status,result,report_id,generation_fingerprint,template_node_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        callId,
        runId,
        node.id,
        rows.length + 1,
        hash,
        profile ?? "unknown",
        result ? (result.ok ? "succeeded" : "failed") : "running",
        result ? JSON.stringify(result) : null,
        result?.ok ? same?.report_id : null,
        fingerprint,
        templateNode?.id ?? null,
      ],
    );
    return created;
  });
  if (attempt.status !== "running") return attempt.result;
  signal.throwIfAborted();
  let resources: (ImageResource & { content: string })[];
  try {
    resources = await compilationResources(runId, images);
  } catch (error) {
    if (
      !(error instanceof ConfigurationError) &&
      !(error instanceof z.ZodError)
    )
      throw error;
    const result = {
      ok: false,
      error:
        "Template image is missing, corrupt or invalid. Restore the resource or publish a corrected template.",
    };
    await query(
      "UPDATE report_attempts SET status='failed',result=$2 WHERE id=$1",
      [callId, JSON.stringify(result)],
    );
    return result;
  }
  const response = await compile(
    parsed.data!.source,
    profile!,
    signal,
    resources,
  );
  let result: ToolResult;
  if (!response.ok) {
    result = { ok: false, error: response.error.slice(0, 4000) };
    await query(
      "UPDATE report_attempts SET status='failed',result=$2 WHERE id=$1",
      [callId, JSON.stringify(result)],
    );
  } else {
    const data = compiled.parse(response);
    if (data.profile !== profile)
      throw new RetryError(
        "PDF compiler returned a different renderer profile",
      );
    const bytes = Buffer.from(data.pdf, "base64");
    if (
      bytes.length > REPORT_MAX_BYTES ||
      bytes.subarray(0, 5).toString() !== "%PDF-" ||
      !data.text.trim()
    )
      throw new RetryError("PDF compiler returned invalid PDF data");
    const id = randomUUID();
    // Bytes and fsync precede the metadata commit. A crash leaves only an expirable orphan.
    await new ReportStorage().put(id, bytes);
    result = {
      ok: true,
      data: {
        reportId: id,
        pageCount: data.pageCount,
        warnings: data.warnings,
        textPreview: data.text.slice(0, 2000),
        textTruncated: data.textTruncated || data.text.length > 2000,
      },
    };
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO generated_reports(id,run_id,node_id,checksum,size,page_count,extracted_text,text_truncated) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          runId,
          node.id,
          reportChecksum(bytes),
          bytes.length,
          data.pageCount,
          data.text,
          data.textTruncated,
        ],
      );
      await client.query(
        "UPDATE report_attempts SET status='succeeded',result=$2,report_id=$3 WHERE id=$1",
        [callId, JSON.stringify(result), id],
      );
    });
  }
  return result;
}
export async function resolveReport(
  runId: string,
  nodeId: string,
  reportId: string,
): Promise<ReportReference> {
  const [row] = await query(
    "SELECT g.* FROM generated_reports g JOIN runs r ON r.id=g.run_id WHERE g.id=$1 AND g.run_id=$2 AND g.node_id=$3 AND g.expired_at IS NULL AND (r.finished_at IS NULL OR r.finished_at > now()-interval '7 days')",
    [reportId, runId, nodeId],
  );
  if (!row)
    throw new Error(
      "Email report is missing, expired or belongs to another run or Agent",
    );
  return reportReferenceSchema.parse({
    reportId: row.id,
    nodeId: row.node_id,
    filename: "report.pdf",
    checksum: row.checksum,
    size: row.size,
    pageCount: row.page_count,
  });
}
export async function currentReport(runId: string, nodeId: string) {
  const [last] = await query<Attempt>(
    "SELECT * FROM report_attempts WHERE run_id=$1 AND node_id=$2 ORDER BY attempt_order DESC LIMIT 1",
    [runId, nodeId],
  );
  return last?.status === "succeeded" && last.report_id
    ? resolveReport(runId, nodeId, last.report_id)
    : undefined;
}
export async function validateReport(runId: string, reference: unknown) {
  const parsed = reportReferenceSchema.safeParse(reference);
  if (!parsed.success)
    throw new Error("Email report reference is missing or invalid");
  const report = parsed.data;
  const stored = await resolveReport(runId, report.nodeId, report.reportId);
  if (JSON.stringify(stored) !== JSON.stringify(report))
    throw new Error("Email report metadata does not match");
  return new ReportStorage().read(stored);
}
export async function cleanupReports() {
  const storage = new ReportStorage();
  await query(
    "UPDATE report_attempts a SET status='failed',result=jsonb_build_object('ok',false,'error','Run ended before PDF generation completed') FROM runs r WHERE r.id=a.run_id AND r.status IN ('succeeded','failed','needs_review') AND a.status='running'",
  );
  const expired = await query(
    "SELECT g.id FROM generated_reports g JOIN runs r ON r.id=g.run_id WHERE g.expired_at IS NULL AND r.finished_at < now()-interval '7 days'",
  );
  for (const row of expired) {
    await storage.delete(row.id);
    await query(
      "UPDATE generated_reports SET expired_at=now(),extracted_text=NULL WHERE id=$1",
      [row.id],
    );
  }
  await query(
    "UPDATE report_attempts a SET result=result #- '{data,textPreview}' FROM runs r WHERE r.id=a.run_id AND r.finished_at < now()-interval '7 days' AND result->'data' ? 'textPreview'",
  );
  for (const row of await query(
    "SELECT c.run_id,c.state,v.snapshot FROM checkpoints c JOIN runs r ON r.id=c.run_id JOIN versions v ON v.id=r.version_id WHERE r.finished_at < now()-interval '7 days' AND c.state::text LIKE '%textPreview%'",
  )) {
    const names = new Set([
      "generate_pdf",
      ...(row.snapshot.workflow.nodes as WorkflowNode[])
        .filter((n) => n.type === "pdf_template")
        .map((n) => n.data.pdfTemplate?.toolName),
    ]);
    let changed = false;
    for (const node of Object.values(row.state.nodes ?? {}) as {
      messages?: {
        parts?: {
          functionResponse?: {
            name?: string;
            response?: { data?: Record<string, unknown> };
          };
        }[];
      }[];
    }[]) {
      for (const message of node.messages ?? [])
        for (const part of message.parts ?? []) {
          const response = part.functionResponse;
          if (
            names.has(response?.name) &&
            response?.response?.data &&
            Object.hasOwn(response.response.data, "reportId") &&
            Object.hasOwn(response.response.data, "textPreview")
          ) {
            delete response.response.data.textPreview;
            changed = true;
          }
        }
    }
    if (changed)
      await query("UPDATE checkpoints SET state=$2 WHERE run_id=$1", [
        row.run_id,
        JSON.stringify(row.state),
      ]);
  }
  const keep = new Set(
    (
      await query("SELECT id FROM generated_reports WHERE expired_at IS NULL")
    ).map((r) => r.id as string),
  );
  await storage.expireOrphans(keep, new Date(Date.now() - 7 * 86400000));
}
