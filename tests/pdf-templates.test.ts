import { receiptWorkflow, receiptTool } from "../fixtures/receipt-workflow";
import { it, expect } from "vitest";
import {
  GeminiProvider,
  OpenAIProvider,
  ClaudeProvider,
} from "../packages/providers/src/index";
import { createToolSession } from "../packages/mcp/src/index";
import sharp from "sharp";
import {
  defaultPdfTemplate,
  detectPlaceholders,
  renderTemplate,
  templateTool,
  imageResourcesSchema,
  TEMPLATE_PROFILE,
} from "../packages/contracts/src/pdf-templates";
import { validateWorkflow, canConnect } from "../packages/contracts/src/index";
import {
  validateImage,
  compilationFilename,
} from "../packages/connectors/src/template-resources";

for (const providerName of ["gemini", "openai", "claude"] as const) {
  it.each([
    [{ title: "Title", assessment: String.raw`\section{Raw} <<title>>` }, true],
    [{ title: "", assessment: "" }, true],
    [{ title: "Missing assessment" }, false],
    [{ title: "Title", assessment: "", extra: "Unexpected" }, false],
  ])(
    `${providerName} normalizes template calls and enforces required MCP arguments: %j`,
    async (args, ok) => {
      const definition = templateTool(defaultPdfTemplate);
      const provider =
        providerName === "gemini"
          ? new GeminiProvider("synthetic")
          : providerName === "openai"
            ? new OpenAIProvider(
                "synthetic",
                async () =>
                  new Response(
                    JSON.stringify({
                      status: "completed",
                      output: [
                        {
                          type: "function_call",
                          call_id: "template-call",
                          name: definition.name,
                          arguments: JSON.stringify(args),
                        },
                      ],
                    }),
                  ),
              )
            : new ClaudeProvider(
                "synthetic",
                async () =>
                  new Response(
                    JSON.stringify({
                      stop_reason: "tool_use",
                      content: [
                        {
                          type: "tool_use",
                          id: "template-call",
                          name: definition.name,
                          input: args,
                        },
                      ],
                    }),
                  ),
              );
      if (provider instanceof GeminiProvider)
        provider.ai = {
          models: {
            generateContent: async () => ({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ functionCall: { name: definition.name, args } }],
                  },
                },
              ],
            }),
          },
        } as any;
      const message = await provider.infer(
        [{ role: "user", parts: [{ text: "Synthetic template check" }] }],
        receiptWorkflow.nodes[2].data,
        [definition],
        AbortSignal.timeout(2000),
      );
      const call = message.parts!.find((p) => p.functionCall)!.functionCall!;
      const session = await createToolSession(
        [],
        async () => {
          throw new Error("Unexpected HTTP dispatch");
        },
        undefined,
        [
          {
            definition,
            invoke: async (input) => {
              try {
                return {
                  ok: true,
                  data: renderTemplate(defaultPdfTemplate, input),
                };
              } catch (error) {
                return { ok: false, error: (error as Error).message };
              }
            },
          },
        ],
      );
      try {
        const result = await session.client.callTool({
          name: call.name!,
          arguments: call.args,
        });
        expect(result.structuredContent).toMatchObject({ ok });
        if (ok)
          expect(result.structuredContent).toMatchObject({
            data: renderTemplate(defaultPdfTemplate, args),
          });
      } finally {
        await session.close();
      }
    },
  );
}

