import { receiptWorkflow, receiptTool } from "../fixtures/receipt-workflow";
// Runs against an already-started synthetic Docker stack; no live providers.
import assert from "node:assert/strict";
import type { Workflow } from "../packages/contracts/src/index";
const base = process.env.SMOKE_APP_URL ?? "http://localhost:3001";
const password = process.env.E2E_ADMIN_PASSWORD;
if (!password)
  throw new Error(
    "Set E2E_ADMIN_PASSWORD to the synthetic stack administrator password",
  );
let cookie = "";
async function request(
  endpoint: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      Cookie: cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert(response.ok, `${endpoint}: ${JSON.stringify(result)}`);
  if (endpoint === "auth/login")
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  return result;
}
const readyDeadline = Date.now() + 30000;
while (true) {
  try {
    const response = await fetch(`${base}/login`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) break;
  } catch {
    /* Next.js may still be starting after Compose returns. */
  }
  if (Date.now() >= readyDeadline)
    throw new Error("Docker web did not become ready within 30 seconds");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await request("auth/login", {
  email: process.env.ADMIN_EMAIL ?? "admin@example.com",
  password,
});
const tool = {
  ...receiptTool,
  endpoint: process.env.SMOKE_TOOL_ENDPOINT ?? "http://mock-api:4010/receipts",
};
const bootstrap = await request("bootstrap");
await request(
  "settings",
  {
    TOOL_ALLOWED_ORIGINS: [
      ...new Set([
        ...bootstrap.settings.TOOL_ALLOWED_ORIGINS.split(",").filter(Boolean),
        new URL(tool.endpoint).origin,
      ]),
    ].join(","),
  },
  "PUT",
);
const savedTool = await request("tools", tool);
const workflow = await request("workflows", {
  name: `Docker receipt ${Date.now()}`,
});
const draft: Workflow = {
  ...structuredClone(receiptWorkflow),
  name: workflow.draft.name,
};
draft.nodes.find((node) => node.type === "tool")!.data.toolId = savedTool.id;
await request(
  `workflows/${workflow.id}`,
  {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.type === "email"
        ? {
            ...node,
            data: {
              ...node.data,
              recipient: `docker-${workflow.id}@example.com`,
            },
          }
        : node,
    ),
  },
  "PUT",
);
const published = await request(`workflows/${workflow.id}/publish`, {});
assert.equal(published.number, 1);
const queued = await request(`workflows/${workflow.id}/test`, {});
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const run = await request(`runs/${queued.id}`);
  if (["queued", "running"].includes(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    continue;
  }
  assert.equal(run.status, "succeeded", run.error);
  assert(
    run.calls.some(
      (call: { name: string; status: string }) =>
        call.name === "submit_receipt" && call.status === "succeeded",
    ),
  );
  assert(JSON.stringify(run.calls).includes("Paper & Pine"));
  console.log(
    "Docker receipt smoke passed: published workflow, queued worker execution, MCP call and receipt response.",
  );
  const replyDraft: Workflow = {
    ...draft,
    nodes: [
      ...draft.nodes.map((node) =>
        node.type === "email"
          ? {
              ...node,
              data: {
                ...node.data,
                recipient: `docker-${workflow.id}@example.com`,
              },
            }
          : node,
      ),
      {
        id: "reply",
        type: "send_email",
        position: { x: 1010, y: 150 },
        data: {
          label: "Send email",
          bodyTemplate: "Receipt processed: {{steps.agent.text}}",
        },
      },
    ],
    edges: [
      ...draft.edges,
      { id: "reply", source: "agent", target: "reply", kind: "execution" },
    ],
  };
  await request(`workflows/${workflow.id}`, replyDraft, "PUT");
  await request(`workflows/${workflow.id}/publish`, {});
  const preview = await request(`workflows/${workflow.id}/test`, {});
  const previewDeadline = Date.now() + 60000;
  while (Date.now() < previewDeadline) {
    const rendered = await request(`runs/${preview.id}`);
    if (["queued", "running"].includes(rendered.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    assert.equal(rendered.status, "succeeded", rendered.error);
    assert.equal(rendered.emailSends.length, 1);
    assert.equal(rendered.emailSends[0].mode, "preview");
    assert.equal(rendered.emailSends[0].status, "succeeded");
    assert.equal(rendered.emailSends[0].provider_email_id, null);
    assert.equal(rendered.emailSends[0].first_attempt_at, null);
    assert.equal(
      rendered.emailSends[0].message.to[0],
      "receipts@paperandpine.example",
    );
    assert(
      rendered.emailSends[0].message.text.startsWith("Receipt processed:"),
    );
    console.log(
      "Docker email smoke passed: rendered preview, durable terminal completion, no sending attempt.",
    );
    process.exit(0);
  }
  throw new Error("Docker email preview did not finish within 60 seconds");
}
throw new Error("Docker receipt run did not finish within 60 seconds");
