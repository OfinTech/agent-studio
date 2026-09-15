import {
  attachedTemplates,
  pdfTemplateSchema,
  detectPlaceholders,
} from "./pdf-templates";
import { reportSources, type ReportReference } from "./reports";
import { z } from "zod";

const id = z.string().min(1).max(100);
export const toolSchema = z.object({
  id,
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  description: z.string().min(1).max(2000),
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  inputSchema: z
    .record(z.unknown())
    .refine((s) => s.type === "object", "Schema must describe an object"),
  mappings: z.array(
    z.object({
      source: z.string().regex(/^[a-zA-Z0-9_.]+$/),
      target: z.string().regex(/^[a-zA-Z0-9_]+$/),
      location: z.enum(["body", "query"]),
    }),
  ),
  auth: z.object({
    type: z.enum(["none", "bearer", "api-key"]),
    credentialId: id.optional(),
    header: z
      .string()
      .regex(/^[a-zA-Z0-9-]+$/)
      .default("X-API-Key"),
  }),
  idempotencyHeader: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
});
export type ToolDefinition = z.infer<typeof toolSchema>;
export const nodeSchema = z.object({
  id,
  type: z.enum([
    "email",
    "upload",
    "agent",
    "tool",
    "pdf_template",
    "outcome",
    "action",
    "send_email",
  ]),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    label: z.string(),
    recipient: z.string().optional(),
    mimeTypes: z
      .array(z.enum(["application/pdf", "image/jpeg", "image/png"]))
      .optional(),
    provider: z.enum(["mock", "gemini", "openai", "claude"]).optional(),
    credentialId: z.string().optional(),
    model: z.string().optional(),
    systemPrompt: z.string().max(20000).optional(),
    userPrompt: z.string().max(20000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(65536).optional(),
    toolId: z.string().optional(),
    requiredTool: z.string().optional(),
    states: z
      .array(
        z.object({
          id,
          name: z.string().trim().min(1).max(100),
          criteria: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    arguments: z.record(z.unknown()).optional(),
    pdfTemplate: pdfTemplateSchema.optional(),
    generatePdf: z.boolean().optional(),
    rendererProfile: z.string().max(100).optional(),
    reportSourceNodeId: id.optional(),
    subjectTemplate: z.string().max(1000).optional(),
    bodyTemplate: z.string().max(20000).optional(),
  }),
});
export const workflowSchema = z.object({
  name: z.string().min(1).max(100),
  nodes: z.array(nodeSchema).max(30),
  edges: z
    .array(
      z.object({
        id,
        source: id,
        target: id,
        kind: z.enum(["execution", "tool"]),
        stateId: id.optional(),
      }),
    )
    .max(50),
});
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type Email = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: Attachment[];
  messageId?: string;
};
export type EmailMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: { "In-Reply-To": string; References: string };
  attachments?: ReportReference[];
};
export type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
};
export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  review?: boolean;
  retryable?: boolean;
};
// Domain validation errors are safe to return to an authenticated editor.
export class ConfigurationError extends Error {}
export type Snapshot = { workflow: Workflow; tools: ToolDefinition[] };
export function executionOrder(workflow: Workflow): WorkflowNode[] {
  const nodes = workflow.nodes.filter(
    (n) => n.type !== "tool" && n.type !== "pdf_template",
  );
  const edges = workflow.edges.filter((e) => e.kind === "execution");
  const start = nodes.find((n) => n.type === "email");
  if (!start) return [];
  const ordered: WorkflowNode[] = [];
  let current: WorkflowNode | undefined = start;
  while (current && !ordered.some((n) => n.id === current!.id)) {
    ordered.push(current);
    const next = edges.find((e) => e.source === current!.id);
    current = nodes.find((n) => n.id === next?.target);
  }
  return ordered;
}
const executionTargets: Record<
  WorkflowNode["type"],
  readonly WorkflowNode["type"][]
