import { TEMPLATE_PROFILE } from "../../contracts/src/pdf-templates";
import {
  copyTemplateResources,
  validateTemplateResources,
} from "./template-resources";
import { TemplateResourceStorage } from "../../connectors/src/template-resources";
import { REPORT_PROFILE } from "../../contracts/src/reports";
import { ReportStorage } from "../../connectors/src/reports";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import {
  query,
  transaction,
  resolveCredential,
} from "../../persistence/src/index";
import {
  workflowSchema,
  ConfigurationError,
  validateWorkflow,
  type Snapshot,
  type ToolDefinition,
  type Workflow,
} from "../../contracts/src/index";
import { validateTool } from "../../mcp/src/index";
import { inboundSchema, syntheticEmail } from "../../connectors/src/index";
export const QUEUE = "workflow-runs";
export const NOTICE_QUEUE = "system-notices";
export class WorkflowNotFoundError extends ConfigurationError {}

export async function createWorkflow(
  name: string,
  duplicateFromWorkflowId?: string,
) {
  return transaction(async (client) => {
    let draft: Workflow = { name, nodes: [], edges: [] };
    if (duplicateFromWorkflowId !== undefined) {
      // Saves, deletion, uploads and resource maintenance take this same lock.
      const {
        rows: [source],
      } = await client.query(
        "SELECT draft FROM workflows WHERE id=$1 FOR UPDATE",
        [duplicateFromWorkflowId],
      );
      if (!source)
        throw new WorkflowNotFoundError(
          "Source workflow not found. Choose another workflow to duplicate.",
        );
      draft = workflowSchema.parse(source.draft);
      draft.name = name;
      for (const node of draft.nodes)
        if (node.type === "email") node.data.recipient = "";
    }
    draft = workflowSchema.parse(draft);
    const id = randomUUID();
    await client.query("INSERT INTO workflows(id,draft) VALUES($1,$2)", [
      id,
      JSON.stringify(draft),
    ]);
    if (duplicateFromWorkflowId !== undefined) {
      await copyTemplateResources(duplicateFromWorkflowId, id, draft, client);
      await client.query("UPDATE workflows SET draft=$2 WHERE id=$1", [
        id,
        JSON.stringify(draft),
      ]);
    }
    return { id, draft };
  });
}
let bossPromise: Promise<PgBoss> | undefined;
export function getBoss() {
  return (bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    boss.on("error", () => console.error("Queue operation failed"));
    await boss.start();
    const options = {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 600,
      heartbeatSeconds: 30,
    };
    await boss.createQueue(QUEUE, options);
    await boss.updateQueue(QUEUE, options);
    await boss.createQueue(NOTICE_QUEUE, { ...options, expireInSeconds: 60 });
    return boss;
  })().catch((error) => {
    bossPromise = undefined;
    throw error;
  }));
}
export async function dispatchOutbox() {
  const boss = await getBoss();
  const rows = await query(
    "SELECT run_id FROM outbox WHERE sent_at IS NULL LIMIT 100",
  );
  for (const row of rows)
    await transaction(async (client) => {
      const {
        rows: [record],
      } = await client.query(
        "SELECT o.sent_at,r.deadline_at,v.snapshot FROM outbox o JOIN runs r ON r.id=o.run_id JOIN versions v ON v.id=r.version_id WHERE o.run_id=$1 FOR UPDATE OF o",
        [row.run_id],
      );
      if (!record || record.sent_at) return;
      const seconds = record.deadline_at
        ? Math.max(
            1,
            Math.ceil(
              (new Date(record.deadline_at).getTime() - Date.now()) / 1000,
            ),
          )
        : (record.snapshot.workflow.executionTimeoutSeconds ?? 300);
      const jobId = await boss.send(
        QUEUE,
        { runId: row.run_id },
        {
          singletonKey: row.run_id,
          expireInSeconds: seconds,
          db: { executeSql: (sql, values) => client.query(sql, values) },
        },
      );
      if (!jobId) throw new Error("Run queue association failed");
      await client.query("UPDATE runs SET queue_job_id=$2 WHERE id=$1", [
        row.run_id,
        jobId,
      ]);
      await client.query("UPDATE outbox SET sent_at=now() WHERE run_id=$1", [
        row.run_id,
      ]);
    });
}
export async function publish(id: string) {
  return transaction(async (client) => {
    const {
      rows: [row],
    } = await client.query("SELECT * FROM workflows WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    if (!row) throw new ConfigurationError("Workflow not found");
    const workflow = workflowSchema.parse(row.draft);
    for (const node of workflow.nodes)
      if (node.type === "agent" && node.data.generatePdf)
        node.data.rendererProfile = REPORT_PROFILE;
    for (const node of workflow.nodes)
      if (node.type === "pdf_template")
        node.data.rendererProfile = TEMPLATE_PROFILE;
    await validateTemplateResources(id, workflow, client);
    const ids = workflow.nodes
      .filter((n) => n.type === "tool" || n.type === "action")
      .map((n) => n.data.toolId);
    const { rows: toolRows } = await client.query(
      "SELECT definition FROM tools WHERE id=ANY($1::text[])",
      [ids],
    );
    const tools = toolRows.map((r) => r.definition as ToolDefinition);
    const errors = validateWorkflow(workflow, tools);
    if (errors.length) throw new ConfigurationError(errors.join(" "));
    for (const tool of tools) {
      validateTool(tool);
      if (tool.auth.type !== "none")
        await resolveCredential(tool.auth.credentialId!, "api");
    }
    for (const node of workflow.nodes.filter(
      (n) => n.type === "agent" && n.data.provider !== "mock",
    ))
      await resolveCredential(
        node.data.credentialId!,
        node.data.provider as "gemini" | "openai" | "claude",
      );
    const {
      rows: [count],
    } = await client.query(
      "SELECT coalesce(max(number),0)+1 AS number FROM versions WHERE workflow_id=$1",
      [id],
    );
    const versionId = randomUUID();
    const snapshot: Snapshot = { workflow, tools };
    await client.query(
      "INSERT INTO versions(id,workflow_id,number,snapshot) VALUES($1,$2,$3,$4)",
      [versionId, id, count.number, JSON.stringify(snapshot)],
    );
    await client.query(
      "UPDATE workflows SET published_version=$2,recipient=$3 WHERE id=$1",
      [
        id,
        versionId,
        workflow.nodes
          .find((n) => n.type === "email")!
          .data.recipient!.toLowerCase(),
      ],
    );
    return { id: versionId, number: count.number };
  });
}
export async function ingest(payload: unknown) {
  const event = inboundSchema.parse(payload);
  const recipient = event.data.to.map((x) => x.toLowerCase());
  const result = await transaction(async (client) => {
    const { rows: inserted } = await client.query(
      "INSERT INTO emails(id,provider_id,raw) VALUES($1,$2,$3) ON CONFLICT(provider_id) DO NOTHING RETURNING id",
      [randomUUID(), event.data.email_id, JSON.stringify(event)],
    );
    // A duplicate delivery must never bind the same email to a newer publication.
    if (!inserted.length) {
      const { rows: existing } = await client.query(
        "SELECT r.id FROM runs r JOIN emails e ON e.id=r.email_id WHERE e.provider_id=$1",
        [event.data.email_id],
      );
      return {
        accepted: existing.length > 0,
        runIds: existing.map((r) => r.id),
      };
    }
    const email = inserted[0];
    const { rows: workflows } = await client.query(
      "SELECT published_version FROM workflows WHERE recipient=ANY($1::text[]) AND published_version IS NOT NULL",
      [recipient],
    );
    if (!workflows.length) return { accepted: false, runIds: [] as string[] };
    const runIds: string[] = [];
    for (const workflow of workflows) {
      const {
        rows: [run],
      } = await client.query(
        "INSERT INTO runs(id,version_id,email_id) VALUES($1,$2,$3) ON CONFLICT(email_id,version_id) DO UPDATE SET email_id=excluded.email_id RETURNING id",
        [randomUUID(), workflow.published_version, email.id],
      );
      await client.query(
        "INSERT INTO outbox(run_id) VALUES($1) ON CONFLICT DO NOTHING",
        [run.id],
      );
      runIds.push(run.id);
    }
    return { accepted: true, runIds };
  });
  // Durable outbox survives queue outages. A failed send returns 503; signed retries deduplicate.
  await dispatchOutbox();
  return result;
}
export async function testRun(workflowId: string) {
  const [workflow] = await query(
    "SELECT published_version FROM workflows WHERE id=$1",
    [workflowId],
  );
  if (!workflow?.published_version)
    throw new ConfigurationError("Publish the workflow before testing");
  const id = randomUUID(),
    runId = randomUUID();
  const email = await syntheticEmail(id);
  await transaction(async (client) => {
    await client.query(
      "INSERT INTO emails(id,provider_id,payload,raw) VALUES($1,$2,$3,$4)",
      [id, "test:" + id, JSON.stringify(email), JSON.stringify({ test: true })],
    );
    for (const a of email.attachments)
      await client.query(
        "INSERT INTO attachments(id,email_id,storage_key,metadata,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
        [id + ":" + a.id, id, a.storageKey, JSON.stringify(a)],
      );
    await client.query(
      "INSERT INTO runs(id,version_id,email_id) VALUES($1,$2,$3)",
      [runId, workflow.published_version, id],
    );
    await client.query("INSERT INTO outbox(run_id) VALUES($1)", [runId]);
  });
  await dispatchOutbox();
  return { id: runId };
}
export async function saveDraft(id: string, draft: Workflow) {
  const parsed = workflowSchema.parse(draft);
  await transaction(async (client) => {
    await client.query(
      "INSERT INTO workflows(id,draft) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [id, JSON.stringify(parsed)],
    );
    await client.query("SELECT id FROM workflows WHERE id=$1 FOR UPDATE", [id]);
    await validateTemplateResources(id, parsed, client);
    await client.query("UPDATE workflows SET draft=$2 WHERE id=$1", [
      id,
      JSON.stringify(parsed),
    ]);
  });
}
export async function deleteWorkflow(id: string) {
  const files = await transaction(async (client) => {
    await client.query("SELECT id FROM workflows WHERE id=$1 FOR UPDATE", [id]);
    const { rows: runs } = await client.query(
      "SELECT r.id,r.status FROM runs r JOIN versions v ON v.id=r.version_id WHERE v.workflow_id=$1",
      [id],
    );
    if (runs.some((r) => ["queued", "running"].includes(r.status)))
      throw new ConfigurationError(
        "Wait for the workflow's active runs to finish before deleting it",
      );
    const ids = runs.map((r) => r.id);
    for (const runId of ids) {
      const {
        rows: [lock],
      } = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [runId],
      );
      if (!lock.acquired)
        throw new ConfigurationError(
          "Wait for active run or system notice delivery before deleting it",
        );
    }
    const { rows: files } = await client.query(
      "SELECT id FROM generated_reports WHERE run_id=ANY($1::text[])",
      [ids],
    );
    await client.query(
      "DELETE FROM report_attempts WHERE run_id=ANY($1::text[])",
      [ids],
    );
    await client.query(
      "DELETE FROM generated_reports WHERE run_id=ANY($1::text[])",
      [ids],
    );
    for (const table of [
      "system_notices",
      "email_sends",
      "provider_files",
      "outbox",
      "checkpoints",
      "tool_calls",
      "steps",
    ])
      await client.query(`DELETE FROM ${table} WHERE run_id=ANY($1::text[])`, [
        ids,
      ]);
    await client.query("DELETE FROM runs WHERE id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM versions WHERE workflow_id=$1", [id]);
    const { rows: images } = await client.query(
      "DELETE FROM template_resources WHERE workflow_id=$1 RETURNING id",
      [id],
    );
    const { rowCount } = await client.query(
      "DELETE FROM workflows WHERE id=$1",
      [id],
    );
    if (!rowCount) throw new ConfigurationError("Workflow not found");
    return { reports: files, images };
  });
  // A failed unlink is retried by orphan maintenance; never delete bytes before commit.
  for (const image of files.images)
    await new TemplateResourceStorage()
      .delete(image.id)
      .catch(() => console.error("Template image cleanup deferred"));
  for (const file of files.reports)
    await new ReportStorage()
      .delete(file.id)
      .catch(() => console.error("Report cleanup deferred"));
}
