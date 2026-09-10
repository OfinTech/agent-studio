import { query, pool } from "../packages/persistence/src/index";
if (process.env.RUN_LIVE !== "1") {
  console.log(
    "Live test is opt-in. Set RUN_LIVE=1 and LIVE_WORKFLOW_ID to a published Gemini workflow, then send a real receipt email to its receiving address.",
  );
  process.exit(0);
}
const [workflow] = await query(
  "SELECT w.*,v.snapshot FROM workflows w JOIN versions v ON v.id=w.published_version WHERE w.id=$1",
  [process.env.LIVE_WORKFLOW_ID ?? "receipt-example"],
);
if (
  !workflow ||
  !workflow.snapshot.workflow.nodes.some(
    (n: any) => n.type === "agent" && n.data.provider === "gemini",
  )
)
  throw new Error("Publish a Gemini workflow before running the live test");
console.log(
  `Waiting up to 5 minutes for a new real email run to ${workflow.recipient}. Send a receipt PDF, JPEG, or PNG now.`,
);
const start = new Date();
let success = false;
try {
  while (Date.now() - start.getTime() < 300000) {
    const [run] = await query(
      "SELECT r.* FROM runs r JOIN emails e ON e.id=r.email_id WHERE r.version_id=$1 AND r.created_at >= $2 AND e.provider_id NOT LIKE 'test:%' ORDER BY r.created_at DESC LIMIT 1",
      [workflow.published_version, start],
    );
    if (run && ["succeeded", "failed", "needs_review"].includes(run.status)) {
      if (run.status !== "succeeded")
        throw new Error(
          `Live run ${run.id}: ${run.status}. ${run.error ?? ""}`,
        );
      const calls = await query(
        "SELECT id FROM tool_calls WHERE run_id=$1 AND name='submit_receipt' AND status='succeeded'",
        [run.id],
      );
      if (!calls.length) throw new Error("Receipt API call did not succeed");
      console.log(`Live receipt flow passed: ${run.id}`);
      success = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!success)
    throw new Error("No successful live email run arrived before timeout");
} finally {
  await pool.end();
}
