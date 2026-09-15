import type { PoolClient } from "pg";
import type { EmailMessage } from "../../contracts/src/index";
import { query, transaction } from "../../persistence/src/index";
import {
  noticeSuppression,
  systemNoticeMessage,
  validateReplyEnvelope,
} from "../../connectors/src/system-notice";
import {
  sendEmail,
  emailRetryWindowOpen,
  type EmailSendResult,
} from "../../connectors/src/send-email";
import { getBoss, NOTICE_QUEUE } from "./service";
import { withRunLock, RetryError, type QueueAttempt } from "./run-lifecycle";

// Called in the same transaction as definitive run failure, under the run lock.
// Maintenance never scans historical failures to create notices.
export async function prepareSystemNotice(
  client: PoolClient,
  runId: string,
  review: boolean,
  failure: string,
) {
  const {
    rows: [run],
  } = await client.query(
    "SELECT v.snapshot,e.reply_envelope,e.payload,e.raw,e.provider_id,e.id AS email_id FROM runs r JOIN versions v ON v.id=r.version_id JOIN emails e ON e.id=r.email_id WHERE r.id=$1",
    [runId],
  );
  if (!run) return;
  const workflow = run.snapshot.workflow;
  const entry = workflow.nodes.find(
    (n: { id: string; type: string }) =>
      n.type === "email" &&
      !workflow.edges.some(
        (e: { kind: string; target: string }) =>
          e.kind === "execution" && e.target === n.id,
      ),
  );
  const envelope = validateReplyEnvelope(run.reply_envelope ?? run.payload);
  const { rows: replies } = await client.query(
    "SELECT 1 FROM email_sends WHERE run_id=$1 AND (first_attempt_at IS NOT NULL OR status='succeeded')",
    [runId],
  );
  let reason = review
    ? "Uncertain external write"
    : !entry
      ? "Entry point is not Email"
      : entry.data.sendFailureNotice === false
        ? "System-error notices disabled"
        : replies.length
          ? "Workflow reply sent or attempted"
          : !envelope
            ? "No valid reply envelope"
            : null;
  let message: EmailMessage | null = null;
  if (!reason && envelope) {
    try {
      reason = noticeSuppression(envelope, entry.data.recipient);
      if (!reason)
        message = systemNoticeMessage(
          runId,
          entry.data.recipient,
          envelope,
          failure,
        );
    } catch {
      reason = "Invalid reply destination or headers";
    }
  }
  const preview =
    run.raw?.test === true && run.provider_id === "test:" + run.email_id;
  await client.query(
    "INSERT INTO system_notices(run_id,message,mode,status,suppression_reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id) DO NOTHING",
    [
      runId,
      message ? JSON.stringify(message) : null,
      preview ? "preview" : "live",
      reason ? "suppressed" : preview ? "preview" : "prepared",
      reason,
    ],
  );
}

export async function dispatchSystemNotices() {
  const boss = await getBoss();
  for (const row of await query(
    "SELECT run_id FROM system_notices WHERE status='prepared' AND queue_job_id IS NULL LIMIT 100",
  )) {
    await transaction(async (client) => {
      const {
        rows: [notice],
      } = await client.query(
        "SELECT * FROM system_notices WHERE run_id=$1 FOR UPDATE",
        [row.run_id],
      );
      if (!notice || notice.queue_job_id || notice.status !== "prepared")
        return;
      const jobId = await boss.send(
        NOTICE_QUEUE,
        { runId: row.run_id },
        {
          singletonKey: row.run_id,
          db: { executeSql: (sql, values) => client.query(sql, values) },
        },
      );
      if (!jobId) throw new Error("System notice queue association failed");
      await client.query(
        "UPDATE system_notices SET queue_job_id=$2 WHERE run_id=$1",
        [row.run_id, jobId],
      );
    });
  }
}

export async function executeSystemNotice(
  runId: string,
  attempt: QueueAttempt = {},
  dispatch = sendEmail,
) {
  await withRunLock(runId, async () => {
    const [record] = await query(
      "SELECT * FROM system_notices WHERE run_id=$1",
      [runId],
    );
    if (
      !record ||
      ["suppressed", "preview", "succeeded", "failed", "needs_review"].includes(
        record.status,
      )
    )
      return;
    if (record.mode === "preview") {
      await query(
        "UPDATE system_notices SET status='preview' WHERE run_id=$1",
        [runId],
      );
      return;
    }
    const uncertain = record.uncertain || record.status === "running";
    if (
      record.attempts >= 4 ||
      !emailRetryWindowOpen(record.first_attempt_at)
    ) {
      await query(
        "UPDATE system_notices SET status=$2,error='System notice retry budget expired',uncertain=$3 WHERE run_id=$1",
        [runId, uncertain ? "needs_review" : "failed", uncertain],
      );
      return;
    }
    await query(
      "UPDATE system_notices SET status='running',attempts=attempts+1,uncertain=$2,first_attempt_at=coalesce(first_attempt_at,now()) WHERE run_id=$1",
      [runId, uncertain],
    );
    let result: EmailSendResult;
    try {
      result = await dispatch(
        record.message,
        "system-notice-" + runId,
        AbortSignal.any([
          AbortSignal.timeout(35000),
          ...(attempt.signal ? [attempt.signal] : []),
        ]),
      );
    } catch {
      result = {
        ok: false,
        ambiguous: true,
        retryable: true,
        error: "System notice connection interrupted",
      };
    }
    if (result.ok) {
      await query(
        "UPDATE system_notices SET status='succeeded',provider_email_id=$2,error=NULL,uncertain=false WHERE run_id=$1",
        [runId, result.providerEmailId],
      );
      return;
    }
    const ambiguous = uncertain || result.ambiguous === true;
    const retry =
      result.retryable &&
      record.attempts < 3 &&
      (attempt.retryCount ?? 0) < Math.min(attempt.retryLimit ?? 3, 3) &&
      emailRetryWindowOpen(record.first_attempt_at);
    await query(
      "UPDATE system_notices SET status=$2,error=$3,uncertain=$4 WHERE run_id=$1",
      [
        runId,
        retry ? "retryable" : ambiguous ? "needs_review" : "failed",
        result.error,
        ambiguous,
      ],
    );
    if (retry) throw new RetryError("System notice delivery queued for retry");
  });
}

export async function reconcileSystemNotices() {
  const boss = await getBoss();
  for (const row of await query(
    "SELECT run_id,queue_job_id FROM system_notices WHERE queue_job_id IS NOT NULL AND status IN ('prepared','running','retryable')",
  )) {
    try {
      await withRunLock(row.run_id, async () => {
        const job = await boss.getJobById(NOTICE_QUEUE, row.queue_job_id);
        if (job && !["failed", "cancelled", "completed"].includes(job.state))
          return;
        await query(
          "UPDATE system_notices SET status=CASE WHEN uncertain OR status='running' THEN 'needs_review' ELSE 'failed' END,error='System notice queue ended before delivery was confirmed' WHERE run_id=$1 AND status IN ('prepared','running','retryable')",
          [row.run_id],
        );
      });
    } catch (error) {
      if (!(error instanceof RetryError)) throw error;
    }
  }
}
