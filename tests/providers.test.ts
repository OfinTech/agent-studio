import { receiptTool, receiptWorkflow } from "../fixtures/receipt-workflow";
import { it, expect, vi } from "vitest";
import { GeminiProvider } from "../packages/providers/src/index";

it("tracks uploaded files before readiness failure and supports cleanup", async () => {
  const provider = new GeminiProvider("synthetic-key");
  const remove = vi.fn().mockResolvedValue({});
  provider.ai = {
    files: {
      upload: vi
        .fn()
        .mockResolvedValue({ name: "files/test", state: "FAILED" }),
      delete: remove,
    },
  } as any;
  const tracked: string[] = [];
  await expect(
    provider.upload(
      Buffer.from("%PDF-1.4"),
      "application/pdf",
      "receipt.pdf",
      async (name) => {
        tracked.push(name);
      },
      AbortSignal.timeout(2000),
    ),
  ).rejects.toThrow("Provider attachment processing failed");
  expect(tracked).toEqual(["files/test"]);
  await provider.remove(tracked[0]);
  expect(remove).toHaveBeenCalledWith({ name: "files/test" });
});
it("classifies transient Gemini upload errors for durable retry", async () => {
  const provider = new GeminiProvider("synthetic-key");
  provider.ai = {
    files: { upload: vi.fn().mockRejectedValue({ status: 429 }) },
  } as any;
  await expect(
    provider.upload(
      Buffer.from("%PDF-1.4"),
      "application/pdf",
      "receipt.pdf",
      async () => {},
      AbortSignal.timeout(2000),
    ),
  ).rejects.toMatchObject({ retryable: true });
});
it("preserves Gemini thought signatures and exchanges declarative function schemas", async () => {
  const provider = new GeminiProvider("synthetic-key");
  const content = {
    role: "model",
    parts: [
      {
        thoughtSignature: "opaque-provider-signature",
        functionCall: { id: "call-1", name: "submit_receipt", args: {} },
      },
    ],
  };
  const generateContent = vi
    .fn()
    .mockResolvedValue({ candidates: [{ content }] });
  provider.ai = { models: { generateContent } } as any;
  const messages = [
    { role: "user", parts: [{ text: "Extract this receipt" }] },
  ];
  expect(
    await provider.infer(
      messages,
      receiptWorkflow.nodes[2].data,
      [receiptTool],
      AbortSignal.timeout(2000),
    ),
  ).toEqual(content);
  expect(generateContent.mock.calls[0][0].contents).toEqual(messages);
  expect(
    generateContent.mock.calls[0][0].config.tools[0].functionDeclarations[0]
      .parametersJsonSchema,
  ).toEqual(receiptTool.inputSchema);
});

