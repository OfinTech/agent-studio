// Run inside the deployed web container. Uses an in-memory administrator session;
// creates only a synthetic Test run, verifies preview mode, and removes its workflow.
import assert from "node:assert/strict";
import sharp from "sharp";
import { createSession, SESSION_COOKIE } from "../apps/web/lib/auth";
import {
  receiptWorkflow,
  type Workflow,
} from "../packages/contracts/src/index";
import { defaultPdfTemplate } from "../packages/contracts/src/pdf-templates";
const base = process.env.APP_URL!;
const headers = {
  Origin: new URL(base).origin,
  Cookie: `${SESSION_COOKIE}=${createSession()}`,
};
async function api(
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
assert((await fetch(`${base}/login`)).ok);
assert((await fetch(`${base}/api/health`)).ok);
const workflow = await api("workflows", {
  name: "Synthetic deployment PDF check",
  template: "blank",
});
let terminal = true;
try {
  const bytes = await sharp({
    create: { width: 40, height: 20, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const uploaded = await fetch(
    `${base}/api/workflows/${workflow.id}/resources?filename=logo.png`,
    { method: "POST", headers, body: new Uint8Array(bytes) },
  );
  assert(uploaded.ok, `Upload: HTTP ${uploaded.status}`);
  const image = await uploaded.json();
  const draft: Workflow = {
    name: workflow.draft.name,
    nodes: structuredClone(receiptWorkflow.nodes.slice(0, 3)),
    edges: structuredClone(
      receiptWorkflow.edges.filter((e) => e.kind === "execution"),
    ),
  };
  draft.nodes[0].data.recipient = `deployment-${workflow.id}@example.com`;
  draft.nodes[2].data.requiredTool = undefined;
  draft.nodes[2].data.provider = "mock";
  draft.nodes.push({
    id: "template",
    type: "pdf_template",
    position: { x: 600, y: 300 },
    data: {
      label: "Deployment template",
      pdfTemplate: {
        ...defaultPdfTemplate,
        images: [image],
        source: defaultPdfTemplate.source.replace(
          "<<assessment>>",
          String.raw`\includegraphics[width=1cm]{assets/logo.png} <<assessment>>`,
        ),
      },
    },
  });
  draft.nodes.push({
    id: "reply",
    type: "send_email",
    position: { x: 1000, y: 0 },
    data: {
      label: "Preview",
      bodyTemplate: "{{steps.agent.text}}",
      reportSourceNodeId: "agent",
    },
  });
  draft.edges.push(
    { id: "template", source: "template", target: "agent", kind: "tool" },
    { id: "reply", source: "agent", target: "reply", kind: "execution" },
  );
  await api(`workflows/${workflow.id}`, draft, "PUT");
  await api(`workflows/${workflow.id}/publish`, {});
  const run = await api(`workflows/${workflow.id}/test`, {});
  terminal = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = await api(`runs/${run.id}`);
    if (["queued", "running"].includes(result.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    terminal = true;
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.emailSends.length, 1);
    assert.equal(result.emailSends[0].mode, "preview");
    assert.equal(result.emailSends[0].provider_email_id, null);
    assert.equal(result.reports[0].template_node_id, "template");
    const report = result.emailSends[0].message.attachments[0];
    for (const path of [
      `runs/${run.id}/reports/${report.reportId}`,
      `workflows/${workflow.id}/resources/${image.id}`,
    ]) {
      const response = await fetch(`${base}/api/${path}`, { headers });
      assert(response.ok);
      const content = Buffer.from(await response.arrayBuffer());
      if (path.startsWith("runs/"))
        assert.equal(content.subarray(0, 5).toString(), "%PDF-");
      else assert(content.equals(bytes));
      assert.equal((await fetch(`${base}/api/${path}`)).status, 401);
    }
    console.log(
      "PASS public health/login, authenticated upload/download, template compilation and preview-only email attachment",
    );
    break;
  }
  assert(terminal, `Synthetic run did not complete: ${run.id}`);
} finally {
  if (terminal) await api(`workflows/${workflow.id}`, undefined, "DELETE");
  else
    console.error(`Synthetic workflow retained for inspection: ${workflow.id}`);
}
