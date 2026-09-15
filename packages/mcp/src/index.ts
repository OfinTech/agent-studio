import Ajv from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getPath,
  ConfigurationError,
  type ToolDefinition,
  type ToolResult,
} from "../../contracts/src/index";
import {
  assertToolDestination,
  boundedRequest,
  NetworkError,
} from "../../connectors/src/network";
import { redact } from "../../persistence/src/index";
const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
export function validateTool(tool: ToolDefinition) {
  try {
    validateToolConfiguration(tool);
  } catch (error) {
    if (error instanceof Error) throw new ConfigurationError(error.message);
    throw error;
  }
}
function validateToolConfiguration(tool: ToolDefinition) {
  if (tool.name === "finish_task")
    throw new Error("finish_task is a reserved completion tool name");
  assertToolDestination(tool.endpoint);
  ajv.compile(tool.inputSchema);
  if (tool.auth.type !== "none" && !tool.auth.credentialId)
    throw new Error("Tool authentication requires a credential");
  const forbidden =
    /^(host|connection|content-length|transfer-encoding|cookie|set-cookie|proxy-.*)$/i;
  if (
    forbidden.test(tool.auth.header) ||
    (tool.idempotencyHeader && forbidden.test(tool.idempotencyHeader))
  )
    throw new Error("Reserved HTTP header");
  if (
    tool.idempotencyHeader &&
    tool.idempotencyHeader.toLowerCase() ===
      (tool.auth.type === "bearer"
        ? "authorization"
        : tool.auth.header.toLowerCase())
  )
    throw new Error("Authentication and idempotency headers must differ");
  if (tool.method === "GET" && tool.mappings.some((m) => m.location === "body"))
    throw new Error("GET tools must use query mappings");
  for (const m of tool.mappings)
    if (["__proto__", "constructor", "prototype"].includes(m.target))
      throw new Error("Invalid mapping target");
}
export async function executeHttpTool(
  tool: ToolDefinition,
  args: unknown,
  idempotencyKey: string,
  credential: (id: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const validate = ajv.compile(tool.inputSchema);
  if (!validate(args))
    return {
      ok: false,
      error: "Invalid tool arguments: " + ajv.errorsText(validate.errors),
    };
  let secret = "";
  try {
    const { url, privateAllowed } = assertToolDestination(tool.endpoint);
    const body: Record<string, unknown> = Object.create(null);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    for (const m of tool.mappings) {
      const value = getPath(args, m.source);
      if (value !== undefined) {
        if (m.location === "query")
          url.searchParams.set(
            m.target,
            typeof value === "string" ? value : JSON.stringify(value),
          );
        else body[m.target] = value;
      }
    }
    if (tool.auth.type !== "none") {
      secret = await credential(tool.auth.credentialId!);
      headers[
        tool.auth.type === "bearer" ? "Authorization" : tool.auth.header
      ] = tool.auth.type === "bearer" ? `Bearer ${secret}` : secret;
    }
    if (tool.idempotencyHeader)
      headers[tool.idempotencyHeader] = idempotencyKey;
    const response = await boundedRequest(url, {
      method: tool.method,
      headers,
      body: tool.method === "GET" ? undefined : JSON.stringify(body),
      allowPrivate: privateAllowed,
      signal,
    });
    const isWrite = tool.method !== "GET";
    if (response.status >= 500 || response.status === 408) {
      return {
        ok: false,
        error: `Client API returned HTTP ${response.status}`,
        review: isWrite && !tool.idempotencyHeader,
        retryable: !isWrite || !!tool.idempotencyHeader,
      };
    }
    if (response.status === 429)
      return {
        ok: false,
        error: "Client API rate limited the request",
        retryable: !isWrite || !!tool.idempotencyHeader,
        review: isWrite && !tool.idempotencyHeader,
      };
    if (response.status < 200 || response.status >= 300)
      return {
        ok: false,
        error: `Client API returned HTTP ${response.status}`,
      };
    let data: unknown;
    try {
      data = response.body.length
        ? JSON.parse(response.body.toString())
        : { status: response.status };
    } catch {
      return {
        ok: false,
        error: "Client API returned an unreadable success response",
        review: isWrite && !tool.idempotencyHeader,
      };
    }
    return { ok: true, data: redact(data, [secret]) };
  } catch (error) {
    const write = tool.method !== "GET";
    const uncertain =
      error instanceof NetworkError &&
      error.ambiguous &&
      write &&
      !tool.idempotencyHeader;
    return {
      ok: false,
      error: uncertain
        ? "API write outcome is uncertain; review required"
        : "Tool request failed",
      review: uncertain,
      retryable: error instanceof NetworkError && error.retryable && !uncertain,
    };
  }
}
export async function createToolSession(
  definitions: ToolDefinition[],
  dispatch: (tool: ToolDefinition, args: unknown) => Promise<ToolResult>,
  onRejected?: (
    name: string,
    args: unknown,
    result: ToolResult,
  ) => Promise<void>,
  builtins: {
    definition: Pick<ToolDefinition, "name" | "description" | "inputSchema">;
    invoke: (args: unknown) => Promise<ToolResult>;
  }[] = [],
) {
  if (
    new Set(
      [...definitions, ...builtins.map((b) => b.definition)].map((t) => t.name),
    ).size !==
    definitions.length + builtins.length
  )
    throw new ConfigurationError("Duplicate built-in tool name");
  const server = new Server(
    { name: "agent-platform-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...definitions, ...builtins.map((b) => b.definition)].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.inputSchema, type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = definitions.find((t) => t.name === request.params.name);
    let result: ToolResult;
    const builtin = builtins.find(
      (b) => b.definition.name === request.params.name,
    );
    if (builtin) result = await builtin.invoke(request.params.arguments);
    else if (!tool) result = { ok: false, error: "Unknown tool" };
    else {
      const validate = ajv.compile(tool.inputSchema);
      result = validate(request.params.arguments)
        ? await dispatch(tool, request.params.arguments)
        : {
            ok: false,
            error: "Invalid tool arguments: " + ajv.errorsText(validate.errors),
          };
    }
    if (
      !builtin &&
      (!tool || result.error?.startsWith("Invalid tool arguments"))
    )
      await onRejected?.(request.params.name, request.params.arguments, result);
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
  const client = new Client({
    name: "agent-platform-worker",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const close = async () => {
    const results = await Promise.allSettled([client.close(), server.close()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    await server.connect(a);
    await client.connect(b);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    client,
    close,
  };
}
