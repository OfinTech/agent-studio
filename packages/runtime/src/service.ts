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
let bossPromise: Promise<PgBoss> | undefined;
export function getBoss() {
  return (bossPromise ??= (async () => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    boss.on("error", () => console.error("Queue operation failed"));
    await boss.start();
    await boss.createQueue(QUEUE, {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 360,
      heartbeatSeconds: 30,
    });
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
  for (const row of rows) {
    await boss.send(QUEUE, { runId: row.run_id }, { singletonKey: row.run_id });
    await query("UPDATE outbox SET sent_at=now() WHERE run_id=$1", [
      row.run_id,
    ]);
  }
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
  await query(
    "INSERT INTO workflows(id,draft) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft",
    [id, JSON.stringify(parsed)],
  );
}
