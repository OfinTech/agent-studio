import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, redact } from "../packages/persistence/src/index";
import {
  isPublicAddress,
  assertToolDestination,
  boundedRequest,
} from "../packages/connectors/src/network";
import {
  executeHttpTool,
  createToolSession,
  validateTool,
} from "../packages/mcp/src/index";
import {
  receiptTool,
  type ToolDefinition,
} from "../packages/contracts/src/index";
import { validateAttachment } from "../packages/connectors/src/storage";
import { verifyWebhook } from "../packages/connectors/src/index";
import { Webhook } from "svix";
import { settings } from "../packages/persistence/src/settings";
let server: Server;
let origin: string;
let hits: number;
let mode: "ok" | "ambiguous" | "echo" | "redirect";
let received: any;
beforeEach(async () => {
  hits = 0;
  mode = "ok";
  server = createServer(async (req, res) => {
    hits++;
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body || "{}") };
    if (mode === "ambiguous") {
      res.writeHead(500).end('{"error":"after commit"}');
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1" }).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        mode === "echo"
          ? {
              authorization: req.headers.authorization,
              message: "echo " + req.headers.authorization,
            }
          : { accepted: true },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + (server.address() as any).port;
  settings.set("TOOL_ALLOWED_ORIGINS", origin);
  process.env.TOOL_ALLOW_PRIVATE_ORIGINS = origin;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});
const args = {
  merchant: "Paper & Pine",
  date: "2026-09-09",
  currency: "USD",
  total: 42.5,
};
const tool = (): ToolDefinition => ({
  ...structuredClone(receiptTool),
  endpoint: origin + "/receipts",
});
describe("credentials and network boundaries", () => {
  it("binds encrypted credentials to their IDs and detects tampering", () => {
    const a = encrypt("secret-token", "a");
    expect(a).not.toContain("secret-token");
    expect(decrypt(a, "a")).toBe("secret-token");
    expect(() => decrypt(a, "b")).toThrow();
    const pieces = a.split(".");
    pieces[2] = "00" + pieces[2].slice(2);
    expect(() => decrypt(pieces.join("."), "a")).toThrow();
  });
  it("redacts nested secret fields and echoed secret values", () =>
    expect(
      redact({ nested: { apiKey: "abc" }, output: "echo abc" }, ["abc"]),
    ).toEqual({ nested: { apiKey: "[REDACTED]" }, output: "echo [REDACTED]" }));
  it("blocks localhost, link-local, private IPv4 and mapped IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });
  it("requires an exact allowlisted origin and pins private-address policy", async () => {
    expect(() => assertToolDestination("https://example.com")).toThrow();
    await expect(boundedRequest(new URL(origin))).rejects.toThrow(/Private/);
    expect(hits).toBe(0);
  });
  it("rejects unsafe headers and GET body mappings", () => {
    expect(() =>
      validateTool({
        ...tool(),
        auth: { type: "api-key", header: "Host", credentialId: "a" },
      }),
    ).toThrow(/Reserved/);
    expect(() => validateTool({ ...tool(), method: "GET" })).toThrow(/GET/);
  });
  it("resolves credentials only after validation and never returns them", async () => {
    mode = "echo";
    let reads = 0;
    const result = await executeHttpTool(
      {
        ...tool(),
        auth: { type: "bearer", header: "X-API-Key", credentialId: "api" },
      },
      args,
      "stable",
      async () => {
        reads++;
        return "sensitive-token";
      },
    );
    expect(reads).toBe(1);
    expect(received.headers.authorization).toBe("Bearer sensitive-token");
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
    expect(result.ok).toBe(true);
  });
  it("rejects invalid arguments before fetching credentials or HTTP", async () => {
    const result = await executeHttpTool(
      tool(),
      { ...args, total: "oops" },
      "key",
      async () => {
        throw new Error("Should not resolve");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid tool arguments/);
    expect(hits).toBe(0);
  });
  it("keeps model fields out of fixed endpoint and credentials", async () => {
    await executeHttpTool(
      tool(),
      { ...args, endpoint: "http://evil.example", credentialId: "other" },
      "key",
      async () => {
        throw new Error("Not expected");
      },
    );
    expect(hits).toBe(0);
  });
  it("requires review for ambiguous writes without idempotency", async () => {
    mode = "ambiguous";
    expect(
      await executeHttpTool(
        { ...tool(), idempotencyHeader: undefined },
        args,
        "key",
        async () => "",
      ),
    ).toMatchObject({ ok: false, review: true, retryable: false });
  });
  it("retries ambiguous writes only with a configured idempotency key", async () => {
    mode = "ambiguous";
    const result = await executeHttpTool(
      tool(),
      args,
      "stable-key",
      async () => "",
    );
    expect(result).toMatchObject({ ok: false, review: false, retryable: true });
    expect(received.headers["idempotency-key"]).toBe("stable-key");
  });
  it("does not follow redirects", async () => {
    mode = "redirect";
    const result = await executeHttpTool(tool(), args, "key", async () => "");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("302");
    expect(hits).toBe(1);
  });
});
describe("internal MCP", () => {
  it("discovers generated tools, calls HTTP, and rejects unknown or invalid calls", async () => {
    const session = await createToolSession([tool()], (t, a) =>
      executeHttpTool(t, a, "key", async () => ""),
    );
    try {
      const listed = await session.client.listTools();
      expect(listed.tools[0].name).toBe("submit_receipt");
      expect(listed.tools[0].inputSchema).toEqual(receiptTool.inputSchema);
      const invalid = await session.client.callTool({
        name: "submit_receipt",
        arguments: { total: "bad" },
      });
      expect(invalid.isError).toBe(true);
      expect(hits).toBe(0);
      const unknown = await session.client.callTool({
        name: "not_registered",
        arguments: {},
      });
      expect(unknown.isError).toBe(true);
      const result = await session.client.callTool({
        name: "submit_receipt",
        arguments: args,
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(hits).toBe(1);
    } finally {
      await session.close();
    }
  });
});
describe("inbound input", () => {
  it("verifies signatures, timestamps, and detects changed payloads", () => {
    const secret = "whsec_" + randomBytes(32).toString("base64");
    settings.set("RESEND_WEBHOOK_SECRET", secret);
    const webhook = new Webhook(secret);
    const raw = JSON.stringify({
      type: "email.received",
      data: { email_id: "email-id", to: ["receipts@example.com"] },
    });
    const timestamp = new Date();
    const headers = {
      "svix-id": "event-id",
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": webhook.sign("event-id", timestamp, raw),
    };
    expect(verifyWebhook(raw, headers).data.email_id).toBe("email-id");
    expect(() => verifyWebhook(raw + " ", headers)).toThrow();
    expect(() =>
      verifyWebhook(raw, { ...headers, "svix-timestamp": "1" }),
    ).toThrow();
  });
  it("rejects attachment MIME spoofing and unsupported files", () => {
    expect(() =>
      validateAttachment("application/pdf", Buffer.from("not a PDF")),
    ).toThrow();
    expect(() =>
      validateAttachment("text/html", Buffer.from("<script>")),
    ).toThrow();
    expect(() =>
      validateAttachment(
        "image/png",
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      ),
    ).not.toThrow();
  });
});
