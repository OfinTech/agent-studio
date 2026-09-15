import { decodeCheckpoint } from "./checkpoint";
import { prepareSystemNotice } from "./system-notices";
import { pool, query, transaction } from "../../persistence/src/index";
import { NetworkError } from "../../connectors/src/network";
import { emailRetryWindowOpen } from "../../connectors/src/send-email";
import type { EmailSendRecord } from "./email-execution";

export const RUN_DEADLINE_MS = 5 * 60 * 1000;
export type QueueAttempt = {
  jobId?: string;
  retryCount?: number;
  retryLimit?: number;
  signal?: AbortSignal;
};
export class DeadlineError extends Error {
  constructor() {
    super(
      "Execution deadline exceeded. Increase the workflow execution time or shorten the task.",
    );
  }
}
export class RetryExhaustedError extends Error {
  constructor() {
    super(
      "Retry limit exhausted. The workflow could not complete after three retries.",
    );
  }
}
export function hasTerminalCheckpoint(value: unknown): boolean {
  if (!value) return false;
  try {
    return decodeCheckpoint(value, "").cursor === null;
  } catch {
    return false;
  }
}
export class ReviewError extends Error {}
export class RetryError extends Error {}

export async function withRunLock<T>(
  runId: string,
  execute: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  let discard = false;
  try {
    try {
      const {
        rows: [lock],
      } = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [runId],
      );
      acquired = lock.acquired;
    } catch (error) {
      discard = true;
      throw error;
    }
    if (!acquired) throw new RetryError("Run is already executing");
    return await execute();
  } finally {
    if (acquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [runId],
        );
      } catch {
        // Destroy the connection rather than returning a possibly held session lock to the pool.
        discard = true;
      }
    }
    client.release(discard);
  }
}

function failureMessage(
  error: unknown,
  review: boolean,
  emailReview: boolean,
  transient: boolean,
) {
  if (review)
    return emailReview
      ? "Email acceptance is uncertain. Check Resend before starting another run."
      : "API write outcome is uncertain. Check the client API before starting another run.";
  if (
    transient &&
    error instanceof NetworkError &&
    error.message.startsWith("Provider ")
  )
    return error.message + "; queued for retry.";
  if (transient)
    return error instanceof RetryError && error.message.startsWith("Email")
      ? error.message
      : "Transient failure; queued for retry.";
  if (error instanceof DeadlineError || error instanceof RetryExhaustedError)
    return error.message;
  // Only controlled error categories may reach the inspector, never arbitrary upstream details.
  if (
    error instanceof Error &&
    /^(Run exceeded|Agent |No attachments|Attachment |Email |Unsupported|Unknown prompt variable|Provider |Tool action)/.test(
      error.message,
    )
  )
    return error.message;
  return "Execution failed. Check configuration and attachments.";
}
export async function recordRunFailure(
  runId: string,
  _activeNode: string,
  error: unknown,
  attempt: QueueAttempt = {},
): Promise<boolean> {
  if (attempt.signal?.aborted) error = new RetryError("Worker interrupted");
  let transient =
    error instanceof RetryError ||
    (error instanceof NetworkError && error.retryable);
  const unresolved = await query<{ id: string }>(
    "SELECT id FROM tool_calls WHERE run_id=$1 AND status IN ('running','needs_review')",
    [runId],
  );
  const emails = await query<EmailSendRecord>(
    "SELECT * FROM email_sends WHERE run_id=$1 AND status IN ('running','ambiguous','needs_review')",
    [runId],
  );
  const [run] = await query<{
    started_at: Date | null;
    deadline_at: Date | null;
  }>("SELECT started_at,deadline_at FROM runs WHERE id=$1", [runId]);
  const deadline = run?.deadline_at
    ? new Date(run.deadline_at).getTime()
    : run?.started_at
      ? new Date(run.started_at).getTime() + RUN_DEADLINE_MS
      : Infinity;
  const withinDeadline = Date.now() < deadline;
  if (!withinDeadline) {
    transient = false;
    error = new DeadlineError();
  } else if (
    transient &&
    (attempt.retryCount ?? 0) >= Math.min(attempt.retryLimit ?? 3, 3)
  ) {
    transient = false;
    error = new RetryExhaustedError();
  }
  if (!transient) {
    const [checkpoint] = await query(
      "SELECT state FROM checkpoints WHERE run_id=$1",
      [runId],
    );
    if (checkpoint && hasTerminalCheckpoint(checkpoint.state)) {
      await query(
        "UPDATE runs SET status='succeeded',error=NULL,finished_at=coalesce(finished_at,now()) WHERE id=$1",
        [runId],
      );
      return false;
    }
  }
  const canRetryEmail =
    transient &&
    withinDeadline &&
    emails.every(
      (email) =>
        email.status !== "needs_review" &&
        emailRetryWindowOpen(email.first_attempt_at),
    );
  const emailReview = emails.length > 0 && !canRetryEmail;
  if (emailReview)
    await query(
      "UPDATE email_sends SET status='needs_review',error=coalesce(error,'Email acceptance is uncertain; check Resend before starting another run') WHERE run_id=$1 AND status IN ('running','ambiguous')",
      [runId],
    );
  const review =
    error instanceof ReviewError || unresolved.length > 0 || emailReview;
  if (review) transient = false;
  const message = failureMessage(error, review, emailReview, transient);
  const status = review ? "needs_review" : transient ? "queued" : "failed";
  await transaction(async (client) => {
    await client.query(
      "UPDATE runs SET status=$2,error=$3,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END WHERE id=$1",
      [runId, status, message],
    );
    await client.query(
      "UPDATE steps SET status=$2,output=jsonb_build_object('error',$3::text) WHERE run_id=$1 AND status IN ('running','retrying')",
      [runId, transient ? "retrying" : status, message],
    );
    if (!transient) await prepareSystemNotice(client, runId, review, message);
  });
  return transient;
}
