import { createHash } from "node:crypto";
import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { query, resolveCredential, redact } from "../../persistence/src/index";
import {
  type ToolDefinition,
  type ToolResult,
  type WorkflowNode,
} from "../../contracts/src/index";
import { createToolSession, executeHttpTool } from "../../mcp/src/index";
import { ReviewError, RetryError } from "./run-lifecycle";
const toolArguments = z.record(z.unknown());
const toolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  review: z.boolean().optional(),
  retryable: z.boolean().optional(),
});
type ToolCallRecord = { status: string; args: unknown; result: ToolResult };
export type ToolDispatch = (
  tool: ToolDefinition,
  args: unknown,
  key: string,
) => Promise<ToolResult>;
export async function durableToolSession({
  runId,
  node,
  nodeTools,
  legacyCalls,
  signal,
  dispatch,
}: {
  runId: string;
  node: WorkflowNode;
  nodeTools: ToolDefinition[];
  legacyCalls?: boolean;
  signal: AbortSignal;
  dispatch?: ToolDispatch;
}) {
  const json = JSON.stringify;
  let currentCall = "";
  const session = await createToolSession(
    nodeTools,
    async (tool, args) => {
      signal.throwIfAborted();
      const [existing] = await query<ToolCallRecord>(
        "SELECT * FROM tool_calls WHERE id=$1",
        [currentCall],
      );
      if (existing?.status === "succeeded" || existing?.status === "failed")
        return existing.result as ToolResult;
      if (
        existing?.status === "needs_review" ||
        (existing?.status === "running" &&
          tool.method !== "GET" &&
          !tool.idempotencyHeader)
      ) {
        await query("UPDATE tool_calls SET status='needs_review' WHERE id=$1", [
          currentCall,
        ]);
        return {
          ok: false,
          review: true,
          error: "A previous API write may have completed; review required",
        };
      }
      // A repeated identical call, or second submission after required success, never repeats a write.
      const previous = await query<ToolCallRecord>(
        "SELECT args,result FROM tool_calls WHERE run_id=$1 AND name=$2 AND (node_id=$3 OR (node_id IS NULL AND $4)) AND status='succeeded' ORDER BY created_at",
        [runId, tool.name, node.id, !!legacyCalls],
      );
      const same = previous.find((p) => json(p.args) === json(args));
      if (same) return same.result;
      if (tool.name === node.data.requiredTool && previous.length)
        return {
          ok: false,
          error: "This run has already submitted its receipt",
        };
      await query(
        "INSERT INTO tool_calls(id,run_id,name,args,node_id,status) VALUES($1,$2,$3,$4,$5,'running') ON CONFLICT(id) DO UPDATE SET status='running'",
        [currentCall, runId, tool.name, json(redact(args)), node.id],
      );
      const result = await (
        dispatch ??
        ((t, a, k) =>
          executeHttpTool(
            t,
            a,
            k,
            (id) => resolveCredential(id, "api"),
            signal,
          ))
      )(tool, args, createHash("sha256").update(currentCall).digest("hex"));
      await query("UPDATE tool_calls SET status=$2,result=$3 WHERE id=$1", [
        currentCall,
        result.review
          ? "needs_review"
          : result.ok
            ? "succeeded"
            : result.retryable
              ? "retryable"
              : "failed",
        json(result),
      ]);
      return result;
    },
    async (name, args, result) => {
      await query(
        "INSERT INTO tool_calls(id,run_id,name,args,status,result,node_id) VALUES($1,$2,$3,$4,'failed',$5,$6) ON CONFLICT(id) DO NOTHING",
        [
          currentCall,
          runId,
          name,
          json(redact(args ?? {})),
          json(result),
          node.id,
        ],
      );
    },
  );

  const invoke = async (
    name: string,
    args: unknown,
    callId: string,
  ): Promise<ToolResult> => {
    currentCall = callId;
    const result = CallToolResultSchema.parse(
      await session.client.callTool({
        name,
        arguments: toolArguments.parse(args),
      }),
    );
    const text = result.content?.find((part) => part.type === "text");
    let structured: ToolResult;
    try {
      structured = toolResultSchema.parse(
        result.structuredContent ??
          (text?.type === "text" ? JSON.parse(text.text) : undefined),
      );
    } catch {
      structured = { ok: false, error: "MCP tool execution failed" };
    }
    const [ledger] = await query("SELECT status FROM tool_calls WHERE id=$1", [
      currentCall,
    ]);
    if (
      structured.review ||
      ["needs_review", "running"].includes(ledger?.status)
    )
      throw new ReviewError("API write outcome requires review");
    if (structured.retryable || ledger?.status === "retryable")
      throw new RetryError("Transient tool failure");
    return structured;
  };
  return { invoke, close: session.close };
}
