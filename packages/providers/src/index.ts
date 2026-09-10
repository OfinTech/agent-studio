import { GoogleGenAI } from "@google/genai";
import {
  getPath,
  type ToolDefinition,
  type WorkflowNode,
} from "../../contracts/src/index";
import { NetworkError } from "../../connectors/src/network";
export type ProviderFile = { name: string; uri: string; mimeType: string };
// Provider-neutral wire parts retain the legacy serialized shape for checkpoint decoding.
export type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  fileData?: { fileUri?: string; mimeType?: string };
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: Record<string, unknown>;
  };
};
// Normalized calls/results with opaque provider continuation blocks retained verbatim.
export type Message = {
  role?: string;
  parts?: Part[];
  continuation?: {
    provider: "openai" | "claude";
    blocks: Record<string, unknown>[];
  };
  termination?: string;
};
export interface Provider {
  localAttachments?: boolean;
  upload(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    onCreated: (name: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<ProviderFile>;
  remove(name: string): Promise<void>;
  infer(
    messages: Message[],
    config: WorkflowNode["data"],
    tools: Pick<ToolDefinition, "name" | "description" | "inputSchema">[],
    signal: AbortSignal,
  ): Promise<Message>;
}
export class GeminiProvider implements Provider {
  ai: GoogleGenAI;
  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60000 } });
  }
  async upload(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    onCreated: (name: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    try {
      let file = await this.ai.files.upload({
        file: new Blob([new Uint8Array(bytes)], { type: mimeType }),
        config: {
          displayName: filename,
          mimeType,
          abortSignal: signal,
          httpOptions: { timeout: 60000 },
        },
      });
      if (!file.name) throw new Error("Provider did not return a file name");
      await onCreated(file.name);
      while (file.state === "PROCESSING") {
        signal.throwIfAborted();
        await new Promise((r) => setTimeout(r, 1000));
        file = await this.ai.files.get({
          name: file.name!,
          config: { abortSignal: signal, httpOptions: { timeout: 15000 } },
        });
      }
      if (file.state !== "ACTIVE" || !file.uri)
        throw new Error("Provider attachment processing failed");
      return { name: file.name!, uri: file.uri, mimeType };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429 || (status && status >= 500))
        throw new NetworkError(
          "Gemini file service temporarily unavailable",
          false,
          true,
        );
      throw error;
    }
  }
  async remove(name: string) {
    try {
      await this.ai.files.delete({ name });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  async infer(
    messages: Message[],
    config: WorkflowNode["data"],
    tools: Pick<ToolDefinition, "name" | "description" | "inputSchema">[],
    signal: AbortSignal,
  ): Promise<Message> {
    try {
      const response = await this.ai.models.generateContent({
        model: config.model!,
        contents: messages,
        config: {
          systemInstruction: config.systemPrompt,
          temperature: config.temperature ?? 0.1,
          maxOutputTokens: config.maxOutputTokens ?? 4096,
          tools: tools.length
            ? [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.inputSchema,
                  })),
                },
              ]
            : undefined,
          abortSignal: signal,
          httpOptions: { timeout: 60000 },
        },
      });
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== "STOP")
        throw new Error("Provider Gemini stopped: " + candidate.finishReason);
      const content = candidate?.content;
      if (!content?.parts?.length)
        throw new Error("Gemini returned no usable content");
      return content;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429 || (status && status >= 500))
        throw new NetworkError("Gemini temporarily unavailable", false, true);
      if (error instanceof Error && error.message.startsWith("Provider "))
        throw error;
      throw new Error(
        "Provider Gemini inference failed; check model capabilities and credentials",
      );
    }
  }
}
export class MockProvider implements Provider {
  async upload(
    _bytes: Buffer,
    mimeType: string,
    filename: string,
    onCreated: (name: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const name = "mock/" + filename;
    await onCreated(name);
    return { name, uri: "mock://" + filename, mimeType };
  }
  async remove(_name: string) {}
  async infer(
    messages: Message[],
    _config: WorkflowNode["data"],
    tools: Pick<ToolDefinition, "name" | "description" | "inputSchema">[],
    signal: AbortSignal,
  ): Promise<Message> {
    signal.throwIfAborted();
    const finish = tools.find((t) => t.name === "finish_task");
    if (finish)
      return {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "mock-finish",
              name: "finish_task",
              args: {
                state: getPath(finish.inputSchema, "properties.state.enum.0"),
                reason: "Synthetic task completed",
                result: "Synthetic result",
              },
            },
          },
        ],
      };
    if (messages.some((m) => m.parts?.some((p) => p.functionResponse)))
      return {
        role: "model",
        parts: [{ text: "Receipt submitted successfully." }],
      };
    const text = messages
      .flatMap((m) => m.parts ?? [])
      .map((p) => p.text ?? "")
      .join("\n");
    const field = (name: string) =>
      new RegExp(name + ": ([^\\n]+)").exec(text)?.[1];
    if (!tools.length)
      return { role: "model", parts: [{ text: "No tools configured." }] };
    return {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "mock-receipt",
            name: tools[0].name,
            args: {
              merchant: field("Merchant") ?? "Paper & Pine",
              date: field("Date") ?? "2026-09-09",
              currency: field("Currency") ?? "USD",
              total: Number(field("Total") ?? 42.5),
              tax: Number(field("Tax") ?? 2.5),
            },
          },
        },
      ],
    };
  }
}
export function fileParts(files: ProviderFile[]): Part[] {
  return files.map((file) => ({
    fileData: { fileUri: file.uri, mimeType: file.mimeType },
  }));
}

