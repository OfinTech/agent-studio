import type {
  Workflow,
  ToolDefinition,
} from "../../../packages/contracts/src/index";
export type Credential = {
  id: string;
  name: string;
  kind: "gemini" | "openai" | "claude" | "api";
};
export type WorkflowRecord = {
  id: string;
  draft: Workflow;
  published_version: string | null;
  number: number | null;
};
export type Run = {
  id: string;
  status: string;
  number: number;
  workflow_name: string;
  created_at: string;
  error?: string;
  snapshot?: { workflow: Workflow };
  steps?: { id: string; node_id: string; status: string; output: unknown }[];
  emailSends?: {
    node_id: string;
    mode: "preview" | "live";
    status: string;
    message: { from: string; to: string[]; subject: string; text: string };
    provider_email_id: string | null;
    error: string | null;
  }[];
  calls?: {
    id: string;
    node_id?: string | null;
    name: string;
    status: string;
    args: unknown;
    result: unknown;
  }[];
};
export type Bootstrap = {
  workflows: WorkflowRecord[];
  tools: ToolDefinition[];
  credentials: Credential[];
  runs: Run[];
  adminEmail: string;
  settings: {
    TOOL_ALLOWED_ORIGINS: string;
    MAX_ATTACHMENT_BYTES: string;
    RESEND_API_KEY: boolean;
    RESEND_WEBHOOK_SECRET: boolean;
  };
};
export async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}

export const statusLabel = (status: string) => status.replaceAll("_", " ");
