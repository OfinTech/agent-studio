import { receiptTool, receiptWorkflow } from "../fixtures/receipt-workflow";
import sharp from "sharp";
import {
  defaultPdfTemplate,
  TEMPLATE_PROFILE,
  LEGACY_TEMPLATE_PROFILE,
} from "../packages/contracts/src/pdf-templates";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import pg from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  addOutcome,
  type Workflow,
  type ToolDefinition,
} from "../packages/contracts/src/index";
import { MockProvider, type Message } from "../packages/providers/src/index";
import { NetworkError } from "../packages/connectors/src/network";
const suite = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;
suite("PostgreSQL execution and recovery", () => {
  let persistence: typeof import("../packages/persistence/src/index");
  let runtime: typeof import("../packages/runtime/src/index");
  let connectors: typeof import("../packages/connectors/src/index");
  let admin: pg.Pool;
  let database: string;
  let storage: string;
  beforeAll(async () => {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* CI supplies environment */
    }
    const base =
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://platform:platform@localhost:5438/platform";
    const url = new URL(base);
    database = "platform_test_" + randomBytes(6).toString("hex");
    url.pathname = "/postgres";
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE DATABASE "${database}"`);
    url.pathname = "/" + database;
    process.env.DATABASE_URL = url.toString();
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.TOOL_ALLOW_PRIVATE_ORIGINS = "http://localhost:4010";
    storage = await mkdtemp(join(tmpdir(), "agent-platform-test-"));
    process.env.ATTACHMENT_DIR = storage;
    persistence = await import("../packages/persistence/src/index");
    runtime = await import("../packages/runtime/src/index");
    connectors = await import("../packages/connectors/src/index");
    await migrate(persistence.db, {
      migrationsFolder: "packages/persistence/migrations",
    });
    await (
      await import("../packages/persistence/src/settings")
    ).saveSetting("TOOL_ALLOWED_ORIGINS", "http://localhost:4010");
    await persistence.query("INSERT INTO tools(id,definition) VALUES($1,$2)", [
      receiptTool.id,
      JSON.stringify(receiptTool),
    ]);
  });
  afterAll(async () => {
    if (runtime) await (await runtime.getBoss()).stop({ graceful: true });
    if (persistence) await persistence.pool.end();
    if (admin) {
      // Pool.end can resolve before PostgreSQL processes every socket close.
      // Wait for disconnection instead of terminating those clients mid-close.
      await vi.waitFor(
        async () => {
          const result = await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
            [database],
          );
          expect(result.rows[0].count).toBe(0);
        },
        { timeout: 5000 },
      );
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
    if (storage) await rm(storage, { recursive: true, force: true });
  });
  async function workflow(
    configure?: (w: Workflow) => void,
    tool?: ToolDefinition,
  ) {
    const id = randomUUID();
    const draft = structuredClone(receiptWorkflow);
    draft.nodes[0].data.recipient = id + "@example.com";
    if (tool) {
      await persistence.query(
        "INSERT INTO tools(id,definition) VALUES($1,$2)",
        [tool.id, JSON.stringify(tool)],
      );
      draft.nodes[3].data.toolId = tool.id;
    }
    configure?.(draft);
    await runtime.saveDraft(id, draft);
    const version = await runtime.publish(id);
    return { id, draft, version };
  }
  async function runFor(versionId: string) {
    const emailId = randomUUID(),
      id = randomUUID();
    const email = await connectors.syntheticEmail(emailId);
    await persistence.query(
      "INSERT INTO emails(id,provider_id,payload,raw) VALUES($1,$2,$3,$4)",
      [emailId, "test:" + emailId, JSON.stringify(email), "{}"],
    );
    await persistence.query(
      "INSERT INTO runs(id,version_id,email_id) VALUES($1,$2,$3)",
      [id, versionId, emailId],
    );
    return { id, email };
  }
  async function status(id: string) {
    return (await persistence.query("SELECT * FROM runs WHERE id=$1", [id]))[0];
  }
  it("publishes immutable snapshots and completes only after a successful receipt API response", async () => {
    const w = await workflow();
    w.draft.nodes[2].data.systemPrompt = "edited draft";
    await runtime.saveDraft(w.id, w.draft);
    const [version] = await persistence.query(
      "SELECT snapshot FROM versions WHERE id=$1",
      [w.version.id],
    );
    expect(version.snapshot.workflow.nodes[2].data.systemPrompt).not.toBe(
      "edited draft",
    );
    const run = await runFor(w.version.id);
    let calls = 0;
    await runtime.executeRun(run.id, {
      dispatch: async (_tool, args) => {
        calls++;
        expect(args).toMatchObject({ merchant: "Paper & Pine", total: 42.5 });
        return { ok: true, data: { accepted: true } };
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(
      await persistence.query("SELECT * FROM steps WHERE run_id=$1", [run.id]),
    ).toHaveLength(3);
  });
  it("deduplicates concurrent webhooks even after a new publication", async () => {
    const w = await workflow();
    const event = {
      type: "email.received",
      data: { email_id: randomUUID(), to: [w.draft.nodes[0].data.recipient] },
    };
    const [a, b] = await Promise.all([
      runtime.ingest(event),
      runtime.ingest(event),
    ]);
    expect(a.runIds).toEqual(b.runIds);
    await runtime.publish(w.id);
    const c = await runtime.ingest(event);
    expect(c.runIds).toEqual(a.runIds);
    expect(
      await persistence.query("SELECT run_id FROM outbox WHERE run_id=$1", [
        a.runIds[0],
      ]),
    ).toHaveLength(1);
    const [run] = await persistence.query(
      "SELECT version_id FROM runs WHERE id=$1",
      [a.runIds[0]],
    );
    expect(run.version_id).toBe(w.version.id);
  });
  it("resumes a checkpoint after a provider failure without repeating the API write", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    let writes = 0;
    class InterruptedProvider extends MockProvider {
      override async infer(
        ...args: Parameters<MockProvider["infer"]>
      ): Promise<Message> {
        if (args[0].some((m) => m.parts?.some((p) => p.functionResponse)))
          throw new NetworkError("Temporary model failure", false, true);
        return super.infer(...args);
      }
    }
    await expect(
      runtime.executeRun(run.id, {
        provider: new InterruptedProvider(),
        dispatch: async () => {
          writes++;
          return { ok: true, data: { accepted: true } };
        },
      }),
    ).rejects.toThrow();
    expect((await status(run.id)).status).toBe("queued");
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        writes++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(writes).toBe(1);
  });
  it("replays a transient tool failure using the same idempotency key", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    const keys: string[] = [];
    await expect(
      runtime.executeRun(run.id, {
        dispatch: async (_t, _a, key) => {
          keys.push(key);
          return { ok: false, retryable: true };
        },
      }),
    ).rejects.toThrow();
    await runtime.executeRun(run.id, {
      dispatch: async (_t, _a, key) => {
        keys.push(key);
        return { ok: true };
      },
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await status(run.id)).status).toBe("succeeded");
  });
  it("preserves review-required results through the MCP transport", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      dispatch: async () => ({
        ok: false,
        review: true,
        error: "Uncertain API response",
      }),
    });
    expect((await status(run.id)).status).toBe("needs_review");
    let calls = 0;
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect(calls).toBe(0);
  });
  it("does not resubmit a non-idempotent write left in flight by a crashed worker", async () => {
    const t = {
      ...receiptTool,
      id: randomUUID(),
      idempotencyHeader: undefined,
    };
    const w = await workflow(undefined, t);
    const run = await runFor(w.version.id);
    const provider = new MockProvider();
    const pending = await provider.infer(
      [{ role: "user", parts: [{ text: run.email.text }] }],
      w.draft.nodes[2].data,
      [t],
      AbortSignal.timeout(5000),
    );
    await persistence.query(
      "INSERT INTO checkpoints(run_id,state) VALUES($1,$2)",
      [
        run.id,
        JSON.stringify({
          files: [],
          messages: [],
          turn: 0,
          pending,
          successes: [],
        }),
      ],
    );
    await persistence.query(
      "INSERT INTO tool_calls(id,run_id,name,args,status) VALUES($1,$2,$3,$4,'running')",
      [
        run.id + ":0:0",
        run.id,
        t.name,
        JSON.stringify(pending.parts![0].functionCall!.args),
      ],
    );
    let calls = 0;
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("needs_review");
    expect(calls).toBe(0);
  });
  it("fails missing attachments and never calls the API", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    run.email.attachments = [];
    await persistence.query("UPDATE emails SET payload=$2 WHERE id=$1", [
      run.email.id,
      JSON.stringify(run.email),
    ]);
    let calls = 0;
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("failed");
    expect(calls).toBe(0);
  });
  it("does not count a model completion as successful when the API rejects the receipt", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      dispatch: async () => ({ ok: false, error: "API rejected receipt" }),
    });
    expect((await status(run.id)).status).toBe("failed");
    expect((await status(run.id)).error).toMatch(/without a successful/);
  });
  it("restores durable state after an actual worker process is killed", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/helpers/interrupted-worker.ts", run.id],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("Worker did not checkpoint")),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("CHECKPOINTED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("Worker exited early: " + code));
        });
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      let repeats = 0;
      await runtime.executeRun(run.id, {
        dispatch: async () => {
          repeats++;
          return { ok: true };
        },
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(repeats).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
  it("prevents database-level mutation of published versions", async () => {
    const w = await workflow();
    await expect(
      persistence.query("UPDATE versions SET snapshot=$2 WHERE id=$1", [
        w.version.id,
        "{}",
      ]),
    ).rejects.toThrow(/immutable/);
  });
  it("rejects unknown prompt variables before publishing", async () => {
    await expect(
      workflow((w) => {
        w.nodes[2].data.userPrompt = "{{credentials.secret}}";
      }),
    ).rejects.toThrow(/prompt variables/);
  });
  it("bounds endless model tool calls and records invalid arguments", async () => {
    const w = await workflow();
    const run = await runFor(w.version.id);
    class InvalidProvider extends MockProvider {
      override async infer(): Promise<Message> {
        return {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "submit_receipt",
                args: { total: "invalid" },
              },
            },
          ],
        };
      }
    }
    let calls = 0;
    await runtime.executeRun(run.id, {
      provider: new InvalidProvider(),
      dispatch: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("failed");
    expect((await status(run.id)).error).toContain("ten turn limit");
    expect(calls).toBe(0);
    expect(
      await persistence.query(
        "SELECT id FROM tool_calls WHERE run_id=$1 AND status='failed'",
        [run.id],
      ),
    ).toHaveLength(10);
  });
  it("cleans provider files after attachment processing failure", async () => {
    const credentialId = randomUUID();
    await persistence.query(
      "INSERT INTO credentials(id,name,kind,encrypted) VALUES($1,$2,$3,$4)",
      [
        credentialId,
        "test key",
        "gemini",
        persistence.encrypt("synthetic-key", credentialId),
      ],
    );
    const w = await workflow((w) => {
      w.nodes[2].data.provider = "gemini";
      w.nodes[2].data.credentialId = credentialId;
    });
    const run = await runFor(w.version.id);
    const removed: string[] = [];
    class FailedFileProvider extends MockProvider {
      override async upload(
        ...args: Parameters<MockProvider["upload"]>
      ): Promise<never> {
        await args[3]("files/failed-test");
        throw new Error("Provider attachment processing failed");
      }
      override async remove(name: string) {
        removed.push(name);
      }
    }
    await runtime.executeRun(run.id, { provider: new FailedFileProvider() });
    expect((await status(run.id)).status).toBe("failed");
    expect(removed).toEqual(["files/failed-test"]);
    expect(
      await persistence.query(
        "SELECT name FROM provider_files WHERE run_id=$1",
        [run.id],
      ),
    ).toHaveLength(0);
  });
  async function outcomeWorkflow(terminal = false) {
    return workflow((w) => {
      Object.assign(w, addOutcome(w, "agent", "outcome"));
      w.nodes
        .find((n) => n.id === "outcome")!
        .data.states!.push({
          id: "review",
          name: "Review",
          criteria: "Needs manual review",
        });
      if (!terminal)
        for (const state of ["success", "failure", "review"]) {
          w.nodes.push({
            id: state + "-action",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: state,
              toolId: receiptTool.id,
              arguments: {
                merchant: "{{steps.agent.outcome.result}}",
                date: "2026-09-09",
                currency: "USD",
                total: "{{steps.upload.count}}",
              },
            },
          });
          w.edges.push({
            id: state + "-edge",
            source: "outcome",
            target: state + "-action",
            kind: "execution",
            stateId: state,
          });
        }
    });
  }
  class ReportProvider extends MockProvider {
    constructor(private reports: Message[]) {
      super();
    }
    seen: Message[][] = [];
    override async infer(messages: Message[]): Promise<Message> {
      this.seen.push(structuredClone(messages));
      return this.reports.shift() ?? report("success");
    }
  }
  function report(state: string): Message {
    return {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "report",
            name: "finish_task",
            args: {
              state,
              reason: "Synthetic reason",
              result: "Synthetic result",
            },
          },
        },
      ],
    };
  }
  for (const branch of ["success", "failure", "review"])
    it(`executes only ${branch}, with typed action inputs and a technically successful run`, async () => {
      const w = await outcomeWorkflow(),
        run = await runFor(w.version.id);
      let actions = 0;
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([report(branch)]),
        dispatch: async (_t, args) => {
          actions++;
          expect(args).toMatchObject({
            merchant: "Synthetic result",
            total: 1,
          });
          return { ok: true, data: { accepted: true } };
        },
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(actions).toBe(1);
      const steps = await persistence.query(
        "SELECT * FROM steps WHERE run_id=$1",
        [run.id],
      );
      expect(steps.find((s) => s.node_id === "agent").output).toMatchObject({
        outcome: {
          state: branch,
          reason: "Synthetic reason",
          result: "Synthetic result",
        },
        nextNode: branch + "-action",
      });
      expect(
        steps
          .filter((s) => s.node_id.endsWith("-action"))
          .map((s) => s.node_id),
      ).toEqual([branch + "-action"]);
      const calls = await persistence.query(
        "SELECT * FROM tool_calls WHERE run_id=$1",
        [run.id],
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].node_id).toBe(branch + "-action");
      expect(calls[0].name).not.toBe("finish_task");
    });
  it("terminates an unconnected state without selecting Failure or enforcing the legacy required tool", async () => {
    const w = await outcomeWorkflow(true),
      run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      provider: new ReportProvider([report("review")]),
      dispatch: async () => {
        throw new Error("must not dispatch");
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(
      await persistence.query("SELECT * FROM tool_calls WHERE run_id=$1", [
        run.id,
      ]),
    ).toHaveLength(0);
  });
  it("corrects missing, unknown, malformed, conflicting and mixed reports before dispatching actions", async () => {
    const bad: Message[] = [
      { role: "model", parts: [{ text: "done" }] },
      report("unknown"),
      {
        role: "model",
        parts: [
          { functionCall: { name: "finish_task", args: { state: "success" } } },
        ],
      },
      {
        role: "model",
        parts: [...report("success").parts!, ...report("failure").parts!],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "submit_receipt",
              args: {
                merchant: "x",
                total: 1,
                currency: "USD",
                date: "2026-09-09",
              },
            },
          },
          ...report("success").parts!,
        ],
      },
    ];
    const w = await outcomeWorkflow(true);
    for (const invalid of bad) {
      const run = await runFor(w.version.id),
        provider = new ReportProvider([invalid, report("success")]);
      let dispatched = 0;
      await runtime.executeRun(run.id, {
        provider,
        dispatch: async () => {
          dispatched++;
          return { ok: true };
        },
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(dispatched).toBe(0);
      expect(provider.seen).toHaveLength(2);
      expect(provider.seen[1].at(-1)?.parts?.length).toBeGreaterThan(0);
    }
  });
  it("missing reports exhaust the per-agent limit without implicit Failure", async () => {
    const w = await outcomeWorkflow(),
      run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      provider: new ReportProvider(
        Array.from({ length: 10 }, () => ({
          role: "model",
          parts: [{ text: "finished" }],
        })),
      ),
    });
    expect(await status(run.id)).toMatchObject({
      status: "failed",
      error: "Agent exceeded the ten turn limit",
    });
    expect(
      await persistence.query(
        "SELECT * FROM steps WHERE run_id=$1 AND node_id='outcome'",
        [run.id],
      ),
    ).toHaveLength(0);
  });
  for (const when of ["before", "after"] as const)
    it(`recovers immediately ${when} atomic outcome acceptance`, async () => {
      const w = await outcomeWorkflow(),
        run = await runFor(w.version.id);
      let interrupted = false,
        actions = 0;
      await expect(
        runtime.executeRun(run.id, {
          provider: new ReportProvider([report("review")]),
          dispatch: async () => {
            actions++;
            return { ok: true };
          },
          afterCheckpoint: async (s) => {
            if (
              !interrupted &&
              (when === "before"
                ? !!s.nodes.agent?.pending
                : s.cursor === "review-action")
            ) {
              interrupted = true;
              throw new NetworkError("synthetic interruption", false, true);
            }
          },
        }),
      ).rejects.toThrow();
      expect(actions).toBe(0);
      const [cp] = await persistence.query(
        "SELECT state FROM checkpoints WHERE run_id=$1",
        [run.id],
      );
      expect(cp.state.cursor).toBe(
        when === "before" ? "agent" : "review-action",
      );
      if (when === "after")
        expect(
          (
            await persistence.query(
              "SELECT output FROM steps WHERE run_id=$1 AND node_id='agent'",
              [run.id],
            )
          )[0].output.outcome.state,
        ).toBe("review");
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([]),
        dispatch: async () => {
          actions++;
          return { ok: true };
        },
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(actions).toBe(1);
      expect(
        (
          await persistence.query(
            "SELECT node_id FROM tool_calls WHERE run_id=$1",
            [run.id],
          )
        )[0].node_id,
      ).toBe("review-action");
    });
  it("deduplicates completed actions across a crash after checkpoint and isolates nested agent conversations", async () => {
    const w = await workflow((w) => {
        Object.assign(w, addOutcome(w, "agent", "outcome"));
        w.nodes.push(
          {
            id: "action",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Action",
              toolId: receiptTool.id,
              arguments: {
                merchant: "x",
                date: "2026-09-09",
                currency: "USD",
                total: 1,
              },
            },
          },
          {
            ...structuredClone(w.nodes[2]),
            id: "second",
            data: {
              ...w.nodes[2].data,
              requiredTool: undefined,
              userPrompt:
                "Earlier: {{steps.agent.outcome.result}} / {{steps.action.data.accepted}}",
              systemPrompt: "SECOND AGENT",
            },
          },
        );
        w.edges.push(
          {
            id: "a",
            source: "outcome",
            target: "action",
            kind: "execution",
            stateId: "success",
          },
          { id: "b", source: "action", target: "second", kind: "execution" },
        );
        Object.assign(w, addOutcome(w, "second", "nested"));
      }),
      run = await runFor(w.version.id);
    let writes = 0,
      interrupted = false;
    await expect(
      runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        dispatch: async () => {
          writes++;
          return { ok: true, data: { accepted: true } };
        },
        afterCheckpoint: async (s) => {
          if (!interrupted && s.cursor === "second") {
            interrupted = true;
            throw new NetworkError("crash", false, true);
          }
        },
      }),
    ).rejects.toThrow();
    const provider = new ReportProvider([report("failure")]);
    await runtime.executeRun(run.id, {
      provider,
      dispatch: async () => {
        writes++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(writes).toBe(1);
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]).toHaveLength(1);
    expect(provider.seen[0][0].parts![0].text).toBe(
      "Earlier: Synthetic result / true",
    );
    const [cp] = await persistence.query(
      "SELECT state FROM checkpoints WHERE run_id=$1",
      [run.id],
    );
    expect(Object.keys(cp.state.nodes)).toEqual(["agent", "action", "second"]);
    expect(cp.state.outputs.second.outcome.state).toBe("failure");
  });
  it("retries an action with its original idempotency key and rejects schema-invalid resolved inputs", async () => {
    const w = await outcomeWorkflow(),
      run = await runFor(w.version.id);
    const keys: string[] = [];
    await expect(
      runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        dispatch: async (_t, _a, key) => {
          keys.push(key);
          return { ok: false, retryable: true };
        },
      }),
    ).rejects.toThrow();
    await runtime.executeRun(run.id, {
      dispatch: async (_t, _a, key) => {
        keys.push(key);
        return { ok: true };
      },
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await status(run.id)).status).toBe("succeeded");
    w.draft.nodes.find(
      (n) => n.id === "success-action",
    )!.data.arguments!.total = "{{steps.agent.outcome.result}}";
    await runtime.saveDraft(w.id, w.draft);
    const version = await runtime.publish(w.id);
    const invalid = await runFor(version.id);
    let dispatch = 0;
    await runtime.executeRun(invalid.id, {
      provider: new ReportProvider([report("success")]),
      dispatch: async () => {
        dispatch++;
        return { ok: true };
      },
    });
    expect(dispatch).toBe(0);
    expect((await status(invalid.id)).status).toBe("failed");
  });
  it("never advances beyond an uncertain action write", async () => {
    const w = await outcomeWorkflow(),
      run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      provider: new ReportProvider([report("failure")]),
      dispatch: async () => ({ ok: false, review: true, error: "Uncertain" }),
    });
    expect((await status(run.id)).status).toBe("needs_review");
    const [cp] = await persistence.query(
      "SELECT state FROM checkpoints WHERE run_id=$1",
      [run.id],
    );
    expect(cp.state.cursor).toBe("failure-action");
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        throw new Error("must not repeat");
      },
    });
    expect((await status(run.id)).status).toBe("needs_review");
  });
  it("reuses an action ledger committed before the cursor advanced", async () => {
    const w = await outcomeWorkflow(),
      run = await runFor(w.version.id);
    await expect(
      runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        afterCheckpoint: async (s) => {
          if (s.cursor === "success-action")
            throw new NetworkError("interrupt", false, true);
        },
      }),
    ).rejects.toThrow();
    await persistence.query(
      "INSERT INTO tool_calls(id,run_id,node_id,name,args,status,result) VALUES($1,$2,'success-action','submit_receipt',$3,'succeeded',$4)",
      [
        `${run.id}:success-action:action`,
        run.id,
        JSON.stringify({
          merchant: "Synthetic result",
          date: "2026-09-09",
          currency: "USD",
          total: 1,
        }),
        JSON.stringify({ ok: true, data: { accepted: true } }),
      ],
    );
    let dispatched = 0;
    await runtime.executeRun(run.id, {
      dispatch: async () => {
        dispatched++;
        return { ok: true };
      },
    });
    expect(dispatched).toBe(0);
    expect((await status(run.id)).status).toBe("succeeded");
  });
  it("keeps identical actions in different nodes independent", async () => {
    const w = await workflow((w) => {
        Object.assign(w, addOutcome(w, "agent", "outcome"));
        for (const id of ["first-action", "second-action"])
          w.nodes.push({
            id,
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: id,
              toolId: receiptTool.id,
              arguments: {
                merchant: "x",
                date: "2026-09-09",
                currency: "USD",
                total: 1,
              },
            },
          });
        w.edges.push(
          {
            id: "a",
            source: "outcome",
            target: "first-action",
            kind: "execution",
            stateId: "success",
          },
          {
            id: "b",
            source: "first-action",
            target: "second-action",
            kind: "execution",
          },
        );
      }),
      run = await runFor(w.version.id);
    const keys: string[] = [];
    await runtime.executeRun(run.id, {
      provider: new ReportProvider([report("success")]),
      dispatch: async (_t, _a, key) => {
        keys.push(key);
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(new Set(keys).size).toBe(2);
  });
  it("scopes agent tool discovery and dispatch, then accepts a report after ordinary tools", async () => {
    const other = { ...receiptTool, id: randomUUID(), name: "other_node_tool" };
    await (
      await import("../packages/persistence/src/settings")
    ).saveSetting("TOOL_ALLOWED_ORIGINS", "http://localhost:4010");
    await persistence.query("INSERT INTO tools(id,definition) VALUES($1,$2)", [
      other.id,
      JSON.stringify(other),
    ]);
    const w = await workflow((w) => {
        Object.assign(w, addOutcome(w, "agent", "outcome"));
        w.nodes.push({
          id: "other-action",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Other action",
            toolId: other.id,
            arguments: {
              merchant: "x",
              date: "2026-09-09",
              currency: "USD",
              total: 1,
            },
          },
        });
        w.edges.push({
          id: "other",
          source: "outcome",
          target: "other-action",
          kind: "execution",
          stateId: "failure",
        });
      }),
      run = await runFor(w.version.id);
    const messages: Message[] = [
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "not-allowed",
              name: "other_node_tool",
              args: {},
            },
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "allowed",
              name: "submit_receipt",
              args: {
                merchant: "x",
                date: "2026-09-09",
                currency: "USD",
                total: 1,
              },
            },
          },
        ],
      },
      report("success"),
    ];
    const declared: string[][] = [];
    const provider: import("../packages/providers/src/index").Provider = {
      upload: new MockProvider().upload,
      remove: async () => {},
      infer: async (_messages, _config, tools) => {
        declared.push(tools.map((t) => t.name));
        return messages.shift()!;
      },
    };
    let writes = 0;
    await runtime.executeRun(run.id, {
      provider,
      dispatch: async (t) => {
        expect(t.name).toBe("submit_receipt");
        writes++;
        return { ok: true };
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(writes).toBe(1);
    expect(declared).toHaveLength(3);
    expect(declared[0]).toEqual(["submit_receipt", "finish_task"]);
  });
  it("preserves terminal reports across recovery without another model call", async () => {
    const w = await outcomeWorkflow(true),
      run = await runFor(w.version.id);
    await expect(
      runtime.executeRun(run.id, {
        provider: new ReportProvider([report("failure")]),
        afterCheckpoint: async (s) => {
          if (s.cursor === null)
            throw new NetworkError("interrupt", false, true);
        },
      }),
    ).rejects.toThrow();
    const provider = new ReportProvider([]);
    await runtime.executeRun(run.id, { provider });
    expect(provider.seen).toHaveLength(0);
    expect((await status(run.id)).status).toBe("succeeded");
  });
  it("provider refusal, truncation and infrastructure errors never choose Failure", async () => {
    const w = await outcomeWorkflow();
    for (const message of [
      "Provider refused task",
      "Provider stopped: max_tokens",
      "Provider rejected request (HTTP 401)",
    ]) {
      const run = await runFor(w.version.id);
      class FailedProvider extends MockProvider {
        override async infer(): Promise<Message> {
          throw new Error(message);
        }
      }
      await runtime.executeRun(run.id, { provider: new FailedProvider() });
      expect(await status(run.id)).toMatchObject({
        status: "failed",
        error: message,
      });
      expect(
        await persistence.query("SELECT * FROM tool_calls WHERE run_id=$1", [
          run.id,
        ]),
      ).toHaveLength(0);
      expect(
        await persistence.query(
          "SELECT * FROM steps WHERE run_id=$1 AND node_id='outcome'",
          [run.id],
        ),
      ).toHaveLength(0);
    }
  });
  async function emailWorkflow() {
    return workflow((w) => {
      Object.assign(w, addOutcome(w, "agent", "outcome"));
      for (const branch of ["success", "failure", "review"]) {
        if (branch === "review")
          w.nodes
            .find((n) => n.id === "outcome")!
            .data.states!.push({
              id: branch,
              name: "Review",
              criteria: "Needs human review",
            });
        w.nodes.push({
          id: branch + "-email",
          type: "send_email",
          position: { x: 0, y: 0 },
          data: {
            label: branch + " reply",
            bodyTemplate: "{{steps.agent.outcome.result}} / {{email.text}}",
          },
        });
        w.edges.push({
          id: branch,
          source: "outcome",
          target: branch + "-email",
          kind: "execution",
          stateId: branch,
        });
      }
    });
  }
  const sends = async (runId: string) =>
    persistence.query("SELECT * FROM email_sends WHERE run_id=$1", [runId]);
  it.each(["success", "failure", "review"])(
    "accepts exactly the selected %s email branch and commits the terminal cursor",
    async (branch) => {
      const w = await emailWorkflow(),
        run = await runFor(w.version.id);
      await persistence.query("UPDATE emails SET raw=$2 WHERE id=$1", [
        run.email.id,
        JSON.stringify({ data: { message_id: "<original@example.com>" } }),
      ]);
      let count = 0;
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([report(branch)]),
        sendEmail: async (message) => {
          count++;
          expect(message.from).toBe(w.draft.nodes[0].data.recipient);
          expect(message.headers?.["In-Reply-To"]).toBe(
            "<original@example.com>",
          );
          return { ok: true, providerEmailId: "accepted-id" };
        },
      });
      expect(count).toBe(1);
      expect((await status(run.id)).status).toBe("succeeded");
      expect(await sends(run.id)).toMatchObject([
        {
          node_id: branch + "-email",
          status: "succeeded",
          provider_email_id: "accepted-id",
          mode: "live",
        },
      ]);
      const [cp] = await persistence.query(
        "SELECT state FROM checkpoints WHERE run_id=$1",
        [run.id],
      );
      expect(cp.state).toMatchObject({
        version: 2,
        cursor: null,
        outputs: { [branch + "-email"]: { delivery: "Accepted by Resend" } },
      });
      expect(
        await persistence.query(
          "SELECT * FROM steps WHERE run_id=$1 AND node_id LIKE '%-email'",
          [run.id],
        ),
      ).toHaveLength(1);
    },
  );
  it("previews server-owned Test runs without a sending credential or dispatch", async () => {
    const w = await emailWorkflow();
    const run = await runtime.testRun(w.id);
    let sent = 0;
    await runtime.executeRun(run.id, {
      provider: new ReportProvider([report("success")]),
      sendEmail: async () => {
        sent++;
        throw new Error("must not send");
      },
    });
    expect(sent).toBe(0);
    expect((await status(run.id)).status).toBe("succeeded");
    expect(await sends(run.id)).toMatchObject([
      {
        mode: "preview",
        status: "succeeded",
        first_attempt_at: null,
        provider_email_id: null,
      },
    ]);
  });
  it.each(["prepared", "accepted", "completed"])(
    "recovers after email %s with frozen payload and stable key",
    async (phase) => {
      const w = await emailWorkflow(),
        run = await runFor(w.version.id);
      const messages: unknown[] = [],
        keys: string[] = [];
      const dispatch = async (message: unknown, key: string) => {
        messages.push(message);
        keys.push(key);
        return { ok: true as const, providerEmailId: "same-provider-id" };
      };
      const crash = async () => {
        throw new NetworkError("interrupted worker", false, true);
      };
      await expect(
        runtime.executeRun(run.id, {
          provider: new ReportProvider([report("success")]),
          sendEmail: dispatch,
          ...(phase === "prepared"
            ? { afterEmailPrepared: crash }
            : phase === "accepted"
              ? { afterEmailAccepted: crash }
              : {
                  afterCheckpoint: async (s) => {
                    if (s.cursor === null) await crash();
                  },
                }),
        }),
      ).rejects.toThrow();
      const [frozen] = await sends(run.id);
      await persistence.query(
        "UPDATE emails SET payload=jsonb_set(payload,'{text}','\"changed after preparation\"') WHERE id=$1",
        [run.email.id],
      );
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([]),
        sendEmail: dispatch,
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(messages).toHaveLength(phase === "accepted" ? 2 : 1);
      expect(
        messages.every(
          (m) => JSON.stringify(m) === JSON.stringify(frozen.message),
        ),
      ).toBe(true);
      expect(new Set(keys).size).toBe(1);
      expect((await sends(run.id))[0].provider_email_id).toBe(
        "same-provider-id",
      );
    },
  );
  it("retries ambiguous acceptance, but never sends after the deduplication window", async () => {
    const w = await emailWorkflow(),
      run = await runFor(w.version.id);
    await expect(
      runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        sendEmail: async () => ({
          ok: false,
          retryable: true,
          ambiguous: true,
          error: "Email connection interrupted",
        }),
      }),
    ).rejects.toThrow();
    expect((await sends(run.id))[0].status).toBe("ambiguous");
    await persistence.query(
      "UPDATE email_sends SET first_attempt_at=now()-interval '24 hours' WHERE run_id=$1",
      [run.id],
    );
    await runtime.executeRun(run.id, {
      sendEmail: async () => {
        throw new Error("must not dispatch");
      },
    });
    expect((await status(run.id)).status).toBe("needs_review");
    expect((await sends(run.id))[0].status).toBe("needs_review");
  });
  it.each(["execute", "maintenance"])(
    "%s marks unresolved email writes for review at the deadline",
    async (method) => {
      const w = await emailWorkflow(),
        run = await runFor(w.version.id);
      await expect(
        runtime.executeRun(run.id, {
          provider: new ReportProvider([report("success")]),
          sendEmail: async () => ({
            ok: false,
            retryable: true,
            ambiguous: true,
            error: "Email timeout",
          }),
        }),
      ).rejects.toThrow();
      await persistence.query(
        "UPDATE runs SET started_at=now()-interval '7 minutes' WHERE id=$1",
        [run.id],
      );
      if (method === "execute") await runtime.executeRun(run.id);
      else await runtime.maintenance();
      expect((await status(run.id)).status).toBe("needs_review");
      expect((await sends(run.id))[0].status).toBe("needs_review");
      expect(
        (
          await persistence.query(
            "SELECT state FROM checkpoints WHERE run_id=$1",
            [run.id],
          )
        )[0].state.cursor,
      ).toBe("success-email");
    },
  );
  it("rejects invalid sender addresses before dispatch and records definitive provider failures", async () => {
    const w = await emailWorkflow(),
      empty = await runFor(w.version.id);
    await persistence.query(
      "UPDATE emails SET payload=jsonb_set(payload,'{from}','\"invalid-address\"') WHERE id=$1",
      [empty.email.id],
    );
    await runtime.executeRun(empty.id, {
      provider: new ReportProvider([report("success")]),
      sendEmail: async () => {
        throw new Error("must not send");
      },
    });
    expect((await status(empty.id)).status).toBe("failed");
    expect(await sends(empty.id)).toHaveLength(0);
    const failed = await runFor(w.version.id);
    await runtime.executeRun(failed.id, {
      provider: new ReportProvider([report("failure")]),
      sendEmail: async () => ({
        ok: false,
        error: "Email authentication failed; check RESEND_API_KEY",
      }),
    });
    expect(await status(failed.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("authentication"),
    });
    expect((await sends(failed.id))[0].status).toBe("failed");
  });
  it("rolls back acceptance and step output when the terminal checkpoint transaction fails", async () => {
    const w = await emailWorkflow(),
      run = await runFor(w.version.id);
    await persistence.query(
      `CREATE FUNCTION reject_email_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${run.id}' AND NEW.state->'cursor' = 'null'::jsonb THEN RAISE EXCEPTION 'synthetic checkpoint failure'; END IF; RETURN NEW; END $$`,
    );
    await persistence.query(
      "CREATE TRIGGER reject_email_checkpoint BEFORE INSERT OR UPDATE ON checkpoints FOR EACH ROW EXECUTE FUNCTION reject_email_checkpoint()",
    );
    try {
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        sendEmail: async () => ({
          ok: true,
          providerEmailId: "accepted-before-db-failure",
        }),
      });
      expect((await status(run.id)).status).toBe("needs_review");
      expect((await sends(run.id))[0]).toMatchObject({
        status: "needs_review",
        provider_email_id: null,
      });
      const [step] = await persistence.query(
        "SELECT * FROM steps WHERE run_id=$1 AND node_id='success-email'",
        [run.id],
      );
      expect(step.status).toBe("needs_review");
      expect(
        (
          await persistence.query(
            "SELECT state FROM checkpoints WHERE run_id=$1",
            [run.id],
          )
        )[0].state.cursor,
      ).toBe("success-email");
    } finally {
      await persistence.query(
        "DROP TRIGGER reject_email_checkpoint ON checkpoints",
      );
      await persistence.query("DROP FUNCTION reject_email_checkpoint()");
    }
  });
  it("reuses a recorded acceptance without dispatch even if an older checkpoint points to the email", async () => {
    const w = await emailWorkflow(),
      run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      provider: new ReportProvider([report("success")]),
      sendEmail: async () => ({ ok: true, providerEmailId: "recorded" }),
    });
    await persistence.query(
      "UPDATE checkpoints SET state=jsonb_set(state,'{cursor}','\"success-email\"') WHERE run_id=$1",
      [run.id],
    );
    await persistence.query(
      "UPDATE runs SET status='queued',finished_at=NULL WHERE id=$1",
      [run.id],
    );
    await runtime.executeRun(run.id, {
      sendEmail: async () => {
        throw new Error("must reuse acceptance");
      },
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect((await sends(run.id))[0].provider_email_id).toBe("recorded");
  });
  it("renders action data on its branch and rejects an empty resolved body without sending", async () => {
    const w = await outcomeWorkflow();
    w.draft.nodes.push({
      id: "reply",
      type: "send_email",
      position: { x: 0, y: 0 },
      data: {
        label: "Reply",
        subjectTemplate: "Result: {{steps.agent.outcome.name}}",
        bodyTemplate: "{{steps.success-action.data.message}}",
      },
    });
    w.draft.edges.push({
      id: "reply",
      source: "success-action",
      target: "reply",
      kind: "execution",
    });
    await runtime.saveDraft(w.id, w.draft);
    const version = await runtime.publish(w.id);
    for (const body of ["Action completed", "  "]) {
      const run = await runFor(version.id);
      let sends = 0;
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([report("success")]),
        dispatch: async () => ({ ok: true, data: { message: body } }),
        sendEmail: async (message) => {
          sends++;
          expect(message.text).toBe(body);
          expect(message.subject).toBe("Result: Success");
          return { ok: true, providerEmailId: "action-reply" };
        },
      });
      expect(sends).toBe(body.trim() ? 1 : 0);
      expect((await status(run.id)).status).toBe(
        body.trim() ? "succeeded" : "failed",
      );
    }
  });
  it.each(["execute", "maintenance"])(
    "%s recovers a terminal email checkpoint even after the deadline",
    async (method) => {
      const w = await emailWorkflow(),
        run = await runFor(w.version.id);
      await expect(
        runtime.executeRun(run.id, {
          provider: new ReportProvider([report("success")]),
          sendEmail: async () => ({ ok: true, providerEmailId: "accepted" }),
          afterCheckpoint: async (state) => {
            if (state.cursor === null)
              throw new NetworkError(
                "worker stopped after commit",
                false,
                true,
              );
          },
        }),
      ).rejects.toThrow();
      await persistence.query(
        "UPDATE runs SET started_at=now()-interval '7 minutes' WHERE id=$1",
        [run.id],
      );
      if (method === "execute")
        await runtime.executeRun(run.id, {
          sendEmail: async () => {
            throw new Error("must reuse committed result");
          },
        });
      else await runtime.maintenance();
      expect((await status(run.id)).status).toBe("succeeded");
      expect((await sends(run.id))[0]).toMatchObject({
        status: "succeeded",
        provider_email_id: "accepted",
      });
    },
  );
  it("keeps a committed outcome successful when MCP cleanup fails", async () => {
    const w = await outcomeWorkflow(true),
      run = await runFor(w.version.id);
    const close = vi
      .spyOn(Client.prototype, "close")
      .mockRejectedValueOnce(new Error("synthetic close failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runtime.executeRun(run.id, {
        provider: new ReportProvider([report("failure")]),
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(log).toHaveBeenCalledWith("MCP cleanup failed");
    } finally {
      close.mockRestore();
      log.mockRestore();
    }
  });
  async function pdfWorkflow() {
    return workflow((draft) => {
      draft.nodes[2].data.generatePdf = true;
      draft.nodes[2].data.requiredTool = undefined;
      draft.nodes.push({
        id: "reply",
        type: "send_email",
        position: { x: 1200, y: 0 },
        data: {
          label: "Reply",
          bodyTemplate: "{{steps.agent.text}}",
          reportSourceNodeId: "agent",
        },
      });
      draft.edges.push({
        id: "pdf-reply",
        source: "agent",
        target: "reply",
        kind: "execution",
      });
    });
  }
  const fakeCompile = vi.fn(async (_source: string) => ({
    ok: true as const,
    profile: "tectonic-0.15.0-bundle33-report-v1" as const,
    pdf: Buffer.from("%PDF-1.4\nSynthetic database fixture").toString("base64"),
    pageCount: 2,
    warnings: [],
    text: "Synthetic report ".repeat(200),
    textTruncated: false,
  }));
  it("pins the renderer, commits report output without Outcome, freezes preview metadata and never dispatches email", async () => {
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    await persistence.query("UPDATE emails SET raw=$2 WHERE id=$1", [
      run.email.id,
      JSON.stringify({ test: true }),
    ]);
    const dispatch = vi.fn();
    await runtime.executeRun(run.id, {
      compileReport: fakeCompile,
      sendEmail: dispatch,
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(dispatch).not.toHaveBeenCalled();
    const [step] = await persistence.query(
      "SELECT output FROM steps WHERE run_id=$1 AND node_id='agent'",
      [run.id],
    );
    const [send] = await persistence.query(
      "SELECT * FROM email_sends WHERE run_id=$1",
      [run.id],
    );
    expect(step.output.report).toMatchObject({
      nodeId: "agent",
      filename: "report.pdf",
      pageCount: 2,
    });
    expect(send.message.attachments).toEqual([step.output.report]);
    expect(JSON.stringify(send)).not.toContain("base64");
    const [attempt] = await persistence.query(
      "SELECT * FROM report_attempts WHERE run_id=$1",
      [run.id],
    );
    expect(attempt.renderer_profile).toBe("tectonic-0.15.0-bundle33-report-v1");
    expect(attempt.result.data.textPreview.length).toBe(2000);
    expect(attempt.result.data.textTruncated).toBe(true);
    expect(attempt.result.data.pdf).toBeUndefined();
  });
  it("replays calls, invalidates failed revisions, reuses successful source and persists distinct attempt limits", async () => {
    const { generateReport, currentReport } =
      await import("../packages/runtime/src/report-execution");
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    const node = {
      ...w.draft.nodes[2],
      data: {
        ...w.draft.nodes[2].data,
        rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
      },
    };
    const compile = vi.fn(async (source: string) =>
      source === "bad"
        ? { ok: false as const, error: "Undefined command" }
        : fakeCompile(source),
    );
    const call = (id: string, source: string) =>
      generateReport(
        run.id,
        node,
        run.id + id,
        { source },
        AbortSignal.timeout(10000),
        compile,
      );
    const first = await call("a", "good");
    expect(await call("a", "good")).toEqual(first);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(await currentReport(run.id, node.id)).toBeDefined();
    expect((await call("b", "bad")).ok).toBe(false);
    expect(await currentReport(run.id, node.id)).toBeUndefined();
    expect(await call("c", "good")).toEqual(first);
    expect(compile).toHaveBeenCalledTimes(2);
    await call("d", "third");
    expect((await call("e", "fourth")).error).toContain("exhausted");
    expect(await currentReport(run.id, node.id)).toBeUndefined();
    expect(await call("f", "good")).toEqual(first);
    expect(compile).toHaveBeenCalledTimes(3);
  });
  it("recovers interrupted compilation and storage without API-write review", async () => {
    const { ReportStorage } =
      await import("../packages/connectors/src/reports");
    for (const stage of ["compile", "storage"] as const) {
      const w = await pdfWorkflow(),
        run = await runFor(w.version.id);
      const compile = vi.fn(fakeCompile);
      if (stage === "compile")
        compile.mockRejectedValueOnce(
          new Error("synthetic worker interruption"),
        );
      const originalPut = ReportStorage.prototype.put;
      const put =
        stage === "storage"
          ? vi
              .spyOn(ReportStorage.prototype, "put")
              .mockImplementationOnce(async function (
                this: InstanceType<typeof ReportStorage>,
                id,
                bytes,
              ) {
                await originalPut.call(this, id, bytes);
                throw new Error("synthetic disk interruption after fsync");
              })
          : undefined;
      try {
        await expect(
          runtime.executeRun(run.id, { compileReport: compile }),
        ).rejects.toThrow("PDF generation interrupted");
        expect((await status(run.id)).status).toBe("queued");
        const [attempt] = await persistence.query(
          "SELECT * FROM report_attempts WHERE run_id=$1",
          [run.id],
        );
        expect(attempt.status).toBe("running");
      } finally {
        put?.mockRestore();
      }
      await runtime.executeRun(run.id, {
        compileReport: compile,
        sendEmail: async () => ({
          ok: true,
          providerEmailId: "synthetic-accepted",
        }),
      });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(
        await persistence.query(
          "SELECT * FROM report_attempts WHERE run_id=$1",
          [run.id],
        ),
      ).toHaveLength(1);
    }
  });
  it("restores a completed report call after checkpoint interruption and freezes attachments across email acceptance recovery", async () => {
    const { RetryError } =
      await import("../packages/runtime/src/run-lifecycle");
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    const compile = vi.fn(fakeCompile);
    let interrupted = false;
    await expect(
      runtime.executeRun(run.id, {
        compileReport: compile,
        afterCheckpoint: async (state) => {
          if (!interrupted && state.nodes.agent?.turn === 1) {
            interrupted = true;
            throw new RetryError("synthetic checkpoint interruption");
          }
        },
      }),
    ).rejects.toThrow();
    const send = vi.fn(async () => ({
      ok: true as const,
      providerEmailId: "accepted",
    }));
    await expect(
      runtime.executeRun(run.id, {
        compileReport: compile,
        sendEmail: send,
        afterEmailAccepted: async () => {
          throw new RetryError("Email synthetic interruption");
        },
      }),
    ).rejects.toThrow();
    await runtime.executeRun(run.id, {
      compileReport: compile,
      sendEmail: send,
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(compile).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1].slice(0, 2)).toEqual(
      send.mock.calls[0].slice(0, 2),
    );
  });
  it("rejects foreign, expired, corrupt and missing report files before dispatch", async () => {
    const { generateReport, currentReport, validateReport } =
      await import("../packages/runtime/src/report-execution");
    const { ReportStorage } =
      await import("../packages/connectors/src/reports");
    const { writeFile } = await import("node:fs/promises");
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    const node = {
      ...w.draft.nodes[2],
      data: {
        ...w.draft.nodes[2].data,
        rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
      },
    };
    await generateReport(
      run.id,
      node,
      run.id + "a",
      { source: "good" },
      AbortSignal.timeout(10000),
      fakeCompile,
    );
    const reference = (await currentReport(run.id, node.id))!;
    await expect(validateReport("another-run", reference)).rejects.toThrow(
      "another run",
    );
    await expect(
      validateReport(run.id, { ...reference, nodeId: "other-agent" }),
    ).rejects.toThrow("another run");
    await persistence.query(
      "UPDATE runs SET finished_at=now()-interval '8 days' WHERE id=$1",
      [run.id],
    );
    await expect(validateReport(run.id, reference)).rejects.toThrow("expired");
    await persistence.query("UPDATE runs SET finished_at=NULL WHERE id=$1", [
      run.id,
    ]);
    await writeFile(
      new ReportStorage().path(reference.reportId),
      Buffer.alloc(reference.size),
    );
    await expect(validateReport(run.id, reference)).rejects.toThrow("checksum");
    await new ReportStorage().delete(reference.reportId);
    await expect(validateReport(run.id, reference)).rejects.toThrow("missing");
    const send = vi.fn();
    await runtime.executeRun(run.id, {
      compileReport: fakeCompile,
      sendEmail: send,
      afterEmailPrepared: async () => {
        const [record] = await persistence.query(
          "SELECT * FROM email_sends WHERE run_id=$1",
          [run.id],
        );
        await new ReportStorage().delete(
          record.message.attachments[0].reportId,
        );
      },
    });
    expect((await status(run.id)).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
  it("expires terminal reports after seven days, retains active reports, and cleans workflow deletion", async () => {
    const { generateReport, currentReport, cleanupReports } =
      await import("../packages/runtime/src/report-execution");
    const { ReportStorage } =
      await import("../packages/connectors/src/reports");
    for (const terminal of [false, true]) {
      const w = await pdfWorkflow(),
        run = await runFor(w.version.id);
      const node = {
        ...w.draft.nodes[2],
        data: {
          ...w.draft.nodes[2].data,
          rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
        },
      };
      await generateReport(
        run.id,
        node,
        run.id + "a",
        { source: "good" },
        AbortSignal.timeout(10000),
        fakeCompile,
      );
      const reference = (await currentReport(run.id, node.id))!;
      await persistence.query(
        "UPDATE generated_reports SET created_at=now()-interval '10 days' WHERE run_id=$1",
        [run.id],
      );
      if (terminal)
        await persistence.query(
          "UPDATE runs SET status='succeeded',finished_at=now()-interval '8 days' WHERE id=$1",
          [run.id],
        );
      await cleanupReports();
      const [file] = await persistence.query(
        "SELECT * FROM generated_reports WHERE run_id=$1",
        [run.id],
      );
      expect(file.expired_at !== null).toBe(terminal);
      if (terminal) {
        expect(file.extracted_text).toBeNull();
        await expect(new ReportStorage().read(reference)).rejects.toThrow();
      } else expect(await new ReportStorage().read(reference)).toBeDefined();
      await persistence.query(
        "UPDATE runs SET status='succeeded' WHERE id=$1",
        [run.id],
      );
      await runtime.deleteWorkflow(w.id);
      await expect(new ReportStorage().read(reference)).rejects.toThrow();
      expect(
        await persistence.query(
          "SELECT * FROM report_attempts WHERE run_id=$1",
          [run.id],
        ),
      ).toEqual([]);
    }
  });
  it.each(["success", "failure", "review"])(
    "keeps explicit %s Outcome selection independent of PDF compilation",
    async (selected) => {
      const w = await emailWorkflow();
      w.draft.nodes.find((n) => n.id === "agent")!.data.generatePdf = true;
      w.draft.nodes.find(
        (n) => n.id === "success-email",
      )!.data.reportSourceNodeId = "agent";
      await runtime.saveDraft(w.id, w.draft);
      const version = await runtime.publish(w.id);
      const run = await runFor(version.id);
      const provider = new ReportProvider([
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "pdf",
                name: "generate_pdf",
                args: { source: "synthetic" },
              },
            },
          ],
        },
        report(selected),
      ]);
      const send = vi.fn(async () => ({
        ok: true as const,
        providerEmailId: "accepted",
      }));
      await runtime.executeRun(run.id, {
        provider,
        compileReport:
          selected === "success"
            ? fakeCompile
            : async () => ({
                ok: false,
                error: "Synthetic compiler diagnostics",
              }),
        sendEmail: send,
      });
      expect((await status(run.id)).status).toBe("succeeded");
      const [step] = await persistence.query(
        "SELECT output FROM steps WHERE run_id=$1 AND node_id='agent'",
        [run.id],
      );
      expect(step.output.outcome.state).toBe(selected);
      expect(step.output.report !== undefined).toBe(selected === "success");
      const [email] = await persistence.query(
        "SELECT * FROM email_sends WHERE run_id=$1",
        [run.id],
      );
      expect(email.node_id).toBe(selected + "-email");
      expect(email.message.attachments?.length ?? 0).toBe(
        selected === "success" ? 1 : 0,
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        provider.seen[1].at(-1)?.parts?.[0].functionResponse?.response,
      ).toMatchObject({ ok: selected === "success" });
    },
  );
  it("recovers a failed report metadata commit without acknowledging success or repeating an external write", async () => {
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    await persistence.query(
      "CREATE FUNCTION reject_pdf_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic report metadata failure'; END $$",
    );
    await persistence.query(
      "CREATE TRIGGER reject_pdf_commit BEFORE INSERT ON generated_reports FOR EACH ROW EXECUTE FUNCTION reject_pdf_commit()",
    );
    const compile = vi.fn(fakeCompile),
      send = vi.fn(async () => ({
        ok: true as const,
        providerEmailId: "accepted",
      }));
    try {
      await expect(
        runtime.executeRun(run.id, { compileReport: compile, sendEmail: send }),
      ).rejects.toThrow("PDF generation interrupted");
      expect((await status(run.id)).status).toBe("queued");
      expect(send).not.toHaveBeenCalled();
      expect(
        await persistence.query(
          "SELECT * FROM generated_reports WHERE run_id=$1",
          [run.id],
        ),
      ).toEqual([]);
      expect(
        (
          await persistence.query(
            "SELECT * FROM report_attempts WHERE run_id=$1",
            [run.id],
          )
        )[0],
      ).toMatchObject({ status: "running", result: null });
    } finally {
      await persistence.query(
        "DROP TRIGGER reject_pdf_commit ON generated_reports",
      );
      await persistence.query("DROP FUNCTION reject_pdf_commit()");
    }
    await runtime.executeRun(run.id, {
      compileReport: compile,
      sendEmail: send,
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(
      await persistence.query(
        "SELECT * FROM generated_reports WHERE run_id=$1",
        [run.id],
      ),
    ).toHaveLength(1);
    expect(
      await persistence.query("SELECT * FROM report_attempts WHERE run_id=$1", [
        run.id,
      ]),
    ).toHaveLength(1);
  });
  it("finalizes interrupted report generation without API write review at the run deadline", async () => {
    const { generateReport, cleanupReports } =
      await import("../packages/runtime/src/report-execution");
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    const node = {
      ...w.draft.nodes[2],
      data: {
        ...w.draft.nodes[2].data,
        rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
      },
    };
    await expect(
      generateReport(
        run.id,
        node,
        run.id + "pdf",
        { source: "synthetic" },
        AbortSignal.timeout(10000),
        async () => {
          throw new Error("interrupted");
        },
      ),
    ).rejects.toThrow();
    await persistence.query(
      "UPDATE runs SET status='running',started_at=now()-interval '7 minutes' WHERE id=$1",
      [run.id],
    );
    await runtime.maintenance();
    expect((await status(run.id)).status).toBe("failed");
    await cleanupReports();
    expect(
      (
        await persistence.query(
          "SELECT * FROM report_attempts WHERE run_id=$1",
          [run.id],
        )
      )[0].status,
    ).toBe("failed");
  });
  it("expires extracted text from both report records and checkpoint tool previews", async () => {
    const { cleanupReports } =
      await import("../packages/runtime/src/report-execution");
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    await runtime.executeRun(run.id, {
      compileReport: fakeCompile,
      sendEmail: async () => ({ ok: true, providerEmailId: "accepted" }),
    });
    expect((await status(run.id)).status).toBe("succeeded");
    const [before] = await persistence.query(
      "SELECT state FROM checkpoints WHERE run_id=$1",
      [run.id],
    );
    expect(JSON.stringify(before.state)).toContain('"textPreview"');
    await persistence.query(
      "UPDATE runs SET finished_at=now()-interval '8 days' WHERE id=$1",
      [run.id],
    );
    await cleanupReports();
    const [after] = await persistence.query(
      "SELECT state FROM checkpoints WHERE run_id=$1",
      [run.id],
    );
    expect(JSON.stringify(after.state)).not.toContain('"textPreview"');
    const [attempt] = await persistence.query(
      "SELECT * FROM report_attempts WHERE run_id=$1",
      [run.id],
    );
    expect(attempt.result.data.textPreview).toBeUndefined();
    expect(attempt.result.data.pageCount).toBe(2);
    const [file] = await persistence.query(
      "SELECT * FROM generated_reports WHERE run_id=$1",
      [run.id],
    );
    expect(file.extracted_text).toBeNull();
    expect(file.expired_at).not.toBeNull();
    expect(file.checksum).toBeDefined();
  });
  async function templateWorkflow() {
    const w = await pdfWorkflow();
    const resources =
      await import("../packages/runtime/src/template-resources");
    const bytes = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const image = await resources.uploadTemplateResource(
      w.id,
      "logo.png",
      bytes,
    );
    w.draft.nodes[2].data.generatePdf = false;
    w.draft.nodes.push({
      id: "template",
      type: "pdf_template",
      position: { x: 0, y: 300 },
      data: {
        label: "Assessment template",
        pdfTemplate: {
          ...structuredClone(defaultPdfTemplate),
          images: [image],
        },
        rendererProfile: TEMPLATE_PROFILE,
      },
    });
    w.draft.edges.push({
      id: "template-edge",
      source: "template",
      target: "agent",
      kind: "tool",
    });
    await runtime.saveDraft(w.id, w.draft);
    w.version = await runtime.publish(w.id);
    return { ...w, image, bytes, resources };
  }
  it("creates blank drafts and duplicates saved drafts without publication, routing or history", async () => {
    const blank = await runtime.createWorkflow("Blank");
    expect(blank).toEqual({
      id: expect.any(String),
      draft: { name: "Blank", nodes: [], edges: [] },
    });
    const source = await workflow();
    const run = await runFor(source.version.id);
    const draft = addOutcome(
      structuredClone(source.draft),
      "agent",
      "stable-outcome",
    );
    draft.nodes[2].data.credentialId = "shared-credential";
    draft.nodes[2].data.reportSourceNodeId = "agent";
    draft.nodes[2].data.userPrompt = "Saved {{steps.upload.count}}";
    draft.nodes.push({
      ...structuredClone(draft.nodes[0]),
      id: "second-email",
    });
    await runtime.saveDraft(source.id, draft);
    const copy = await runtime.createWorkflow("Copy", source.id);
    expect(copy.id).not.toBe(source.id);
    const expected = structuredClone(draft);
    expected.name = "Copy";
    for (const node of expected.nodes)
      if (node.type === "email") node.data.recipient = "";
    expect(copy.draft).toEqual(expected);
    expect(
      (
        await persistence.query("SELECT * FROM workflows WHERE id=$1", [
          copy.id,
        ])
      )[0],
    ).toMatchObject({ published_version: null, recipient: null });
    expect(
      await persistence.query("SELECT * FROM versions WHERE workflow_id=$1", [
        copy.id,
      ]),
    ).toEqual([]);
    expect((await status(run.id)).version_id).toBe(source.version.id);
    expect(
      (
        await persistence.query("SELECT snapshot FROM versions WHERE id=$1", [
          source.version.id,
        ])
      )[0].snapshot.workflow,
    ).toEqual(source.draft);
    copy.draft.nodes[2].data.userPrompt = "Independent edit";
    await runtime.saveDraft(copy.id, copy.draft);
    expect(
      (
        await persistence.query("SELECT draft FROM workflows WHERE id=$1", [
          source.id,
        ])
      )[0].draft,
    ).toEqual(draft);
    await expect(
      runtime.createWorkflow("Missing", randomUUID()),
    ).rejects.toBeInstanceOf(runtime.WorkflowNotFoundError);
  });
  it("copies repeated PDF references once and keeps images usable after source replacement and deletion", async () => {
    const source = await templateWorkflow();
    const repeated = structuredClone(source.draft.nodes.at(-1)!);
    repeated.id = "second-template";
    repeated.data.pdfTemplate!.toolName = "second_pdf";
    source.draft.nodes.push(repeated);
    await runtime.saveDraft(source.id, source.draft);
    const copy = await runtime.createWorkflow("Independent images", source.id);
    const images = copy.draft.nodes
      .filter((node) => node.data.pdfTemplate)
      .map((node) => node.data.pdfTemplate!.images[0]);
    expect(images[0]).toEqual({ ...source.image, id: expect.any(String) });
    expect(images[0].id).not.toBe(source.image.id);
    expect(images[1]).toEqual(images[0]);
    expect(
      await persistence.query(
        "SELECT id FROM template_resources WHERE workflow_id=$1",
        [copy.id],
      ),
    ).toHaveLength(1);
    source.draft.nodes = source.draft.nodes.filter(
      (node) => node.type !== "pdf_template",
    );
    await runtime.saveDraft(source.id, source.draft);
    await runtime.deleteWorkflow(source.id);
    expect(
      await source.resources.readTemplateResource(copy.id, images[0]),
    ).toEqual(source.bytes);
    await source.resources.cleanupTemplateResources();
    expect(
      await source.resources.readTemplateResource(copy.id, images[0]),
    ).toEqual(source.bytes);
  });
  it.each(["metadata", "missing", "checksum"])(
    "rolls back duplication for %s image failures and reclaims orphan bytes",
    async (failure) => {
      const source = await templateWorkflow();
      const second = await source.resources.uploadTemplateResource(
        source.id,
        "second.png",
        source.bytes,
      );
      source.draft.nodes.at(-1)!.data.pdfTemplate!.images.push(second);
      await runtime.saveDraft(source.id, source.draft);
      const { TemplateResourceStorage } =
        await import("../packages/connectors/src/template-resources");
      const { writeFile, readdir, utimes } = await import("node:fs/promises");
      const storage = new TemplateResourceStorage();
      if (failure === "metadata")
        await persistence.query("DELETE FROM template_resources WHERE id=$1", [
          second.id,
        ]);
      if (failure === "missing") await storage.delete(second.id);
      if (failure === "checksum")
        await writeFile(
          storage.path(second.id),
          Buffer.alloc(source.bytes.length),
        );
      const before = await persistence.query(
        "SELECT id FROM workflows ORDER BY id",
      );
      const beforeResources = await persistence.query(
        "SELECT id FROM template_resources ORDER BY id",
      );
      const beforeFiles = new Set(await readdir(storage.root));
      await expect(
        runtime.createWorkflow("Must roll back", source.id),
      ).rejects.toThrow();
      expect(
        await persistence.query("SELECT id FROM workflows ORDER BY id"),
      ).toEqual(before);
      expect(
        await persistence.query(
          "SELECT id FROM template_resources ORDER BY id",
        ),
      ).toEqual(beforeResources);
      const orphans = (await readdir(storage.root)).filter(
        (file) => !beforeFiles.has(file),
      );
      expect(orphans).toHaveLength(1);
      const old = new Date(Date.now() - 8 * 86400000);
      for (const file of orphans)
        await utimes(join(storage.root, file), old, old);
      await source.resources.cleanupTemplateResources();
      expect(
        (await readdir(storage.root)).filter((file) => orphans.includes(file)),
      ).toEqual([]);
      await runtime.deleteWorkflow(source.id);
    },
  );
  it("waits for an in-flight save and copies its committed draft", async () => {
    const source = await workflow();
    const client = await persistence.pool.connect();
    let copying: ReturnType<typeof runtime.createWorkflow> | undefined;
    try {
      await client.query("BEGIN");
      source.draft.nodes[2].data.userPrompt = "Committed concurrent save";
      await client.query("UPDATE workflows SET draft=$2 WHERE id=$1", [
        source.id,
        JSON.stringify(source.draft),
      ]);
      copying = runtime.createWorkflow("After save", source.id);
      await vi.waitFor(async () => {
        expect(
          (
            await persistence.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT draft FROM workflows%FOR UPDATE'",
            )
          ).length,
        ).toBeGreaterThan(0);
      });
      await client.query("COMMIT");
      expect((await copying).draft.nodes[2].data.userPrompt).toBe(
        "Committed concurrent save",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await copying;
    }
  });
  it.each(["save", "delete", "cleanup"])(
    "holds the source lock through image copying during concurrent %s",
    async (operation) => {
      const source = await templateWorkflow();
      const { TemplateResourceStorage } =
        await import("../packages/connectors/src/template-resources");
      const original = TemplateResourceStorage.prototype.readImage;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = vi
        .spyOn(TemplateResourceStorage.prototype, "readImage")
        .mockImplementationOnce(async function (
          this: InstanceType<typeof TemplateResourceStorage>,
          image,
        ) {
          const bytes = await original.call(this, image);
          started();
          await gate;
          return bytes;
        });
      const copying = runtime.createWorkflow("Concurrent copy", source.id);
      let concurrent: Promise<unknown> | undefined;
      try {
        await entered;
        source.draft.nodes.at(-1)!.data.pdfTemplate!.images = [];
        concurrent =
          operation === "save"
            ? runtime.saveDraft(source.id, source.draft)
            : operation === "delete"
              ? runtime.deleteWorkflow(source.id)
              : source.resources.cleanupTemplateResources();
        await vi.waitFor(async () => {
          expect(
            (
              await persistence.query(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            ).length,
          ).toBeGreaterThan(0);
        });
        release();
        const copy = await copying;
        await concurrent;
        const image = copy.draft.nodes.at(-1)!.data.pdfTemplate!.images[0];
        expect(
          await source.resources.readTemplateResource(copy.id, image),
        ).toEqual(source.bytes);
      } finally {
        release();
        read.mockRestore();
        await Promise.allSettled([copying, concurrent]);
      }
    },
  );
  it.each([LEGACY_TEMPLATE_PROFILE, TEMPLATE_PROFILE] as const)(
    "executes immutable template publications using %s",
    async (profile) => {
      const source = await templateWorkflow();
      const draft = structuredClone(source.draft);
      draft.nodes.at(-1)!.data.rendererProfile = profile;
      const versionId = randomUUID();
      await persistence.query(
        "INSERT INTO versions(id,workflow_id,number,snapshot) VALUES($1,$2,99,$3)",
        [versionId, source.id, JSON.stringify({ workflow: draft, tools: [] })],
      );
      const run = await runFor(versionId);
      await persistence.query("UPDATE emails SET raw=$2 WHERE id=$1", [
        run.email.id,
        JSON.stringify({ test: true }),
      ]);
      const compile = vi.fn(async (text: string, _profile: string) => ({
        ...(await fakeCompile(text)),
        profile,
      }));
      await runtime.executeRun(run.id, { compileReport: compile });
      expect((await status(run.id)).status).toBe("succeeded");
      expect(compile.mock.calls[0][1]).toBe(profile);
    },
  );
  it.each(["missing", "failed-final-revision", "success"])(
    "enforces a current required template PDF on %s completion",
    async (scenario) => {
      const source = await templateWorkflow();
      source.draft.nodes = source.draft.nodes.filter(
        (node) => node.type !== "send_email",
      );
      source.draft.edges = source.draft.edges.filter(
        (edge) =>
          source.draft.nodes.some((node) => node.id === edge.source) &&
          source.draft.nodes.some((node) => node.id === edge.target),
      );
      const toolName = source.draft.nodes.at(-1)!.data.pdfTemplate!.toolName;
      source.draft.nodes[2].data.requiredTool = toolName;
      await runtime.saveDraft(source.id, source.draft);
      const version = await runtime.publish(source.id);
      const run = await runFor(version.id);
      let turn = 0;
      const provider = new MockProvider();
      provider.infer = async () => {
        turn++;
        if (scenario === "missing" || turn > (scenario === "success" ? 1 : 2))
          return { role: "model", parts: [{ text: "Finished" }] };
        return {
          role: "model",
          parts: [
            {
              functionCall: {
                id: `pdf-${turn}`,
                name: toolName,
                args: {
                  title: turn === 1 ? "Valid" : "Broken",
                  assessment: "Synthetic body",
                },
              },
            },
          ],
        };
      };
      await runtime.executeRun(run.id, {
        provider,
        compileReport: async (source) =>
          source.includes("Broken")
            ? { ok: false, error: "Invalid synthetic revision" }
            : { ...(await fakeCompile(source)), profile: TEMPLATE_PROFILE },
      });
      const result = await status(run.id);
      expect(result.status).toBe(
        scenario === "success" ? "succeeded" : "failed",
      );
      if (scenario === "missing")
        expect(result.error).toContain(
          "without a successful required tool call",
        );
      if (scenario === "failed-final-revision")
        expect(result.error).toContain("without a current required PDF report");
    },
  );
  const templateCompile = async (source: string) => ({
    ...(await fakeCompile(source)),
    profile: TEMPLATE_PROFILE as typeof TEMPLATE_PROFILE,
  });
  it("publishes immutable template images, retains published resources, expires abandoned uploads and deletes workflow resources", async () => {
    const w = await templateWorkflow();
    const replacement = await w.resources.uploadTemplateResource(
      w.id,
      "logo.png",
      w.bytes,
    );
    const abandoned = await w.resources.uploadTemplateResource(
      w.id,
      "unused.png",
      w.bytes,
    );
    w.draft.nodes.at(-1)!.data.pdfTemplate!.images = [replacement];
    await runtime.saveDraft(w.id, w.draft);
    const [version] = await persistence.query(
      "SELECT snapshot FROM versions WHERE id=$1",
      [w.version.id],
    );
    expect(
      version.snapshot.workflow.nodes.at(-1).data.pdfTemplate.images,
    ).toEqual([w.image]);
    expect(version.snapshot.workflow.nodes.at(-1).data.rendererProfile).toBe(
      TEMPLATE_PROFILE,
    );
    await persistence.query(
      "UPDATE template_resources SET created_at=now()-interval '8 days' WHERE workflow_id=$1",
      [w.id],
    );
    await w.resources.cleanupTemplateResources();
    expect(await w.resources.readTemplateResource(w.id, w.image)).toEqual(
      w.bytes,
    );
    expect(await w.resources.readTemplateResource(w.id, replacement)).toEqual(
      w.bytes,
    );
    await expect(
      w.resources.readTemplateResource(w.id, abandoned),
    ).rejects.toThrow();
    await expect(
      w.resources.readTemplateResource("foreign", w.image),
    ).rejects.toThrow();
    const foreign = await workflow();
    foreign.draft.nodes.push(w.draft.nodes.at(-1)!);
    await expect(runtime.saveDraft(foreign.id, foreign.draft)).rejects.toThrow(
      "does not belong",
    );
    await expect(
      w.resources.uploadTemplateResource(w.id, "logo.png", w.bytes, [w.image]),
    ).rejects.toThrow("Duplicate");
    await runtime.deleteWorkflow(w.id);
    const { TemplateResourceStorage } =
      await import("../packages/connectors/src/template-resources");
    await expect(
      new TemplateResourceStorage().readImage(w.image),
    ).rejects.toThrow("missing");
  });
  it("shares fingerprints, recovery, latest selection and three attempts across PDF tools and attributes template attempts", async () => {
    const w = await templateWorkflow(),
      run = await runFor(w.version.id);
    const { generateReport, currentReport } =
      await import("../packages/runtime/src/report-execution");
    const agent = w.draft.nodes[2],
      template = w.draft.nodes.at(-1)!;
    const compile = vi.fn(templateCompile);
    const call = (id: string, args: unknown, node = template) =>
      generateReport(
        run.id,
        agent,
        run.id + id,
        args,
        AbortSignal.timeout(10000),
        compile,
        node,
      );
    const args = { title: "First", assessment: "" };
    const first = await call("one", args);
    expect(first.ok).toBe(true);
    expect(
      await call("same", args, { ...template, id: "another-template" }),
    ).toEqual(first);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0]).toContain("First");
    expect(await call("same", { title: "ignored", assessment: "" })).toEqual(
      first,
    );
    const revised = structuredClone(template);
    revised.data.pdfTemplate!.images = [
      { ...w.image, checksum: "0".repeat(64) },
    ];
    expect((await call("changed-image", args, revised)).ok).toBe(false);
    expect(await currentReport(run.id, agent.id)).toBeUndefined();
    expect((await call("missing-arg", { title: "Bad" })).ok).toBe(false);
    const freeform = await generateReport(
      run.id,
      {
        ...agent,
        data: {
          ...agent.data,
          rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
        },
      },
      run.id + "freeform",
      { source: "Fourth source" },
      AbortSignal.timeout(10000),
      fakeCompile,
    );
    expect(freeform.error).toContain("Three distinct");
    expect(await call("reuse", args)).toEqual(first);
    expect((await currentReport(run.id, agent.id))?.reportId).toBe(
      (first.data as { reportId: string }).reportId,
    );
    const attempts = await persistence.query(
      "SELECT * FROM report_attempts WHERE run_id=$1 ORDER BY attempt_order",
      [run.id],
    );
    expect(attempts[1].template_node_id).toBe("another-template");
    expect(attempts[0].generation_fingerprint).toBe(
      attempts[1].generation_fingerprint,
    );
    expect(attempts[2].generation_fingerprint).not.toBe(
      attempts[0].generation_fingerprint,
    );
    const recoveryRun = await runFor(w.version.id);
    const interrupted = vi
      .fn()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockImplementation(templateCompile);
    const recover = () =>
      generateReport(
        recoveryRun.id,
        agent,
        recoveryRun.id + "pdf",
        args,
        AbortSignal.timeout(10000),
        interrupted,
        template,
      );
    await expect(recover()).rejects.toThrow("interrupted");
    expect((await recover()).ok).toBe(true);
    expect(
      await persistence.query(
        "SELECT id FROM report_attempts WHERE run_id=$1",
        [recoveryRun.id],
      ),
    ).toHaveLength(1);
  });
  it("runs template MCP through the Agent, attaches its backend report in Test mode and never dispatches", async () => {
    const w = await templateWorkflow(),
      run = await runFor(w.version.id);
    await persistence.query("UPDATE emails SET raw=$2 WHERE id=$1", [
      run.email.id,
      JSON.stringify({ test: true }),
    ]);
    const send = vi.fn(),
      compile = vi.fn(templateCompile);
    await runtime.executeRun(run.id, {
      compileReport: compile,
      sendEmail: send,
    });
    expect((await status(run.id)).status).toBe("succeeded");
    expect(send).not.toHaveBeenCalled();
    const [email] = await persistence.query(
      "SELECT * FROM email_sends WHERE run_id=$1",
      [run.id],
    );
    expect(email.message.attachments).toHaveLength(1);
    const [attempt] = await persistence.query(
      "SELECT * FROM report_attempts WHERE run_id=$1",
      [run.id],
    );
    expect(attempt.template_node_id).toBe("template");
    expect(email.message.attachments[0].reportId).toBe(attempt.report_id);
    expect((compile.mock.calls[0] as unknown[])[3]).toEqual([
      { ...w.image, content: w.bytes.toString("base64") },
    ]);
  });
  it("does not double-count legacy source attempts when a running workflow upgrades to fingerprints", async () => {
    const w = await pdfWorkflow(),
      run = await runFor(w.version.id);
    const { generateReport } =
      await import("../packages/runtime/src/report-execution");
    const node = {
      ...w.draft.nodes[2],
      data: {
        ...w.draft.nodes[2].data,
        rendererProfile: "tectonic-0.15.0-bundle33-report-v1",
      },
    };
    const compile = vi.fn(fakeCompile);
    const call = (id: string, source: string) =>
      generateReport(
        run.id,
        node,
        run.id + id,
        { source },
        AbortSignal.timeout(10000),
        compile,
      );
    const first = await call("first", "first source");
    await persistence.query(
      "UPDATE report_attempts SET generation_fingerprint=NULL WHERE run_id=$1",
      [run.id],
    );
    expect(await call("reused", "first source")).toEqual(first);
    expect((await call("second", "second source")).ok).toBe(true);
    expect((await call("third", "third source")).ok).toBe(true);
    expect((await call("fourth", "fourth source")).error).toContain(
      "Three distinct",
    );
    expect(compile).toHaveBeenCalledTimes(3);
  });
});
