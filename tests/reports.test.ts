import { expect, it, vi } from "vitest";
import {
  receiptWorkflow,
  receiptTool,
  validateWorkflow,
  workflowSchema,
  completionTool,
  defaultStates,
} from "../packages/contracts/src/index";
import {
  generatePdfTool,
  reportSources,
  REPORT_PROFILE,
} from "../packages/contracts/src/reports";
import { createToolSession } from "../packages/mcp/src/index";
import {
  GeminiProvider,
  OpenAIProvider,
  ClaudeProvider,
  type Message,
} from "../packages/providers/src/index";
it("preserves old workflows and completion schemas while rejecting invalid PDF sources and name collisions", () => {
  expect(workflowSchema.parse(receiptWorkflow)).toEqual(receiptWorkflow);
  const workflow = structuredClone(receiptWorkflow);
  workflow.nodes[2].data.generatePdf = true;
  workflow.nodes.push({
    id: "reply",
    type: "send_email",
    position: { x: 0, y: 0 },
    data: {
      label: "Reply",
      bodyTemplate: "Reply",
      reportSourceNodeId: "agent",
    },
  });
  workflow.edges.push({
    id: "reply",
    source: "agent",
    target: "reply",
    kind: "execution",
  });
  expect(reportSources(workflow, "reply").map((n) => n.id)).toEqual(["agent"]);
  expect(validateWorkflow(workflow, [receiptTool])).toEqual([]);
  expect(
    validateWorkflow(workflow, [{ ...receiptTool, name: "generate_pdf" }]),
  ).toContain("generate_pdf conflicts with the built-in PDF report tool.");
  for (const source of ["deleted", "reply", "tool"]) {
    workflow.nodes.at(-1)!.data.reportSourceNodeId = source;
    expect(validateWorkflow(workflow, [receiptTool])).toContain(
      "Select a PDF-enabled ancestor Agent for the email attachment.",
    );
  }
  workflow.nodes.at(-1)!.data.reportSourceNodeId = "agent";
  workflow.nodes[2].data.generatePdf = false;
  expect(reportSources(workflow, "reply")).toEqual([]);
  expect(validateWorkflow(workflow, [receiptTool])).toContain(
    "Select a PDF-enabled ancestor Agent for the email attachment.",
  );
  const finish = completionTool({
    id: "outcome",
    type: "outcome",
    position: { x: 0, y: 0 },
    data: { label: "Outcome", states: defaultStates() },
  });
  expect(finish.inputSchema.required).toEqual(["state", "reason", "result"]);
  expect(Object.keys(finish.inputSchema.properties)).toEqual([
    "state",
    "reason",
    "result",
  ]);
});
it("registers PDF through internal MCP without an HTTP definition", async () => {
  const result = {
    ok: true,
    data: {
      reportId: "opaque",
      pageCount: 2,
      warnings: [],
      textPreview: "Synthetic",
      textTruncated: false,
    },
  };
  const http = vi.fn();
  const session = await createToolSession([], http, undefined, [
    { definition: generatePdfTool, invoke: async () => result },
  ]);
  try {
    expect((await session.client.listTools()).tools[0]).toMatchObject(
      generatePdfTool,
    );
    const response = await session.client.callTool({
      name: "generate_pdf",
      arguments: { source: "synthetic" },
    });
    expect(response.structuredContent).toEqual(result);
    expect(http).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
  await expect(
    createToolSession(
      [{ ...receiptTool, name: "generate_pdf" }],
      http,
      undefined,
      [{ definition: generatePdfTool, invoke: async () => result }],
    ),
  ).rejects.toThrow("Duplicate");
});
for (const kind of ["gemini", "openai", "claude"] as const) {
  it(`${kind} declares generate_pdf and preserves bounded JSON tool results without PDF input`, async () => {
    const response = {
      ok: true,
      data: {
        reportId: "opaque",
        pageCount: 2,
        warnings: [],
        textPreview: "Synthetic text",
        textTruncated: true,
      },
    };
    const messages: Message[] = [
      { role: "user", parts: [{ text: "Write a synthetic report" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "pdf-1",
              name: "generate_pdf",
              args: { source: "synthetic" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "pdf-1", name: "generate_pdf", response } },
        ],
      },
    ];
    const config = {
      ...receiptWorkflow.nodes[2].data,
      generatePdf: true,
      rendererProfile: REPORT_PROFILE,
    };
    let payload: unknown;
    if (kind === "gemini") {
      const provider = new GeminiProvider("synthetic");
      const generateContent = vi.fn().mockResolvedValue({
        candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }],
      });
      provider.ai = { models: { generateContent } } as any;
      await provider.infer(
        messages,
        config,
        [generatePdfTool],
        AbortSignal.timeout(2000),
      );
      payload = generateContent.mock.calls[0][0];
      expect((payload as any).contents).toEqual(messages);
    } else {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              kind === "openai"
                ? {
                    status: "completed",
                    output: [
                      {
                        type: "message",
                        content: [{ type: "output_text", text: "done" }],
                      },
                    ],
                  }
                : {
                    stop_reason: "end_turn",
                    content: [{ type: "text", text: "done" }],
                  },
            ),
          ),
      );
      const provider =
        kind === "openai"
          ? new OpenAIProvider("synthetic", request)
          : new ClaudeProvider("synthetic", request);
      await provider.infer(
        messages,
        config,
        [generatePdfTool],
        AbortSignal.timeout(2000),
      );
      payload = JSON.parse(
        (request.mock.calls as unknown as [string, { body: string }][])[0][1]
          .body,
      );
    }
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("generate_pdf");
    expect(serialized).toContain("textPreview");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("application/pdf");
  });
}

