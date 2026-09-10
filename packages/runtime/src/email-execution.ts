import { createHash } from "node:crypto";
import { query } from "../../persistence/src/index";
import type { Email, WorkflowNode } from "../../contracts/src/index";
import {
  sendEmail,
  renderEmailReply,
  emailRetryWindowOpen,
  type EmailMessage,
  type EmailSendResult,
} from "../../connectors/src/send-email";
import { ReviewError, RetryError } from "./run-lifecycle";
import type { CompleteStep } from "./checkpoint";

export type EmailSendRecord = {
  message: EmailMessage;
  mode: "live" | "preview";
  status:
    | "prepared"
    | "running"
    | "ambiguous"
    | "retryable"
    | "failed"
    | "needs_review"
    | "succeeded";
  first_attempt_at: Date | null;
  provider_email_id: string | null;
  error: string | null;
};
export type EmailOverrides = {
  sendEmail?: (
    message: EmailMessage,
    key: string,
    signal: AbortSignal,
  ) => Promise<EmailSendResult>;
  afterEmailPrepared?: () => Promise<void>;
  afterEmailAccepted?: () => Promise<void>;
};
export async function executeEmailStep({
  runId,
  node,
  from,
  email,
  outputs,
  preview,
  signal,
  complete,
  overrides,
}: {
  runId: string;
  node: WorkflowNode;
  from: string;
  email: Email;
  outputs: Record<string, unknown>;
  preview: boolean;
  signal: AbortSignal;
  complete: CompleteStep;
  overrides: EmailOverrides;
}) {
  const json = JSON.stringify;
  let [record] = await query<EmailSendRecord>(
    "SELECT * FROM email_sends WHERE run_id=$1 AND node_id=$2",
    [runId, node.id],
  );
  if (!record) {
    const message = renderEmailReply(node, from, email, outputs);
    const mode = preview ? "preview" : "live";
    [record] = await query(
      "INSERT INTO email_sends(run_id,node_id,message,mode,status) VALUES($1,$2,$3,$4,'prepared') ON CONFLICT(run_id,node_id) DO UPDATE SET node_id=excluded.node_id RETURNING *",
      [runId, node.id, json(message), mode],
    );
    await overrides.afterEmailPrepared?.();
  }
  if (record.status === "needs_review")
    throw new ReviewError("Email send requires review");
  if (record.status === "failed")
    throw new Error(record.error ?? "Email sending failed");
  let providerEmailId: string | null = record.provider_email_id;
  if (record.mode === "live" && record.status !== "succeeded") {
    signal.throwIfAborted();
    const [attempt] = await query(
      "UPDATE email_sends SET status='running',first_attempt_at=coalesce(first_attempt_at,now()) WHERE run_id=$1 AND node_id=$2 RETURNING first_attempt_at",
      [runId, node.id],
    );
    // Check after the database write: lock waits must not consume the key's remaining window.
    if (!emailRetryWindowOpen(attempt.first_attempt_at)) {
      await query(
        "UPDATE email_sends SET status='needs_review',error=$3 WHERE run_id=$1 AND node_id=$2",
        [
          runId,
          node.id,
          "Email retry window expired; check Resend before starting another run",
        ],
      );
      throw new ReviewError("Email retry window expired");
    }
    signal.throwIfAborted();
    const result = await (overrides.sendEmail ?? sendEmail)(
      record.message,
      "email-" +
        createHash("sha256")
          .update(json([runId, node.id]))
          .digest("hex"),
      signal,
    );
    if (!result.ok) {
      // Once a request is uncertain, a later rejection cannot prove it was never accepted.
      const ambiguous =
        result.ambiguous || ["running", "ambiguous"].includes(record.status);
      await query(
        "UPDATE email_sends SET status=$3,error=$4 WHERE run_id=$1 AND node_id=$2",
        [
          runId,
          node.id,
          ambiguous ? "ambiguous" : result.retryable ? "retryable" : "failed",
          result.error,
        ],
      );
      if (result.retryable && !signal.aborted)
        throw new RetryError(result.error);
      if (ambiguous) throw new ReviewError(result.error);
      throw new Error(result.error);
    }
    providerEmailId = result.providerEmailId;
    await overrides.afterEmailAccepted?.();
  }
  await complete(
    node.id,
    {
      ...record.message,
      mode: record.mode,
      delivery:
        record.mode === "preview" ? "Preview only" : "Accepted by Resend",
      providerEmailId,
    },
    null,
    { emailAcceptance: { providerEmailId } },
  );
}
