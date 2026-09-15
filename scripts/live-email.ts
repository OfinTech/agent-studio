import { validateReport } from "../packages/runtime/src/report-execution";
import { reportChecksum } from "../packages/connectors/src/reports";
import { boundedRequest } from "../packages/connectors/src/network";
// Read-only observer of real inbound runs. The published workflow sends replies.
import assert from "node:assert/strict";
import { query, pool } from "../packages/persistence/src/index";
import { mailbox } from "../packages/connectors/src/send-email";
import type { Snapshot } from "../packages/contracts/src/index";
if (process.env.RUN_LIVE_EMAIL !== "1") {
  console.log(
    "Live email verification not run. Set RUN_LIVE_EMAIL=1, LIVE_EMAIL_WORKFLOW_ID and LIVE_EMAIL_SENDER (a controlled inbox), with Resend receiving and verified outbound sending configured.",
  );
  await pool.end();
  process.exit(0);
}
const missing = [
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "LIVE_EMAIL_WORKFLOW_ID",
  "LIVE_EMAIL_SENDER",
].filter((name) => !process.env[name]);
if (missing.length) {
  console.log(`SKIP live email: missing ${missing.join(", ")}`);
  await pool.end();
  process.exit(1);
}
try {
  const sender = mailbox(process.env.LIVE_EMAIL_SENDER!);
  const [workflow] = await query(
    "SELECT w.*,v.snapshot FROM workflows w JOIN versions v ON v.id=w.published_version WHERE w.id=$1",
    [process.env.LIVE_EMAIL_WORKFLOW_ID],
  );
  assert(workflow, "Publish the controlled email workflow first");
  const snapshot = workflow.snapshot as Snapshot;
  assert(
    snapshot.workflow.nodes.filter((n) => n.type === "send_email").length >= 2,
    "Connect at least two Outcome branches to distinct Send email steps",
  );
  const start = new Date();
  console.log(
    `Waiting up to five minutes for a receipt attachment from ${sender} to ${workflow.recipient}. Use a verified outbound domain for this trigger inbox.`,
  );
  let passed = false;
  while (Date.now() - start.getTime() < 300000) {
    const runs = await query(
      "SELECT r.*,e.payload FROM runs r JOIN emails e ON e.id=r.email_id WHERE r.version_id=$1 AND r.created_at >= $2 AND e.provider_id NOT LIKE 'test:%' ORDER BY r.created_at",
      [workflow.published_version, start],
    );
    const run = runs.find(
      (r) =>
        r.payload &&
        mailbox(r.payload.from).toLowerCase() === sender.toLowerCase(),
    );
    if (run && ["succeeded", "failed", "needs_review"].includes(run.status)) {
      assert.equal(run.status, "succeeded", `Run ${run.id}: ${run.error}`);
      const sends = await query("SELECT * FROM email_sends WHERE run_id=$1", [
        run.id,
      ]);
      assert.equal(sends.length, 1, "Only one branch may reply");
      const send = sends[0];
      assert.equal(send.mode, "live");
      assert.equal(send.status, "succeeded");
      assert(send.provider_email_id, "Resend acceptance ID is required");
      assert.equal(
        send.message.from,
        snapshot.workflow.nodes.find((n) => n.type === "email")!.data.recipient,
      );
      assert.equal(send.message.to[0].toLowerCase(), sender.toLowerCase());
      assert(
        run.payload.messageId,
        "Real receiving metadata must retain message_id",
      );
      assert.equal(send.message.headers["In-Reply-To"], run.payload.messageId);
      const steps = await query("SELECT * FROM steps WHERE run_id=$1", [
        run.id,
      ]);
      const outcomes = snapshot.workflow.nodes.filter(
        (n) => n.type === "outcome",
      );
      assert(
        outcomes.some((n) =>
          steps.some(
            (s) => s.node_id === n.id && s.output.nextNode === send.node_id,
          ),
        ),
        "The accepted email must match the selected Outcome branch",
      );
      assert(
        snapshot.workflow.nodes
          .filter((n) => n.type === "send_email" && n.id !== send.node_id)
          .every((n) => !steps.some((s) => s.node_id === n.id)),
        "Unselected email steps must remain unexecuted",
      );
      if (process.env.LIVE_EMAIL_EXPECT_PDF === "1") {
        assert.equal(
          send.message.attachments?.length,
          1,
          "The selected reply must attach one PDF report",
        );
        const reference = send.message.attachments[0];
        const bytes = await validateReport(run.id, reference);
        assert.equal(reference.filename, "report.pdf");
        const listed = await boundedRequest(
          new URL(
            `https://api.resend.com/emails/${encodeURIComponent(send.provider_email_id)}/attachments`,
          ),
          {
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
            maxBytes: 65536,
          },
        );
        assert.equal(
          listed.status,
          200,
          "Resend attachment metadata must be readable",
        );
        const files = JSON.parse(listed.body.toString()).data;
        assert.equal(files.length, 1);
        assert.equal(files[0].filename, "report.pdf");
        assert.equal(files[0].size, bytes.length);
        const downloaded = await boundedRequest(
          new URL(files[0].download_url),
          { maxBytes: 10485760 },
        );
        assert.equal(downloaded.status, 200);
        assert.equal(
          reportChecksum(downloaded.body),
          reference.checksum,
          "Resend must retain exactly the generated bytes",
        );
        console.log(
          "PASS live PDF: generated and Resend attachment checksums match. Confirm the received attachment in the controlled inbox.",
        );
      }
      console.log(
        `PASS live reply: run ${run.id}, Resend ${send.provider_email_id}. Confirm the reply/thread in the controlled inbox separately; acceptance does not confirm delivery.`,
      );
      passed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(
    passed,
    "No completed controlled inbound email run arrived before timeout",
  );
} finally {
  await pool.end();
}
