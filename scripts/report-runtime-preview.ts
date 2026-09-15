// Run in the deployed web container with RUN_LIVE_REPORT_RUNTIME=1 and
// REPORT_WORKFLOW_ID. Creates synthetic preview runs only; uses the published
// provider and template without rewriting the source workflow or sending email.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, transaction, pool } from "../packages/persistence/src/index";
import { dispatchOutbox, getBoss } from "../packages/runtime/src/service";
import { createSession, SESSION_COOKIE } from "../apps/web/lib/auth";
import type { Workflow } from "../packages/contracts/src/index";

if (
  process.env.RUN_LIVE_REPORT_RUNTIME !== "1" ||
  !process.env.REPORT_WORKFLOW_ID
) {
  console.log(
    "Skipped: set RUN_LIVE_REPORT_RUNTIME=1 and REPORT_WORKFLOW_ID for synthetic live-provider previews.",
  );
  process.exit(0);
}
const base = process.env.APP_URL!;
const headers = {
  Origin: new URL(base).origin,
  Cookie: `${SESSION_COOKIE}=${createSession()}`,
  "Content-Type": "application/json",
};
async function api(
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const created: string[] = [];
try {
  for (const failure of [false, true]) {
    const copy = await api("workflows", {
      name: `Synthetic report runtime ${failure ? "failure" : "long email-only"} preview`,
      duplicateFromWorkflowId: process.env.REPORT_WORKFLOW_ID,
    });
    created.push(copy.id);
    const draft: Workflow = copy.draft;
    draft.executionTimeoutSeconds = 600;
    draft.nodes.find((n) => n.type === "email")!.data.recipient =
      `runtime-preview-${copy.id}@example.com`;
    draft.nodes.find((n) => n.type === "email")!.data.sendFailureNotice = true;
    draft.nodes.find((n) => n.type === "upload")!.data.requireAttachments =
      false;
    if (failure)
      draft.nodes.find((n) => n.type === "agent")!.data.model =
        "synthetic-invalid-model-for-runtime-verification";
    await api(`workflows/${copy.id}`, draft, "PUT");
    await api(`workflows/${copy.id}/publish`, {});
    const [published] = await query(
      "SELECT published_version FROM workflows WHERE id=$1",
      [copy.id],
    );
    const emailId = randomUUID(),
      runId = randomUUID();
    const email = {
      id: emailId,
      from: "synthetic-sender@example.com",
      to: [draft.nodes.find((n) => n.type === "email")!.data.recipient],
      subject: "Synthetic report runtime verification",
      messageId: `<${emailId}@example.com>`,
      attachments: [],
      text: failure
        ? "Create a brief synthetic report."
        : "Prepare a detailed 8–12 page report about a fictional company evaluating a workflow automation platform. All facts and numeric data must be explicitly synthetic. Include an executive summary, requirements, architecture, operational reliability and retries, security controls, a migration plan, a risk register, a numeric comparison table, a timeline diagram, a sensitivity chart, acceptance criteria, and recommendations. Use the fixed branded PDF template. Target approximately 4,000 words with complete LaTeX sections and useful explanatory detail. Do not research or claim real sources. Complete the normal Success outcome with the PDF attached.",
    };
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO emails(id,provider_id,payload,raw) VALUES($1,$2,$3,'{\"test\":true}')",
        [emailId, "test:" + emailId, JSON.stringify(email)],
      );
      await client.query(
        "INSERT INTO runs(id,version_id,email_id) VALUES($1,$2,$3)",
        [runId, published.published_version, emailId],
      );
      await client.query("INSERT INTO outbox(run_id) VALUES($1)", [runId]);
    });
    await dispatchOutbox();
    console.log(
      `Started ${failure ? "provider rejection" : "long email-only report"} preview: ${runId}`,
    );
    const started = Date.now();
    let run;
    do {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      run = await api(`runs/${runId}`);
    } while (
      ["queued", "running"].includes(run.status) &&
      Date.now() - started < 660000
    );
    assert.equal(run.status, failure ? "failed" : "succeeded", run.error);
    assert(
      run.emailSends.every(
        (send: { mode: string; first_attempt_at: unknown }) =>
          send.mode === "preview" && !send.first_attempt_at,
      ),
    );
    if (failure) {
      assert.equal(run.systemNotices[0]?.status, "preview");
      assert.equal(run.systemNotices[0]?.attempts, 0);
      assert.equal(
        run.systemNotices[0]?.message.headers["In-Reply-To"],
        email.messageId,
      );
    } else {
      assert.equal(
        run.steps.find(
          (step: { node_id: string }) =>
            step.node_id === draft.nodes.find((n) => n.type === "upload")!.id,
        ).output.count,
        0,
      );
      assert(
        run.reports.some(
          (report: { status: string }) => report.status === "succeeded",
        ),
      );
      assert.equal(run.systemNotices.length, 0);
      assert(
        run.emailSends.some(
          (send: { message: { attachments?: unknown[] } }) =>
            send.message.attachments?.length,
        ),
      );
    }
    console.log(
      JSON.stringify({
        runId,
        status: run.status,
        durationMs: Date.now() - started,
        reportPages: run.reports.map(
          (report: { page_count: number }) => report.page_count,
        ),
        notice: run.systemNotices[0]?.status ?? "none",
        emailDispatches: 0,
      }),
    );
  }
} finally {
  for (const id of created)
    await api(`workflows/${id}`, undefined, "DELETE").catch(() =>
      console.error(`Temporary workflow needs cleanup: ${id}`),
    );
  await (await getBoss()).stop({ graceful: true });
  await pool.end();
}
