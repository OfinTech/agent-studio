import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  query,
  encrypt,
  redact,
} from "../../../../../packages/persistence/src/index";
import {
  loadSettings,
  saveSetting,
  setting,
  settingKeys,
} from "../../../../../packages/persistence/src/settings";
import {
  toolSchema,
  ConfigurationError,
  workflowSchema,
  receiptWorkflow,
} from "../../../../../packages/contracts/src/index";
import {
  publish,
  saveDraft,
  testRun,
  ingest,
} from "../../../../../packages/runtime/src/index";
import { verifyWebhook } from "../../../../../packages/connectors/src/index";
import { validateTool } from "../../../../../packages/mcp/src/index";
import {
  authenticated,
  checkPassword,
  createSession,
  SESSION_COOKIE,
  cookieOptions,
} from "../../../lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const response = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 262144) {
      await reader.cancel();
      throw new HttpError(413, "Request body exceeds 256 KB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const path = (await context.params).path;
    const route = path.join("/");
    const method = request.method;
    if (route === "health" && method === "GET") {
      await query("SELECT 1");
      return response({ ok: true });
    }
    await loadSettings();
    if (route === "webhooks/resend" && method === "POST") {
      const raw = await body(request);
      let event;
      try {
        event = verifyWebhook(
          raw,
          Object.fromEntries(
            ["svix-id", "svix-timestamp", "svix-signature"].map((h) => [
              h,
              request.headers.get(h) ?? "",
            ]),
          ),
        );
      } catch {
        throw new HttpError(400, "Invalid webhook signature or event");
      }
      try {
        return response(await ingest(event), 202);
      } catch {
        throw new HttpError(503, "Email could not be queued; retry delivery");
      }
    }
    if (route === "mock/receipts" && method === "POST") {
      const key = request.headers.get("idempotency-key") ?? randomUUID();
      let receipt: unknown;
      try {
        receipt = JSON.parse(await body(request));
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      await query(
        "INSERT INTO mock_receipts(key,id,receipt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [key, randomUUID(), JSON.stringify(receipt)],
      );
      const [stored] = await query(
        "SELECT id,receipt FROM mock_receipts WHERE key=$1",
        [key],
      );
      return response({ ...stored, accepted: true }, 201);
    }
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if (
        origin !==
        new URL(process.env.APP_URL ?? "http://localhost:3000").origin
      )
        throw new HttpError(403, "Request origin is not allowed");
    }
    if (route === "auth/login" && method === "POST") {
      const data = z
        .object({
          email: z.string().max(254),
          password: z.string().min(1).max(1024),
        })
        .parse(JSON.parse(await body(request)));
      const [attempt] = await query(
        "INSERT INTO login_attempts(key,count,window_at) VALUES('admin',1,now()) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.window_at<now()-interval '1 minute' THEN 1 ELSE login_attempts.count+1 END,window_at=CASE WHEN login_attempts.window_at<now()-interval '1 minute' THEN now() ELSE login_attempts.window_at END RETURNING count",
      );
      if (attempt.count > 10)
        throw new HttpError(429, "Too many attempts. Try again in one minute.");
      const valid = checkPassword(data.password);
      if (!valid || data.email !== process.env.ADMIN_EMAIL)
        throw new HttpError(401, "Incorrect email or password");
      const result = response({ ok: true });
      result.cookies.set(SESSION_COOKIE, createSession(), cookieOptions());
      return result;
    }
    if (!(await authenticated()))
      throw new HttpError(401, "Sign in to continue");
    if (route === "auth/logout" && method === "POST") {
      const result = response({ ok: true });
      result.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
      return result;
    }
    if (route === "mock/receipts" && method === "GET")
      return response(
        await query(
          "SELECT key,id,receipt,created_at FROM mock_receipts ORDER BY created_at DESC LIMIT 100",
        ),
      );
    if (route === "bootstrap" && method === "GET") {
      const [workflows, tools, credentials, runs] = await Promise.all([
        query(
          "SELECT w.*,v.number FROM workflows w LEFT JOIN versions v ON v.id=w.published_version ORDER BY w.created_at",
        ),
        query("SELECT definition FROM tools ORDER BY created_at"),
        query(
          "SELECT id,name,kind,created_at FROM credentials ORDER BY created_at",
        ),
        query(
          "SELECT r.*,v.number,v.snapshot->'workflow'->>'name' AS workflow_name FROM runs r JOIN versions v ON v.id=r.version_id ORDER BY r.created_at DESC LIMIT 100",
        ),
      ]);
      return response({
        workflows,
        tools: tools.map((t) => t.definition),
        credentials,
        runs,
        adminEmail: process.env.ADMIN_EMAIL,
        settings: {
          TOOL_ALLOWED_ORIGINS: setting("TOOL_ALLOWED_ORIGINS"),
          MAX_ATTACHMENT_BYTES: setting("MAX_ATTACHMENT_BYTES"),
          RESEND_API_KEY: Boolean(setting("RESEND_API_KEY")),
          RESEND_WEBHOOK_SECRET: Boolean(setting("RESEND_WEBHOOK_SECRET")),
        },
      });
    }
    if (route === "settings" && method === "PUT") {
      const data = z
        .object(
          Object.fromEntries(
            settingKeys.map((k) => [k, z.string().max(4096).optional()]),
          ) as Record<(typeof settingKeys)[number], z.ZodOptional<z.ZodString>>,
        )
        .parse(JSON.parse(await body(request)));
      if (data.TOOL_ALLOWED_ORIGINS !== undefined) {
        const origins = data.TOOL_ALLOWED_ORIGINS.split(",")
          .map((o) => o.trim())
          .filter(Boolean);
        for (const origin of origins) {
          let parsed;
          try {
            parsed = new URL(origin);
          } catch {
            throw new HttpError(400, `Invalid origin: ${origin}`);
          }
          if (parsed.origin !== origin)
            throw new HttpError(400, `Use an exact origin: ${parsed.origin}`);
        }
        data.TOOL_ALLOWED_ORIGINS = origins.join(",");
      }
      if (
        data.MAX_ATTACHMENT_BYTES &&
        !/^[1-9]\d*$/.test(data.MAX_ATTACHMENT_BYTES)
      )
        throw new HttpError(
          400,
          "Maximum attachment bytes must be a positive integer",
        );
      for (const key of settingKeys)
        if (data[key] !== undefined) await saveSetting(key, data[key]);
      return response({ ok: true });
    }
    if (route === "workflows" && method === "POST") {
      const data = z
        .object({
          name: z.string().min(1).max(100),
          template: z.enum(["blank", "receipt"]).default("blank"),
        })
        .parse(JSON.parse(await body(request)));
      const id = randomUUID();
      const workflow =
        data.template === "receipt"
          ? { ...receiptWorkflow, name: data.name }
          : { name: data.name, nodes: [], edges: [] };
      await saveDraft(id, workflow);
      return response({ id, draft: workflow }, 201);
    }
    if (path[0] === "workflows" && path.length === 2 && method === "PUT") {
      await saveDraft(
        path[1],
        workflowSchema.parse(JSON.parse(await body(request))),
      );
      return response({ ok: true });
    }
    if (
      path[0] === "workflows" &&
      path[2] === "publish" &&
      path.length === 3 &&
      method === "POST"
    )
      return response(await publish(path[1]), 201);
    if (
      path[0] === "workflows" &&
      path[2] === "test" &&
      path.length === 3 &&
      method === "POST"
    )
      return response(await testRun(path[1]), 202);
    if (route === "credentials" && method === "POST") {
      const data = z
        .object({
          name: z.string().min(1).max(100),
          kind: z.enum(["gemini", "openai", "claude", "api"]),
          secret: z.string().min(1).max(4096),
        })
        .parse(JSON.parse(await body(request)));
      const id = randomUUID();
      await query(
        "INSERT INTO credentials(id,name,kind,encrypted) VALUES($1,$2,$3,$4)",
        [id, data.name, data.kind, encrypt(data.secret, id)],
      );
      return response({ id, name: data.name, kind: data.kind }, 201);
    }
    if (route === "tools" && method === "POST") {
      const tool = toolSchema.parse({
        ...JSON.parse(await body(request)),
        id: randomUUID(),
      });
      validateTool(tool);
      await query("INSERT INTO tools(id,definition) VALUES($1,$2)", [
        tool.id,
        JSON.stringify(tool),
      ]);
      return response(tool, 201);
    }
    if (path[0] === "tools" && path.length === 2 && method === "PUT") {
      const tool = toolSchema.parse({
        ...JSON.parse(await body(request)),
        id: path[1],
      });
      validateTool(tool);
      const rows = await query(
        "UPDATE tools SET definition=$2 WHERE id=$1 RETURNING id",
        [tool.id, JSON.stringify(tool)],
      );
      if (!rows.length) throw new HttpError(404, "Tool not found");
      return response(tool);
    }
    if (path[0] === "runs" && path.length === 2 && method === "GET") {
      const [run] = await query(
        "SELECT r.*,v.number,v.snapshot FROM runs r JOIN versions v ON v.id=r.version_id WHERE r.id=$1",
        [path[1]],
      );
      if (!run) throw new HttpError(404, "Run not found");
      const [steps, calls, emailSends] = await Promise.all([
        query("SELECT * FROM steps WHERE run_id=$1 ORDER BY created_at", [
          path[1],
        ]),
        query("SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY created_at", [
          path[1],
        ]),
        query("SELECT * FROM email_sends WHERE run_id=$1 ORDER BY created_at", [
          path[1],
        ]),
      ]);
      return response(redact({ ...run, steps, calls, emailSends }));
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (error instanceof HttpError)
      return response({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return response(
        {
          error: error.issues
            .map((i) => i.path.join(".") + ": " + i.message)
            .join("; "),
        },
        400,
      );
    if (error instanceof SyntaxError)
      return response({ error: "Invalid JSON" }, 400);
    if ((error as { code?: string }).code === "23505")
      return response(
        {
          error:
            "This receiving address is already assigned to another workflow.",
        },
        409,
      );
    if (error instanceof ConfigurationError)
      return response({ error: error.message }, 400);
    console.error("Application request failed");
    return response(
      { error: "Request failed. Check server configuration." },
      500,
    );
  }
}
export { handle as GET, handle as POST, handle as PUT };
