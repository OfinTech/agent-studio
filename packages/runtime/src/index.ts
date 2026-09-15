import { validateReplyEnvelope } from "../../connectors/src/system-notice";
import {
  dispatchSystemNotices,
  reconcileSystemNotices,
} from "./system-notices";
import { getBoss, QUEUE } from "./service";
import {
  attachedTemplates,
  templateTool,
  templateInstructions,
} from "../../contracts/src/pdf-templates";
import { cleanupTemplateResources } from "./template-resources";
import { generatePdfTool, pdfInstructions } from "../../contracts/src/reports";
import {
  currentReport,
  cleanupReports,
  type CompileReport,
} from "./report-execution";
import { query, resolveCredential } from "../../persistence/src/index";
import { setting } from "../../persistence/src/settings";
import {
  renderPrompt,
  connectedOutcome,
  completionInstructions,
  completionTool,
  parseCompletion,
  resolveArguments,
  type Email,
  type Snapshot,
} from "../../contracts/src/index";
import { LocalStorage, retrieveEmail } from "../../connectors/src/index";
import {
  type EmailMessage,
  type EmailSendResult,
} from "../../connectors/src/send-email";
import {
  GeminiProvider,
  OpenAIProvider,
  ClaudeProvider,
  MockProvider,
  fileParts,
  type Provider,
  type Message,
} from "../../providers/src/index";
import { durableToolSession, type ToolDispatch } from "./tool-execution";
export {
  createWorkflow,
  WorkflowNotFoundError,
  publish,
  ingest,
  testRun,
  dispatchOutbox,
  getBoss,
  QUEUE,
  saveDraft,
} from "./service";
import {
  checkpointWriter,
  stateForNode,
  decodeCheckpoint,
  type Checkpoint,
} from "./checkpoint";
import {
  DeadlineError,
  hasTerminalCheckpoint,
  RetryExhaustedError,
  RetryError,
  type QueueAttempt,
  recordRunFailure,
  withRunLock,
} from "./run-lifecycle";
import { executeEmailStep } from "./email-execution";
export { decodeCheckpoint, type Checkpoint } from "./checkpoint";
export { deleteWorkflow } from "./service";
const json = (value: unknown) => JSON.stringify(value);
type RunRecord = {
  status: string;
  started_at: Date | null;
  deadline_at: Date | null;
  snapshot: Snapshot;
  payload: Email | null;
  email_id: string;
  provider_id: string;
  raw: { test?: boolean; data?: { message_id?: string } };
};
export async function executeRun(
  runId: string,
  overrides: {
    attempt?: QueueAttempt;
    retrieveEmail?: typeof retrieveEmail;
    provider?: Provider;
    compileReport?: CompileReport;
    dispatch?: ToolDispatch;
    afterCheckpoint?: (state: Checkpoint) => Promise<void>;
    sendEmail?: (
      message: EmailMessage,
      key: string,
      signal: AbortSignal,
    ) => Promise<EmailSendResult>;
    afterEmailPrepared?: () => Promise<void>;
    afterEmailAccepted?: () => Promise<void>;
  } = {},
) {
  return withRunLock(runId, async () => {
    let terminal = false;
    let session: Awaited<ReturnType<typeof durableToolSession>> | undefined;
    let activeNode = "email";
    try {
      const [run] = await query<RunRecord>(
        "SELECT r.*,v.snapshot,e.payload,e.provider_id,e.raw FROM runs r JOIN versions v ON v.id=r.version_id JOIN emails e ON e.id=r.email_id WHERE r.id=$1",
        [runId],
      );
      if (!run || ["succeeded", "failed", "needs_review"].includes(run.status))
        return;
      const snapshot = run.snapshot;
      const workflow = snapshot.workflow;
      const legacyWorkflow =
        workflow.nodes.filter((n) => n.type === "agent").length === 1 &&
        !workflow.nodes.some(
          (n) =>
            n.type === "outcome" ||
            n.type === "action" ||
            n.type === "send_email",
        );
      const next = (id: string, stateId?: string) =>
        workflow.edges.find(
          (e) =>
            e.kind === "execution" && e.source === id && e.stateId === stateId,
        )?.target ?? null;
      const start = workflow.nodes.find((n) => n.type === "email")!;
      const upload = workflow.nodes.find((n) => n.id === next(start.id))!;
      const firstAgent = next(upload.id)!;
      const [checkpoint] = await query<{ state: unknown }>(
        "SELECT state FROM checkpoints WHERE run_id=$1",
        [runId],
      );
      const state = decodeCheckpoint(checkpoint?.state, firstAgent);
      if (state.cursor === null) {
        await query(
          "UPDATE runs SET status='succeeded',finished_at=coalesce(finished_at,now()),error=NULL WHERE id=$1",
          [runId],
        );
        terminal = true;
        return;
      }
      const [timing] = await query<{ deadline_at: Date }>(
        "UPDATE runs SET status='running',started_at=coalesce(started_at,now()),deadline_at=coalesce(deadline_at,coalesce(started_at,now())+make_interval(secs => $2)),queue_job_id=coalesce(queue_job_id,$3),error=NULL WHERE id=$1 RETURNING deadline_at",
        [
          runId,
          workflow.executionTimeoutSeconds ?? 300,
          overrides.attempt?.jobId ?? null,
        ],
      );
      const remaining = new Date(timing.deadline_at).getTime() - Date.now();
      if (remaining <= 0) throw new DeadlineError();
      const signal = AbortSignal.any([
        AbortSignal.timeout(remaining),
        ...(overrides.attempt?.signal ? [overrides.attempt.signal] : []),
      ]);

      const { save: checkpointState, complete } = checkpointWriter(
        runId,
        state,
        overrides.afterCheckpoint,
      );
      const step = async (nodeId: string, status: string, output: unknown) => {
        activeNode = nodeId;
        await query(
          "INSERT INTO steps(id,run_id,node_id,status,output) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,node_id) DO UPDATE SET status=excluded.status,output=excluded.output WHERE steps.status <> 'succeeded'",
          [runId + ":" + nodeId, runId, nodeId, status, json(output)],
        );
      };
      const storage = new LocalStorage();
      let email = run.payload ?? undefined;
      await step(start.id, "running", {});
      if (!email) {
        email = await (overrides.retrieveEmail ?? retrieveEmail)(
          run.provider_id,
          run.email_id,
          storage,
          signal,
          {
            requireAttachments: upload.data.requireAttachments,
            messageId: run.raw?.data?.message_id,
            onEnvelope: async (envelope) => {
              await query("UPDATE emails SET reply_envelope=$2 WHERE id=$1", [
                run.email_id,
                envelope ? json(envelope) : null,
              ]);
            },
          },
        );
        await query("UPDATE emails SET payload=$2 WHERE id=$1", [
          run.email_id,
          json(email),
        ]);
        for (const a of email.attachments)
          await query(
            "INSERT INTO attachments(id,email_id,storage_key,metadata,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') ON CONFLICT DO NOTHING",
            [run.email_id + ":" + a.id, run.email_id, a.storageKey, json(a)],
          );
      }
      // Webhook metadata is retained even if the receiving API omits message_id.
      if (
        email.messageId === undefined &&
        run.raw?.data?.message_id !== undefined
      ) {
        email = { ...email, messageId: run.raw.data.message_id };
        await query("UPDATE emails SET payload=$2 WHERE id=$1", [
          run.email_id,
          json(email),
        ]);
      }
      await query("UPDATE emails SET reply_envelope=$2 WHERE id=$1", [
        run.email_id,
        json(validateReplyEnvelope(email)),
      ]);
      state.outputs[start.id] = email;
      await step(start.id, "succeeded", {
        from: email.from,
        subject: email.subject,
        attachments: email.attachments.length,
      });
      await step(upload.id, "running", {});
      const selected = email.attachments.filter((a) =>
        upload.data.mimeTypes?.some((mime) => mime === a.mimeType),
      );
      if (
        !selected.length &&
        (upload.data.requireAttachments !== false ||
          email.attachments.length > 0)
      )
        throw new Error("No attachments match the upload configuration");
      if (
        selected.reduce((sum, a) => sum + a.size, 0) >
        Number(setting("MAX_ATTACHMENT_BYTES") || 20971520)
      )
        throw new Error("Attachment size limit exceeded");
      state.outputs[upload.id] = { count: selected.length, files: selected };
      await step(upload.id, "succeeded", state.outputs[upload.id]);
      while (state.cursor) {
        signal.throwIfAborted();
        const node = workflow.nodes.find((n) => n.id === state.cursor);
        if (!node || !["agent", "action", "send_email"].includes(node.type))
          throw new Error("Unsupported execution node");
        await step(node.id, "running", {});
        if (node.type === "send_email") {
          await executeEmailStep({
            runId,
            node,
            from: start.data.recipient!,
            email,
            outputs: state.outputs,
            preview:
              run.raw?.test === true &&
              run.provider_id === "test:" + run.email_id,
            signal,
            complete,
            overrides,
          });
          continue;
        }
        const local = stateForNode(state, node.id);
        const context = { email, steps: state.outputs };
        const attachedIds = workflow.edges
          .filter((e) => e.kind === "tool" && e.target === node.id)
          .map(
            (e) => workflow.nodes.find((n) => n.id === e.source)?.data.toolId,
          );
        const nodeTools = snapshot.tools.filter((t) =>
          node.type === "action"
            ? t.id === node.data.toolId
            : attachedIds.includes(t.id),
        );
        const templateNodes =
          node.type === "agent" ? attachedTemplates(workflow, node.id) : [];
        const reportsEnabled =
          node.data.generatePdf || templateNodes.length > 0;
        session = await durableToolSession({
          runId,
          node,
          nodeTools,
          templateNodes,
          legacyCalls: state.legacyCalls,
          signal,
          dispatch: overrides.dispatch,
          compileReport: overrides.compileReport,
        });
        const { invoke } = session;
        if (node.type === "action") {
          const result = await invoke(
            nodeTools[0].name,
            resolveArguments(node.data.arguments, context),
            `${runId}:${node.id}:action`,
          );
          if (!result.ok)
            throw new Error(
              "Tool action failed: " +
                (result.error ?? "Tool returned failure"),
            );
          await complete(node.id, result, next(node.id));
        } else {
          const kind = node.data.provider!;
          const provider: Provider =
            overrides.provider ??
            (kind === "mock"
              ? new MockProvider()
              : new {
                  gemini: GeminiProvider,
                  openai: OpenAIProvider,
                  claude: ClaudeProvider,
                }[kind](
                  await resolveCredential(node.data.credentialId!, kind),
                ));
          for (const a of selected.slice(local.files.length)) {
            const file = provider.localAttachments
              ? {
                  name: a.filename,
                  uri: "local://" + a.storageKey,
                  mimeType: a.mimeType,
                }
              : await provider.upload(
                  await storage.read(a.storageKey),
                  a.mimeType,
                  a.filename,
                  async (name) => {
                    if (kind === "gemini")
                      await query(
                        "INSERT INTO provider_files(name,credential_id,run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                        [name, node.data.credentialId, runId],
                      );
                  },
                  signal,
                );
            local.files.push(file);
            await checkpointState();
          }
          if (legacyWorkflow) {
            state.outputs[upload.id] = {
              count: local.files.length,
              files: local.files,
            };
            await query(
              "UPDATE steps SET output=$3 WHERE run_id=$1 AND node_id=$2",
              [runId, upload.id, json(state.outputs[upload.id])],
            );
          }
          if (!local.messages.length) {
            local.messages = [
              {
                role: "user",
                parts: [
                  { text: renderPrompt(node.data.userPrompt!, context) },
                  ...fileParts(local.files),
                ],
              },
            ];
            await checkpointState();
          }
          const outcome = connectedOutcome(workflow, node.id);
          const config = {
            ...node.data,
            systemPrompt:
              (legacyWorkflow
                ? node.data.systemPrompt!
                : renderPrompt(node.data.systemPrompt!, context)) +
              (outcome ? "\n\n" + completionInstructions(outcome) : "") +
              (node.data.generatePdf ? "\n\n" + pdfInstructions : "") +
              (templateNodes.length ? "\n\n" + templateInstructions : ""),
          };
          const declarations = [
            ...nodeTools,
            ...templateNodes.map((n) => templateTool(n.data.pdfTemplate!)),
            ...(node.data.generatePdf ? [generatePdfTool] : []),
            ...(outcome ? [completionTool(outcome)] : []),
          ];
          let finished = false;
          while (local.turn < 10) {
            signal.throwIfAborted();
            if (!local.pending) {
              local.pending = await provider.infer(
                local.messages,
                config,
                declarations,
                signal,
              );
              await checkpointState();
            }
            signal.throwIfAborted();
            const calls =
              local.pending.parts?.flatMap((p) =>
                p.functionCall ? [p.functionCall] : [],
              ) ?? [];
            if (calls.length > 10)
              throw new Error(
                "Agent returned too many tool calls in a model turn",
              );
            const reports = calls.filter((c) => c.name === "finish_task");
            let correction: string | undefined;
            if (outcome && reports.length) {
              try {
                if (calls.length !== 1)
                  throw new Error(
                    "Call finish_task exactly once, without other tool calls. No actions in this response were executed.",
                  );
                const report = parseCompletion(reports[0].args, outcome);
                const successor = next(outcome.id, report.state);
                await complete(
                  node.id,
                  {
                    ...(reportsEnabled
                      ? { report: await currentReport(runId, node.id) }
                      : {}),
                    text: report.result,
                    turns: local.turn + 1,
                    outcome: report,
                    nextNode: successor,
                  },
                  successor,
                  {
                    additionalStep: {
                      nodeId: outcome.id,
                      output: { ...report, nextNode: successor },
                    },
                  },
                );
                finished = true;
                break;
              } catch (error) {
                // Persistence failures must never become model correction feedback.
                if (
                  !(error instanceof Error) ||
                  (!error.message.startsWith("Call finish_task") &&
                    error.name !== "ZodError" &&
                    error.message !== "Unknown outcome state")
                )
                  throw error;
                correction =
                  "Invalid completion report. Use the declared state ID and string reason/result; call finish_task alone. No actions were executed.";
              }
            } else if (!calls.length) {
              if (outcome)
                correction =
                  "Report completion by calling finish_task with state, reason, and result.";
              else {
                if (
                  node.data.requiredTool &&
                  !local.successes.includes(node.data.requiredTool)
                )
                  throw new Error(
                    "Agent finished without a successful required tool call",
                  );
                const requiresPdf =
                  (node.data.generatePdf &&
                    node.data.requiredTool === "generate_pdf") ||
                  templateNodes.some(
                    (template) =>
                      template.data.pdfTemplate?.toolName ===
                      node.data.requiredTool,
                  );
                if (requiresPdf && !(await currentReport(runId, node.id)))
                  throw new Error(
                    "Agent finished without a current required PDF report",
                  );
                await complete(
                  node.id,
                  {
                    ...(reportsEnabled
                      ? { report: await currentReport(runId, node.id) }
                      : {}),
                    text: local.pending.parts
                      ?.map((p) => p.text ?? "")
                      .join(""),
                    turns: local.turn + 1,
                  },
                  next(node.id),
                );
                finished = true;
                break;
              }
            }
            const results: NonNullable<Message["parts"]> = [];
            for (const [index, call] of calls.entries()) {
              const structured = correction
                ? { ok: false, error: correction }
                : await invoke(
                    call.name!,
                    call.args ?? {},
                    state.legacyCalls && node.id === firstAgent
                      ? `${runId}:${local.turn}:${index}`
                      : `${runId}:${node.id}:${local.turn}:${index}`,
                  );
              if (structured.ok && !local.successes.includes(call.name!))
                local.successes.push(call.name!);
              results.push({
                functionResponse: {
                  id: call.id,
                  name: call.name,
                  response: structured,
                },
              });
            }
            local.messages.push(local.pending, {
              role: "user",
              parts: results.length ? results : [{ text: correction! }],
            });
            local.pending = undefined;
            local.turn++;
            await checkpointState();
          }
          if (!finished) throw new Error("Agent exceeded the ten turn limit");
        }
        // Transport cleanup cannot undo an already committed step.
        await session.close().catch(() => console.error("MCP cleanup failed"));
        session = undefined;
      }
      await query(
        "UPDATE runs SET status='succeeded',finished_at=now() WHERE id=$1",
        [runId],
      );
      terminal = true;
    } catch (error) {
      const transient = await recordRunFailure(
        runId,
        activeNode,
        error,
        overrides.attempt,
      );
      terminal = !transient;
      if (transient) throw error;
    } finally {
      await session?.close().catch(() => console.error("MCP cleanup failed"));
      if (terminal)
        await cleanupProviderFiles(runId, overrides.provider).catch(() =>
          console.error("Provider cleanup deferred"),
        );
    }
  });
}

