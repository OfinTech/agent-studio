import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  unique,
  check,
} from "drizzle-orm/pg-core";
import type {
  Workflow,
  Snapshot,
  Email,
  EmailMessage,
  ToolDefinition,
} from "../../contracts/src/index";
const created = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  draft: jsonb("draft").$type<Workflow>().notNull(),
  publishedVersion: text("published_version"),
  recipient: text("recipient").unique(),
  createdAt: created(),
});
export const versions = pgTable(
  "versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    number: integer("number").notNull(),
    snapshot: jsonb("snapshot").$type<Snapshot>().notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("version_number").on(t.workflowId, t.number)],
);
export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  encrypted: text("encrypted").notNull(),
  createdAt: created(),
});
export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  definition: jsonb("definition").$type<ToolDefinition>().notNull(),
  createdAt: created(),
});
export const emails = pgTable("emails", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().unique(),
  payload: jsonb("payload").$type<Email>(),
  raw: jsonb("raw").notNull(),
  replyEnvelope:
    jsonb("reply_envelope").$type<
      import("../../contracts/src/index").ReplyEnvelope
    >(),
  createdAt: created(),
});
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey(),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.id),
  storageKey: text("storage_key").notNull(),
  metadata: jsonb("metadata").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    queueJobId: text("queue_job_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("run_email_version").on(t.emailId, t.versionId)],
);
export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull(),
    output: jsonb("output"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("run_node").on(t.runId, t.nodeId)],
);
export const toolCalls = pgTable(
  "tool_calls",
  {
    nodeId: text("node_id"),
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    name: text("name").notNull(),
    args: jsonb("args").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    createdAt: created(),
  },
  (t) => [index("tool_calls_run_node").on(t.runId, t.nodeId)],
);
export const checkpoints = pgTable("checkpoints", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  state: jsonb("state").notNull(),
});
export const outbox = pgTable("outbox", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
export const providerFiles = pgTable("provider_files", {
  name: text("name").primaryKey(),
  credentialId: text("credential_id").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  createdAt: created(),
});
export const loginAttempts = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowAt: timestamp("window_at", { withTimezone: true }).notNull(),
});

export const emailSends = pgTable(
  "email_sends",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    nodeId: text("node_id").notNull(),
    message: jsonb("message").$type<EmailMessage>().notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    providerEmailId: text("provider_email_id"),
    error: text("error"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("email_sends_run_node").on(t.runId, t.nodeId)],
);
export const mockReceipts = pgTable("mock_receipts", {
  key: text("key").primaryKey(),
  id: text("id").notNull(),
  receipt: jsonb("receipt").notNull(),
  createdAt: created(),
});
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const generatedReports = pgTable(
  "generated_reports",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    nodeId: text("node_id").notNull(),
    checksum: text("checksum").notNull(),
    size: integer("size").notNull(),
    pageCount: integer("page_count").notNull(),
    extractedText: text("extracted_text"),
    textTruncated: boolean("text_truncated").notNull(),
    createdAt: created(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (t) => [
    index("generated_reports_run").on(t.runId),
    check(
      "generated_reports_size_check",
      sql`${t.size} > 0 AND ${t.size} <= 10485760`,
    ),
    check(
      "generated_reports_page_count_check",
      sql`${t.pageCount} BETWEEN 1 AND 20`,
    ),
  ],
);
export const reportAttempts = pgTable(
  "report_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    nodeId: text("node_id").notNull(),
    attemptOrder: integer("attempt_order").notNull(),
    sourceHash: text("source_hash").notNull(),
    generationFingerprint: text("generation_fingerprint"),
    templateNodeId: text("template_node_id"),
    rendererProfile: text("renderer_profile").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    reportId: text("report_id").references(() => generatedReports.id),
    createdAt: created(),
  },
  (t) => [
    unique("report_attempts_run_id_node_id_attempt_order_key").on(
      t.runId,
      t.nodeId,
      t.attemptOrder,
    ),
    index("report_attempts_run_node").on(t.runId, t.nodeId),
    check(
      "report_attempts_status_check",
      sql`${t.status} IN ('running','succeeded','failed')`,
    ),
  ],
);

export const templateResources = pgTable(
  "template_resources",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    metadata: jsonb("metadata")
      .$type<import("../../contracts/src/pdf-templates").ImageResource>()
      .notNull(),
    createdAt: created(),
  },
  (t) => [index("template_resources_workflow").on(t.workflowId)],
);

export const systemNotices = pgTable("system_notices", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  message: jsonb("message").$type<EmailMessage>(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  suppressionReason: text("suppression_reason"),
  queueJobId: text("queue_job_id"),
  attempts: integer("attempts").notNull().default(0),
  uncertain: boolean("uncertain").notNull().default(false),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  providerEmailId: text("provider_email_id"),
  error: text("error"),
  createdAt: created(),
});