type Declaration = Pick<ToolDefinition, "name" | "description" | "inputSchema">;
// Local attachment URIs are durable references; bytes exist only in the request.
async function inlineFile(uri: string) {
  if (!uri.startsWith("local://"))
    throw new Error("Provider requires a local attachment reference");
  const { LocalStorage } = await import("../../connectors/src/storage");
  return (await new LocalStorage().read(uri.slice(8))).toString("base64");
}
abstract class InlineProvider implements Provider {
  localAttachments = true;
  constructor(
    protected apiKey: string,
    protected request: typeof fetch = fetch,
  ) {}
  async upload(): Promise<ProviderFile> {
    throw new Error("Provider uses local attachment references");
  }
  async remove() {}
  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ) {
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new NetworkError("Provider temporarily unavailable", false, true);
    }
    if (response.status === 429 || response.status >= 500)
      throw new NetworkError("Provider temporarily unavailable", false, true);
    if (!response.ok)
      throw new Error(
        `Provider rejected request (HTTP ${response.status}); check credential, model ID, attachment and tool capabilities`,
      );
    return response.json();
  }
  abstract infer(
    messages: Message[],
    config: WorkflowNode["data"],
    tools: Declaration[],
    signal: AbortSignal,
  ): Promise<Message>;
}
export class OpenAIProvider extends InlineProvider {
  async infer(
    messages: Message[],
    config: WorkflowNode["data"],
    tools: Declaration[],
    signal: AbortSignal,
  ): Promise<Message> {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.continuation?.provider === "openai") {
        input.push(...message.continuation.blocks);
        continue;
      }
      const content: Record<string, unknown>[] = [];
      for (const part of message.parts ?? []) {
        if (part.functionResponse) {
          const r = part.functionResponse;
          input.push({
            type: "function_call_output",
            call_id: r.id,
            output: JSON.stringify(r.response),
          });
        } else if (part.text)
          content.push({ type: "input_text", text: part.text });
        else if (part.fileData) {
          const f = part.fileData,
            data = await inlineFile(f.fileUri!);
          content.push(
            f.mimeType === "application/pdf"
              ? {
                  type: "input_file",
                  filename: "attachment.pdf",
                  file_data: `data:${f.mimeType};base64,${data}`,
                }
              : {
                  type: "input_image",
                  image_url: `data:${f.mimeType};base64,${data}`,
                },
          );
        }
      }
      if (content.length) input.push({ role: "user", content });
    }
    const response = await this.post(
      "https://api.openai.com/v1/responses",
      { Authorization: "Bearer " + this.apiKey },
      {
        model: config.model,
        instructions: config.systemPrompt,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: config.maxOutputTokens ?? 4096,
        // Temperature support is model dependent; omit it for Responses.
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          strict: t.name === "finish_task",
        })),
      },
      signal,
    );
    if (response.status !== "completed")
      throw new Error(
        "Provider OpenAI response did not complete: " + String(response.status),
      );
    const blocks: any[] = response.output ?? [];
    if (blocks.some((b) => b.content?.some((c: any) => c.type === "refusal")))
      throw new Error("Provider OpenAI refused the task");
    const parts: Part[] = [];
    for (const block of blocks) {
      if (block.type === "function_call") {
        let args;
        try {
          args = JSON.parse(block.arguments);
        } catch {
          args = undefined;
        }
        parts.push({
          functionCall: { id: block.call_id, name: block.name, args },
        });
      }
      if (block.type === "message")
        for (const c of block.content ?? [])
          if (c.type === "output_text") parts.push({ text: c.text });
    }
    if (!parts.length)
      throw new Error("Provider OpenAI returned no usable content");
    return {
      role: "model",
      parts,
      continuation: { provider: "openai", blocks },
      termination: response.status,
    };
  }
}
export class ClaudeProvider extends InlineProvider {
  async infer(
    messages: Message[],
    config: WorkflowNode["data"],
    tools: Declaration[],
    signal: AbortSignal,
  ): Promise<Message> {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.continuation?.provider === "claude") {
        input.push({ role: "assistant", content: message.continuation.blocks });
        continue;
      }
      const content: Record<string, unknown>[] = [];
      for (const part of message.parts ?? []) {
        if (part.functionResponse) {
          const r = part.functionResponse;
          content.push({
            type: "tool_result",
            tool_use_id: r.id,
            content: JSON.stringify(r.response),
            is_error: r.response?.ok === false,
          });
        } else if (part.text) content.push({ type: "text", text: part.text });
        else if (part.fileData) {
          const f = part.fileData;
          content.push({
            type: f.mimeType === "application/pdf" ? "document" : "image",
            source: {
              type: "base64",
              media_type: f.mimeType,
              data: await inlineFile(f.fileUri!),
            },
          });
        }
      }
      if (content.length) input.push({ role: "user", content });
    }
    const response = await this.post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: config.model,
        system: config.systemPrompt,
        messages: input,
        max_tokens: config.maxOutputTokens ?? 4096,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          ...(t.name === "finish_task" ? { strict: true } : {}),
        })),
      },
      signal,
    );
    if (!["end_turn", "tool_use"].includes(response.stop_reason))
      throw new Error(
        "Provider Claude stopped: " + String(response.stop_reason),
      );
    const blocks: any[] = response.content ?? [];
    const parts: Part[] = blocks.flatMap<Part>((b) =>
      b.type === "text"
        ? [{ text: b.text }]
        : b.type === "tool_use"
          ? [{ functionCall: { id: b.id, name: b.name, args: b.input } }]
          : [],
    );
    if (!parts.length)
      throw new Error("Provider Claude returned no usable content");
    return {
      role: "model",
      parts,
      continuation: { provider: "claude", blocks },
      termination: response.stop_reason,
    };
  }
}