it("detects distinct identifiers and inserts raw LaTeX once, including empty strings and prototype-like names", () => {
  const template = {
    ...defaultPdfTemplate,
    source: "<<title>> <<assessment>> <<title>> {{email.text}} <<__proto__>>",
  };
  expect(detectPlaceholders(template.source)).toEqual([
    "title",
    "assessment",
    "__proto__",
  ]);
  expect(
    renderTemplate(
      template,
      JSON.parse(
        '{"title":"<<assessment>>","assessment":"","__proto__":"raw"}',
      ),
    ),
  ).toBe("<<assessment>>  <<assessment>> {{email.text}} raw");
  expect(
    renderTemplate(
      { ...template, source: "<<assessment>>" },
      { assessment: String.raw`\section{Raw} $x_1$ & 100\%` },
    ),
  ).toBe(String.raw`\section{Raw} $x_1$ & 100\%`);
  for (const source of [
    "<<not valid>>",
    "<<9name>>",
    "<<title",
    "title>>",
    "<<>>",
  ])
    expect(() => detectPlaceholders(source)).toThrow();
  expect(renderTemplate({ ...template, source: "Fixed" }, {})).toBe("Fixed");
  for (const args of [
    null,
    [],
    { title: "x" },
    { title: "", assessment: "", extra: "" },
    { title: 1, assessment: "" },
  ])
    expect(() => renderTemplate(defaultPdfTemplate, args)).toThrow(
      "required template parameters",
    );
  expect(templateTool(defaultPdfTemplate).inputSchema).toMatchObject({
    required: ["title", "assessment"],
    additionalProperties: false,
  });
});

it("uses tool edges and checks all attached names including builtins", () => {
  const workflow = structuredClone(receiptWorkflow);
  workflow.nodes.push({
    id: "template",
    type: "pdf_template",
    position: { x: 0, y: 0 },
    data: {
      label: "Template",
      pdfTemplate: structuredClone(defaultPdfTemplate),
      rendererProfile: TEMPLATE_PROFILE,
    },
  });
  const edge = {
    id: "template-edge",
    source: "template",
    target: "agent",
    kind: "tool" as const,
  };
  expect(canConnect(workflow, edge)).toBe(true);
  expect(canConnect(workflow, { ...edge, kind: "execution" })).toBe(false);
  workflow.edges.push(edge);
  expect(canConnect(workflow, edge)).toBe(false);
  expect(validateWorkflow(workflow, [receiptTool])).toEqual([]);
  for (const name of ["finish_task", receiptTool.name, "generate_pdf"]) {
    workflow.nodes[2].data.generatePdf = true;
    workflow.nodes.at(-1)!.data.pdfTemplate!.toolName = name;
    expect(validateWorkflow(workflow, [receiptTool])).toContain(
      "Attached tool names must be unique.",
    );
  }
});

it("decodes actual PNG/JPEG pixels and rejects corrupt, unsupported and excessive resources", async () => {
  for (const format of ["png", "jpeg"] as const) {
    const bytes = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "blue" },
    })
      .toFormat(format)
      .toBuffer();
    expect(await validateImage(bytes)).toBe(`image/${format}`);
    await expect(validateImage(bytes.subarray(0, 40))).rejects.toThrow();
  }
  for (const bytes of [
    Buffer.from("%PDF-1.4"),
    Buffer.from("<svg/>"),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  ])
    await expect(validateImage(bytes)).rejects.toThrow();
  expect(compilationFilename("Company logo.JPEG", "image/jpeg")).toBe(
    "Company_logo.jpg",
  );
  for (const name of [
    "../logo.png",
    "/logo.png",
    "folder/logo.png",
    "folder\\logo.png",
  ])
    expect(() => compilationFilename(name, "image/png")).toThrow();
  const image = {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "logo.png",
    mimeType: "image/png",
    checksum: "a".repeat(64),
    size: 5 * 1024 * 1024,
  };
  expect(imageResourcesSchema.safeParse([image, image]).success).toBe(false);
  expect(
    imageResourcesSchema.safeParse(
      Array.from({ length: 5 }, (_, i) => ({
        ...image,
        filename: `logo${i}.png`,
      })),
    ).success,
  ).toBe(false);
  expect(
    imageResourcesSchema.safeParse(
      Array.from({ length: 11 }, (_, i) => ({
        ...image,
        size: 1,
        filename: `logo${i}.png`,
      })),
    ).success,
  ).toBe(false);
});