export async function cleanupProviderFiles(runId: string, provider?: Provider) {
  for (const file of await query(
    "SELECT * FROM provider_files WHERE run_id=$1",
    [runId],
  )) {
    const adapter =
      provider ??
      new GeminiProvider(await resolveCredential(file.credential_id, "gemini"));
    await adapter.remove(file.name);
    await query("DELETE FROM provider_files WHERE name=$1", [file.name]);
  }
}
export async function maintenance() {
  const boss = await getBoss();
  for (const candidate of await query(
    "SELECT id FROM runs r WHERE status IN ('running','queued') OR (status IN ('failed','needs_review') AND EXISTS(SELECT 1 FROM steps s WHERE s.run_id=r.id AND s.status IN ('running','retrying')))",
  )) {
    try {
      await withRunLock(candidate.id, async () => {
        const [run] = await query(
          "SELECT r.*,c.state,v.snapshot FROM runs r JOIN versions v ON v.id=r.version_id LEFT JOIN checkpoints c ON c.run_id=r.id WHERE r.id=$1",
          [candidate.id],
        );
        if (run && ["failed", "needs_review"].includes(run.status)) {
          await query(
            "UPDATE steps SET status=$2,output=jsonb_build_object('error',$3::text) WHERE run_id=$1 AND status IN ('running','retrying')",
            [run.id, run.status, run.error],
          );
          return;
        }
        if (!run || !["running", "queued"].includes(run.status)) return;
        if (hasTerminalCheckpoint(run.state)) {
          await query(
            "UPDATE runs SET status='succeeded',error=NULL,finished_at=coalesce(finished_at,now()) WHERE id=$1",
            [run.id],
          );
          return;
        }
        const deadline =
          run.deadline_at ??
          (run.started_at
            ? new Date(
                new Date(run.started_at).getTime() +
                  (run.snapshot.workflow.executionTimeoutSeconds ?? 300) * 1000,
              )
            : null);
        if (!run.queue_job_id) {
          const jobs = await boss.findJobs(QUEUE, { key: run.id });
          const previous = jobs.sort(
            (a, b) =>
              new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime(),
          )[0];
          if (previous) {
            run.queue_job_id = previous.id;
            await query("UPDATE runs SET queue_job_id=$2 WHERE id=$1", [
              run.id,
              previous.id,
            ]);
          }
        }
        const job = run.queue_job_id
          ? await boss.getJobById(QUEUE, run.queue_job_id)
          : undefined;
        if (deadline && new Date(deadline).getTime() <= Date.now())
          await recordRunFailure(run.id, "", new DeadlineError());
        else if (
          job === null ||
          (job && ["failed", "cancelled", "completed"].includes(job.state))
        )
          await recordRunFailure(run.id, "", new RetryExhaustedError());
      });
    } catch (error) {
      if (!(error instanceof RetryError)) throw error;
    }
  }
  await dispatchSystemNotices();
  await reconcileSystemNotices();
  for (const row of await query(
    "SELECT DISTINCT f.run_id FROM provider_files f JOIN runs r ON r.id=f.run_id WHERE r.status IN ('succeeded','failed','needs_review')",
  ))
    await cleanupProviderFiles(row.run_id).catch(() =>
      console.error("Provider cleanup deferred"),
    );
  await cleanupReports();
  await cleanupTemplateResources();
  const storage = new LocalStorage();
  await storage.expireOrphans(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  for (const row of await query(
    "SELECT * FROM attachments WHERE expires_at<now()",
  )) {
    await storage.delete(row.storage_key);
    await query("DELETE FROM attachments WHERE id=$1", [row.id]);
  }
}