> = {
  email: ["upload"],
  upload: ["agent"],
  agent: ["agent", "action", "outcome", "send_email"],
  action: ["agent", "action", "send_email"],
  outcome: ["agent", "action", "send_email"],
  tool: [],
  pdf_template: [],
  send_email: [],
};
function validExecutionTypes(
  source: WorkflowNode["type"],
  target: WorkflowNode["type"],
): boolean {
  return executionTargets[source].includes(target);
}
export function canConnect(
  workflow: Workflow,
  edge: Workflow["edges"][number],
): boolean {
  const source = workflow.nodes.find((n) => n.id === edge.source),
    target = workflow.nodes.find((n) => n.id === edge.target);
  if (!source || !target || source.id === target.id) return false;
  if (edge.kind === "tool")
    return (
      (source.type === "tool" || source.type === "pdf_template") &&
      target.type === "agent" &&
      !edge.stateId &&
      !workflow.edges.some((e) => e.kind === "tool" && e.source === source.id)
    );
  const valid = validExecutionTypes(source.type, target.type);
  if (
    !valid ||
    (source.type === "outcome"
      ? !source.data.states?.some((s) => s.id === edge.stateId)
      : !!edge.stateId)
  )
    return false;
  const path = workflow.edges.filter((e) => e.kind === "execution");
  if (
    path.some(
      (e) =>
        e.target === target.id ||
        (e.source === source.id &&
          (source.type !== "outcome" || e.stateId === edge.stateId)),
    )
  )
    return false;
  const seen = new Set<string>();
  function reaches(id: string): boolean {
    if (id === source!.id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return path.filter((e) => e.source === id).some((e) => reaches(e.target));
  }
  return !reaches(target.id);
}

export function earlierOutputReferences(
  workflow: Workflow,
  nodeId: string,
): string[] {
  const seen = new Set<string>();
  const references: string[] = [];
  let current = nodeId;
  while (!seen.has(current)) {
    seen.add(current);
    const edge = workflow.edges.find(
      (e) => e.kind === "execution" && e.target === current,
    );
    const node = workflow.nodes.find((n) => n.id === edge?.source);
    if (!node) break;
    if (node.type === "agent")
      references.push(
        `steps.${node.id}.text`,
        ...(connectedOutcome(workflow, node.id)
          ? ["state", "name", "reason", "result"].map(
              (field) => `steps.${node.id}.outcome.${field}`,
            )
          : []),
      );
    if (node.type === "action") references.push(`steps.${node.id}.data`);
    current = node.id;
  }
  return references;
}
export function connectedOutcome(workflow: Workflow, agentId: string) {
  const edge = workflow.edges.find(
    (e) => e.kind === "execution" && e.source === agentId,
  );
  return workflow.nodes.find(
    (n) => n.id === edge?.target && n.type === "outcome",
  );
}
export function defaultStates() {
  return [
    {
      id: "success",
      name: "Success",
      criteria: "The task was completed successfully.",
    },
    {
      id: "failure",
      name: "Failure",
      criteria: "The task could not be completed.",
    },
  ];
}
export function completionInstructions(outcome: WorkflowNode): string {
  return (
    "When the task is complete, call finish_task exactly once, alone without other tool calls. All fields are required: state (stable ID), reason (string), result (string). Select the state whose criteria match the task result. Ordinary text does not complete the task.\n" +
    (outcome.data.states ?? [])
      .map((s) => `${s.id}: ${s.name} — ${s.criteria}`)
      .join("\n")
  );
}
export function completionTool(outcome: WorkflowNode) {
  return {
    name: "finish_task",
    description: "Report the final task outcome and finish this agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["state", "reason", "result"],
      properties: {
        state: {
          type: "string",
          enum: outcome.data.states?.map((s) => s.id) ?? [],
        },
        reason: { type: "string" },
        result: { type: "string" },
      },
    },
  };
}
export function parseCompletion(args: unknown, outcome: WorkflowNode) {
  const report = z
    .object({ state: z.string(), reason: z.string(), result: z.string() })
    .strict()
    .parse(args);
  const state = outcome.data.states?.find((s) => s.id === report.state);
  if (!state) throw new Error("Unknown outcome state");
  return { ...report, name: state.name };
}
export function addOutcome(
  workflow: Workflow,
  agentId: string,
  outcomeId: string,
): Workflow {
  const agent = workflow.nodes.find(
    (n) => n.id === agentId && n.type === "agent",
  );
  if (!agent || connectedOutcome(workflow, agentId))
    throw new Error("Choose an agent without an Outcome block.");
  const successor = workflow.edges.find(
    (e) => e.kind === "execution" && e.source === agentId,
  );
  return {
    ...workflow,
    nodes: [
      ...workflow.nodes.map((n) =>
        n.position.x >= agent.position.x + 300
          ? { ...n, position: { ...n.position, x: n.position.x + 320 } }
          : n,
      ),
      {
        id: outcomeId,
        type: "outcome",
        position: { x: agent.position.x + 320, y: agent.position.y },
        data: { label: "Outcome", states: defaultStates() },
      },
    ],
    edges: [
      ...workflow.edges.filter((e) => e !== successor),
      {
        id: outcomeId + "-in",
        source: agentId,
        target: outcomeId,
        kind: "execution",
      },
      ...(successor
        ? [{ ...successor, source: outcomeId, stateId: "success" }]
        : []),
    ],
  };
}
export function updateOutcomeStates(
  workflow: Workflow,
  nodeId: string,
  states: NonNullable<WorkflowNode["data"]["states"]>,
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, states } } : n,
    ),
    edges: workflow.edges.filter(
      (e) => e.source !== nodeId || states.some((s) => s.id === e.stateId),
    ),
  };
}
export function resolveArguments(
  value: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{([\w. -]+)\}\}$/.exec(value);
    if (whole) {
      const resolved = getPath(context, whole[1].trim());
      if (resolved === undefined)
        throw new Error(`Unknown prompt variable: ${whole[1].trim()}`);
      return resolved;
    }
    return renderPrompt(value, context);
  }
  if (Array.isArray(value))
    return value.map((v) => resolveArguments(v, context));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveArguments(v, context)]),
    );
  return value;
}
export function validateWorkflow(
  workflow: Workflow,
  tools: ToolDefinition[],
): string[] {
  const errors: string[] = [];
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  const path = workflow.edges.filter((e) => e.kind === "execution");
  if (nodes.size !== workflow.nodes.length)
    errors.push("Node IDs must be unique.");
  if (new Set(workflow.edges.map((e) => e.id)).size !== workflow.edges.length)
    errors.push("Connection IDs must be unique.");
  for (const type of ["email", "upload"])
    if (workflow.nodes.filter((n) => n.type === type).length !== 1)
      errors.push(`Add exactly one ${type} node.`);
  if (!workflow.nodes.some((n) => n.type === "agent"))
    errors.push("Add at least one agent node.");
  for (const e of workflow.edges) {
    const s = nodes.get(e.source),
      t = nodes.get(e.target);
    if (!s || !t || s.id === t.id) {
      errors.push("Connections must join distinct existing nodes.");
      continue;
    }
    if (e.kind === "tool") {
      if (
        (s.type !== "tool" && s.type !== "pdf_template") ||
        t.type !== "agent" ||
        e.stateId
      )
        errors.push("Tool connections must connect a tool to the agent.");
    } else {
      const valid = validExecutionTypes(s.type, t.type);
      if (!valid) errors.push("Invalid execution connection.");
      if (
        s.type === "outcome"
          ? !s.data.states?.some((state) => state.id === e.stateId)
          : !!e.stateId
      )
        errors.push("Outcome connections require a valid stable state ID.");
    }
  }
  for (const n of workflow.nodes) {
    const outgoing = path.filter((e) => e.source === n.id),
      incoming = path.filter((e) => e.target === n.id);
    if (incoming.length > 1) errors.push("Branch joins are not supported.");
    if (n.type !== "outcome" && outgoing.length > 1)
      errors.push("Branching requires an Outcome block.");
    if (n.type === "outcome") {
      const states = n.data.states ?? [];
      if (
        !states.length ||
        states.some((s) => !s.id || !s.name.trim() || !s.criteria.trim()) ||
        new Set(states.map((s) => s.id)).size !== states.length ||
        new Set(states.map((s) => s.name.trim().toLowerCase())).size !==
          states.length
      )
        errors.push(
          "Outcome states need unique IDs and names and nonempty criteria.",
        );
      if (
        incoming.length !== 1 ||
        nodes.get(incoming[0]?.source)?.type !== "agent"
      )
        errors.push("Connect each Outcome directly after one agent.");
      if (new Set(outgoing.map((e) => e.stateId)).size !== outgoing.length)
        errors.push("Each state supports one connection.");
    }
    if (
      n.type === "email" &&
      !z.string().email().safeParse(n.data.recipient).success
    )
      errors.push("Set a valid receiving address.");
    if (n.type === "upload" && !n.data.mimeTypes?.length)
      errors.push("Select at least one attachment type.");
    if (n.type === "agent") {
      if (
        !n.data.provider ||
        !n.data.model ||
        !n.data.systemPrompt ||
        !n.data.userPrompt
      )
        errors.push("Configure model and prompts.");
      if (n.data.provider !== "mock" && !n.data.credentialId)
        errors.push("Choose a provider credential.");
      const attachedIds = workflow.edges
        .filter((e) => e.kind === "tool" && e.target === n.id)
        .map((e) => nodes.get(e.source)?.data.toolId);
      const attached = tools.filter((t) => attachedIds.includes(t.id));
      if (n.data.generatePdf && attached.some((t) => t.name === "generate_pdf"))
        errors.push(
          "generate_pdf conflicts with the built-in PDF report tool.",
        );
      const names = [
        ...attached.map((t) => t.name),
        ...attachedTemplates(workflow, n.id).map(
          (t) => t.data.pdfTemplate?.toolName,
        ),
        ...(n.data.generatePdf ? ["generate_pdf"] : []),
        "finish_task",
      ];
      if (new Set(names).size !== names.length)
        errors.push("Attached tool names must be unique.");
      if (
        !connectedOutcome(workflow, n.id) &&
        n.data.requiredTool &&
        !attached.some((t) => t.name === n.data.requiredTool) &&
        !attachedTemplates(workflow, n.id).some(
          (t) => t.data.pdfTemplate?.toolName === n.data.requiredTool,
        ) &&
        !(n.data.generatePdf && n.data.requiredTool === "generate_pdf")
      )
        errors.push("Required success tool must be attached to the agent.");
    }
    if (
      ["tool", "action"].includes(n.type) &&
      !tools.some((t) => t.id === n.data.toolId)
    )
      errors.push("Select an existing tool.");
    if (
      (n.type === "tool" || n.type === "pdf_template") &&
      workflow.edges.filter((e) => e.kind === "tool" && e.source === n.id)
        .length !== 1
    )
      errors.push("Select an existing tool and connect it to the agent.");
    if (n.type === "pdf_template") {
      const template = n.data.pdfTemplate;
      if (!template?.source.trim())
        errors.push("Configure a nonempty PDF template.");
      else {
        try {
          detectPlaceholders(template.source);
        } catch (error) {
          errors.push((error as Error).message);
        }
      }
    }
    if (n.type === "send_email" && !n.data.bodyTemplate?.trim())
      errors.push("Configure a nonempty email body template.");
    if (n.type === "action" && !n.data.arguments)
      errors.push("Configure tool action arguments as a JSON object.");
  }
  if (tools.some((t) => t.name === "finish_task"))
    errors.push("finish_task is a reserved completion tool name.");
  const visited = new Set<string>();
  const email = {
    id: "email",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    subject: "Receipt",
    text: "Untrusted content",
    attachments: [],
  };
  function visit(
    nodeId: string,
    ancestors: string[],
    outputs: Record<string, unknown>,
  ) {
    if (ancestors.includes(nodeId)) {
      errors.push("Cycles are not supported.");
      return;
    }
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) return;
    // Validate availability by ancestry, allowing dynamic action result fields.
    const check = (value: unknown) => {
      const strings: string[] = [];
      const collect = (v: unknown) => {
        if (typeof v === "string") strings.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(collect);
      };
      collect(value);
      for (const text of strings)
        for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
          const ref = match[1].trim(),
            bits = ref.split(".");
          if (
            !/^[\w.-]+$/.test(ref) ||
            bits.some((b) =>
              ["__proto__", "prototype", "constructor"].includes(b),
            ) ||
            (bits[0] === "email"
              ? getPath({ email }, ref) === undefined
              : bits[0] !== "steps" ||
                !Object.hasOwn(outputs, bits[1]) ||
                (!(
                  nodes.get(bits[1])?.type === "action" &&
                  bits[2] === "data" &&
                  bits.slice(3).every(Boolean)
                ) &&
                  getPath({ steps: outputs }, ref) === undefined))
          )
            errors.push(
              `Configure prompt variables: Unknown prompt variable: ${ref}`,
            );
        }
    };
    if (node.type === "agent") {
      check(node.data.userPrompt);
      check(node.data.systemPrompt);
    }
    if (node.type === "action") check(node.data.arguments);
    if (node.type === "send_email") {
      if (
        node.data.reportSourceNodeId &&
        !reportSources(workflow, node.id).some(
          (n) => n.id === node.data.reportSourceNodeId,
        )
      )
        errors.push(
          "Select a PDF-enabled ancestor Agent for the email attachment.",
        );
      for (const template of [
        node.data.subjectTemplate ?? "",
        node.data.bodyTemplate ?? "",
      ]) {
        check(template);
        if (/[{}]{2}/.test(template.replace(/\{\{[^{}]*\}\}/g, "")))
          errors.push("Configure valid email template references.");
      }
      if (hasHeaderControls(node.data.subjectTemplate ?? ""))
        errors.push("Configure an email subject without control characters.");
    }
    const output =
      node.type === "email"
        ? email
        : node.type === "upload"
          ? { count: 1, files: [] }
          : node.type === "agent"
            ? {
                text: "",
                turns: 1,
                ...(connectedOutcome(workflow, node.id)
                  ? { outcome: { state: "", name: "", reason: "", result: "" } }
                  : {}),
              }
            : node.type === "action"
              ? { ok: true, data: {} }
              : {};
    for (const e of path.filter((e) => e.source === nodeId))
      visit(e.target, [...ancestors, nodeId], { ...outputs, [nodeId]: output });
  }
  const start = workflow.nodes.find((n) => n.type === "email");
  if (start) visit(start.id, [], {});
  if (
    workflow.nodes.some(
      (n) =>
        n.type !== "tool" && n.type !== "pdf_template" && !visited.has(n.id),
    )
  )
    errors.push("All execution nodes must be reachable from Email.");
  return [...new Set(errors)];
}
export function hasHeaderControls(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
export function getPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (obj, key) =>
        key === "__proto__" || key === "constructor" || key === "prototype"
          ? undefined
          : obj !== null && typeof obj === "object" && Object.hasOwn(obj, key)
            ? (obj as Record<string, unknown>)[key]
            : undefined,
      value,
    );
}
export function renderPrompt(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_, expression: string) => {
    const path = expression.trim();
    if (!/^[\w.-]+$/.test(path))
      throw new Error(`Unknown prompt variable: ${path}`);
    const value = getPath(context, path);
    if (value === undefined)
      throw new Error(`Unknown prompt variable: ${path}`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