import {
  OpenAIProvider,
  ClaudeProvider,
  type Message,
} from "../packages/providers/src/index";
import { completionTool, defaultStates } from "../packages/contracts/src/index";
const finish = completionTool({
  id: "o",
  type: "outcome",
  position: { x: 0, y: 0 },
  data: { label: "Outcome", states: defaultStates() },
});
for (const kind of ["openai", "claude"] as const) {
  it(`${kind} preserves native continuation blocks and call IDs through a correction round trip`, async () => {
    const blocks =
      kind === "openai"
        ? [
            {
              type: "reasoning",
              id: "r1",
              encrypted_content: "opaque",
              summary: [],
            },
            {
              type: "function_call",
              id: "f1",
              call_id: "call-1",
              name: "finish_task",
              arguments: JSON.stringify({
                state: "success",
                reason: "ok",
                result: "done",
              }),
            },
          ]
        : [
            { type: "thinking", thinking: "opaque", signature: "signed" },
            {
              type: "tool_use",
              id: "call-1",
              name: "finish_task",
              input: { state: "success", reason: "ok", result: "done" },
            },
          ];
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            kind === "openai"
              ? { status: "completed", output: blocks }
              : { stop_reason: "tool_use", content: blocks },
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            kind === "openai"
              ? { status: "completed", output: blocks }
              : { stop_reason: "tool_use", content: blocks },
          ),
        ),
      );
    // Return a fresh Response body on every request.
    request.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            kind === "openai"
              ? { status: "completed", output: blocks }
              : { stop_reason: "tool_use", content: blocks },
          ),
        ),
    );
    const provider =
      kind === "openai"
        ? new OpenAIProvider("synthetic", request)
        : new ClaudeProvider("synthetic", request);
    const messages: Message[] = [
      { role: "user", parts: [{ text: "Synthetic task" }] },
    ];
    const response = await provider.infer(
      messages,
      receiptWorkflow.nodes[2].data,
      [finish],
      AbortSignal.timeout(2000),
    );
    expect(response.parts?.at(-1)?.functionCall?.id).toBe("call-1");
    expect(response.continuation?.blocks).toEqual(blocks);
    await provider.infer(
      [
        ...messages,
        response,
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "finish_task",
                response: { ok: false, error: "correct" },
              },
            },
          ],
        },
      ],
      receiptWorkflow.nodes[2].data,
      [finish],
      AbortSignal.timeout(2000),
    );
    const body = JSON.parse(request.mock.calls[1][1].body);
    if (kind === "openai") {
      expect(body.input).toContainEqual(blocks[0]);
      expect(body.input.at(-1)).toMatchObject({
        type: "function_call_output",
        call_id: "call-1",
      });
      expect(body.tools[0].strict).toBe(true);
    } else {
      expect(body.messages[1].content).toEqual(blocks);
      expect(body.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "call-1",
        is_error: true,
      });
    }
    expect(body.temperature).toBeUndefined();
  });
  it(`${kind} classifies transient errors, credential/capability errors, refusal and truncation`, async () => {
    for (const status of [400, 401, 429, 500]) {
      const request = vi.fn(async () => new Response("{}", { status }));
      const p =
        kind === "openai"
          ? new OpenAIProvider("synthetic", request)
          : new ClaudeProvider("synthetic", request);
      const result = p.infer(
        [],
        receiptWorkflow.nodes[2].data,
        [],
        AbortSignal.timeout(2000),
      );
      if (status >= 429)
        await expect(result).rejects.toMatchObject({ retryable: true });
      else await expect(result).rejects.toThrow(/check credential/);
    }
    const responses =
      kind === "openai"
        ? [
            { status: "incomplete", output: [] },
            {
              status: "completed",
              output: [{ type: "message", content: [{ type: "refusal" }] }],
            },
          ]
        : [
            { stop_reason: "max_tokens", content: [] },
            { stop_reason: "refusal", content: [] },
          ];
    for (const response of responses) {
      const request = vi.fn(async () => new Response(JSON.stringify(response)));
      const p =
        kind === "openai"
          ? new OpenAIProvider("synthetic", request)
          : new ClaudeProvider("synthetic", request);
      await expect(
        p.infer(
          [],
          receiptWorkflow.nodes[2].data,
          [],
          AbortSignal.timeout(2000),
        ),
      ).rejects.toThrow(/Provider/);
    }
  });
}
it("Gemini rejects truncation and refusal before returning any tool calls", async () => {
  for (const finishReason of ["MAX_TOKENS", "SAFETY"]) {
    const p = new GeminiProvider("synthetic");
    p.ai = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [
            {
              finishReason,
              content: {
                parts: [{ functionCall: { name: "finish_task", args: {} } }],
              },
            },
          ],
        }),
      },
    } as any;
    await expect(
      p.infer(
        [],
        receiptWorkflow.nodes[2].data,
        [finish],
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow(/Provider Gemini stopped/);
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "../packages/connectors/src/storage";
it("OpenAI and Claude hydrate PDF/JPEG/PNG from durable local references without checkpointing bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-attachments-"));
  const previous = process.env.ATTACHMENT_DIR;
  process.env.ATTACHMENT_DIR = directory;
  try {
    const storage = new LocalStorage();
    const files = await Promise.all([
      storage.put(
        "email",
        "pdf",
        "receipt.pdf",
        "application/pdf",
        Buffer.from("%PDF-1.4 synthetic"),
      ),
      storage.put(
        "email",
        "png",
        "receipt.png",
        "image/png",
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ),
      storage.put(
        "email",
        "jpeg",
        "receipt.jpeg",
        "image/jpeg",
        Buffer.from([255, 216, 255, 224]),
      ),
    ]);
    const messages: Message[] = [
      {
        role: "user",
        parts: files.map((f) => ({
          fileData: {
            fileUri: "local://" + f.storageKey,
            mimeType: f.mimeType,
          },
        })),
      },
    ];
    const checkpoint = JSON.stringify(messages);
    for (const kind of ["openai", "claude"] as const) {
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
                        content: [{ type: "output_text", text: "Done" }],
                      },
                    ],
                  }
                : {
                    stop_reason: "end_turn",
                    content: [{ type: "text", text: "Done" }],
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
        receiptWorkflow.nodes[2].data,
        [],
        AbortSignal.timeout(2000),
      );
      const body = JSON.parse((request.mock.calls[0] as any)[1].body);
      const content =
        kind === "openai" ? body.input[0].content : body.messages[0].content;
      expect(content.map((c: any) => c.type)).toEqual(
        kind === "openai"
          ? ["input_file", "input_image", "input_image"]
          : ["document", "image", "image"],
      );
      expect(JSON.stringify(body)).toContain(
        Buffer.from("%PDF-1.4 synthetic").toString("base64"),
      );
      expect(JSON.stringify(messages)).toBe(checkpoint);
      expect(checkpoint).not.toContain("base64");
    }
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIR;
    else process.env.ATTACHMENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