it("publishes immutable report bytes atomically and never overwrites an existing file", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ReportStorage, reportChecksum } =
    await import("../packages/connectors/src/reports");
  const root = await mkdtemp(join(tmpdir(), "pdf-storage-test-"));
  const storage = new ReportStorage();
  storage.root = root;
  const id = "11111111-1111-4111-8111-111111111111",
    bytes = Buffer.from("%PDF-1.4 immutable");
  try {
    await storage.put(id, bytes);
    await expect(
      storage.put(id, Buffer.from("different bytes")),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(
      await storage.read({
        reportId: id,
        nodeId: "agent",
        filename: "report.pdf",
        checksum: reportChecksum(bytes),
        size: bytes.length,
        pageCount: 1,
      }),
    ).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("only offers PDF Agents on the email's own branch", async () => {
  const { addOutcome } = await import("../packages/contracts/src/index");
  const workflow = addOutcome(
    structuredClone(receiptWorkflow),
    "agent",
    "outcome",
  );
  workflow.nodes[2].data.generatePdf = true;
  for (const branch of ["success", "failure"]) {
    workflow.nodes.push({
      ...structuredClone(workflow.nodes[2]),
      id: branch,
      data: { ...workflow.nodes[2].data, requiredTool: undefined },
    });
    workflow.nodes.push({
      id: branch + "-reply",
      type: "send_email",
      position: { x: 0, y: 0 },
      data: {
        label: "Reply",
        bodyTemplate: "Reply",
        reportSourceNodeId: branch,
      },
    });
    workflow.edges.push({
      id: branch,
      source: "outcome",
      target: branch,
      kind: "execution",
      stateId: branch,
    });
    workflow.edges.push({
      id: branch + "-reply",
      source: branch,
      target: branch + "-reply",
      kind: "execution",
    });
  }
  expect(reportSources(workflow, "success-reply").map((n) => n.id)).toEqual([
    "agent",
    "success",
  ]);
  expect(validateWorkflow(workflow, [receiptTool])).toEqual([]);
  workflow.nodes.find(
    (n) => n.id === "success-reply",
  )!.data.reportSourceNodeId = "failure";
  expect(validateWorkflow(workflow, [receiptTool])).toContain(
    "Select a PDF-enabled ancestor Agent for the email attachment.",
  );
});
