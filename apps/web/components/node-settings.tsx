"use client";
import { PdfTemplateSettings } from "./pdf-template-settings";
import { reportSources } from "../../../packages/contracts/src/reports";
import {
  Button,
  Code,
  JsonInput,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import {
  canConnect,
  earlierOutputReferences,
  type WorkflowNode,
} from "../../../packages/contracts/src/index";
import { Trash2, Wrench, X } from "lucide-react";
import type { PlatformController } from "./use-platform";
import { AgentSettings } from "./agent-settings";
import { OutcomeSettings } from "./outcome-settings";
export function NodeSettings({
  controller: c,
  inDrawer = false,
}: {
  controller: PlatformController;
  inDrawer?: boolean;
}) {
  const { selectedNode: node, draft, data, patchNode, setSelected, update } = c;
  if (!node) return null;
  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        {!inDrawer && (
          <Group justify="space-between">
            <Title order={2}>Step settings</Title>
            {node && (
              <Button
                variant="default"
                aria-label="Close settings"
                onClick={() => setSelected(undefined)}
              >
                <X size={16} />
              </Button>
            )}
          </Group>
        )}
        <TextInput
          label="Step name"
          data-autofocus
          value={node.data.label}
          onChange={(e) => patchNode({ label: e.target.value })}
        />
        {node.type === "email" && (
          <>
            <TextInput
              label="Receiving address"
              type="email"
              value={node.data.recipient ?? ""}
              onChange={(e) => patchNode({ recipient: e.target.value })}
              description="Use a unique address routed through Resend to your signed inbound webhook."
            />
          </>
        )}
        {node.type === "send_email" && draft && (
          <EmailSettings
            key={node.id}
            node={node}
            draft={draft}
            patchNode={patchNode}
          />
        )}
        {node.type === "upload" && (
          <>
            <Text>Accepted attachments</Text>
            {(["application/pdf", "image/jpeg", "image/png"] as const).map(
              (mime) => (
                <Checkbox
                  key={mime}
                  label={mime.split("/")[1].toUpperCase()}
                  checked={node.data.mimeTypes?.includes(mime) ?? false}
                  onChange={(e) =>
                    patchNode({
                      mimeTypes: e.target.checked
                        ? [...(node.data.mimeTypes ?? []), mime]
                        : (node.data.mimeTypes ?? []).filter((t) => t !== mime),
                    })
                  }
                />
              ),
            )}
            <Text c="dimmed">
              Total limit: 20 MB. Files expire after seven days.
            </Text>
          </>
        )}
        {node.type === "pdf_template" && node.data.pdfTemplate && (
          <PdfTemplateSettings key={node.id} controller={c} node={node} />
        )}
        {node.type === "agent" && <AgentSettings controller={c} node={node} />}
        {(node.type === "tool" || node.type === "action") && (
          <>
            <NativeSelect
              label="MCP tool"
              value={node.data.toolId ?? ""}
              data={[
                { value: "", label: "Choose a tool" },
                ...(data?.tools.map((t) => ({
                  value: t.id,
                  label: t.name,
                })) ?? []),
              ]}
              onChange={(e) => patchNode({ toolId: e.target.value })}
            />
            <Button
              variant="default"
              leftSection={<Wrench size={16} />}
              onClick={() => {
                c.setEditingTool(
                  data?.tools.find((t) => t.id === node.data.toolId),
                );
                c.setError("");
                c.setModal("tool");
              }}
            >
              Configure tool
            </Button>
          </>
        )}
        {node.type === "action" &&
          draft &&
          earlierOutputReferences(draft, node.id).length > 0 && (
            <Stack gap="md">
              <Text>Earlier outputs</Text>
              <Code block>
                {earlierOutputReferences(draft, node.id)
                  .map((ref) => `{{${ref}}}`)
                  .join("\n")}
              </Code>
            </Stack>
          )}
        {node.type === "action" && (
          <ActionArguments key={node.id} node={node} patchNode={patchNode} />
        )}
        {node.type === "outcome" && (
          <OutcomeSettings controller={c} node={node} />
        )}
        {(node.type === "agent" || node.type === "action") && draft && (
          <NativeSelect
            label="Next step"
            value={
              draft.edges.find(
                (e) => e.kind === "execution" && e.source === node.id,
              )?.target ?? ""
            }
            data={[
              { value: "", label: "End execution" },
              ...draft.nodes
                .filter((n) =>
                  canConnect(
                    {
                      ...draft,
                      edges: draft.edges.filter(
                        (e) =>
                          !(e.kind === "execution" && e.source === node.id),
                      ),
                    },
                    {
                      id: "next",
                      source: node.id,
                      target: n.id,
                      kind: "execution",
                    },
                  ),
                )
                .map((n) => ({ value: n.id, label: n.data.label })),
            ]}
            onChange={(e) =>
              update({
                ...draft,
                edges: [
                  ...draft.edges.filter(
                    (edge) =>
                      !(edge.kind === "execution" && edge.source === node.id),
                  ),
                  ...(e.target.value
                    ? [
                        {
                          id: crypto.randomUUID(),
                          source: node.id,
                          target: e.target.value,
                          kind: "execution" as const,
                        },
                      ]
                    : []),
                ],
              })
            }
          />
        )}
        <Button
          color="red"
          leftSection={<Trash2 size={16} />}
          onClick={() => {
            if (!draft) return;
            update({
              ...draft,
              nodes: draft.nodes.filter((n) => n.id !== node.id),
              edges: draft.edges.filter(
                (e) => e.source !== node.id && e.target !== node.id,
              ),
            });
            setSelected(undefined);
          }}
        >
          Remove step
        </Button>
      </Stack>
    </Paper>
  );
}

function ActionArguments({
  node,
  patchNode,
}: {
  node: WorkflowNode;
  patchNode: (data: Partial<WorkflowNode["data"]>) => void;
}) {
  const [value, setValue] = useState(
    JSON.stringify(node.data.arguments ?? {}, null, 2),
  );
  return (
    <JsonInput
      label="Input arguments"
      description="Use {{steps.agentId.outcome.result}} or earlier step outputs. Whole-value references preserve JSON types."
      value={value}
      minRows={6}
      formatOnBlur
      validationError="Enter a JSON object"
      onChange={(text) => {
        setValue(text);
        try {
          const args = JSON.parse(text);
          patchNode({
            arguments:
              args && typeof args === "object" && !Array.isArray(args)
                ? args
                : undefined,
          });
        } catch {
          patchNode({ arguments: undefined });
        }
      }}
    />
  );
}

function EmailSettings({
  node,
  draft,
  patchNode,
}: {
  node: WorkflowNode;
  draft: NonNullable<PlatformController["draft"]>;
  patchNode: PlatformController["patchNode"];
}) {
  const [field, setField] = useState<"subjectTemplate" | "bodyTemplate">(
    "bodyTemplate",
  );
  return (
    <Stack gap="md">
      <TextInput
        label="From: trigger inbox"
        readOnly
        value={
          draft.nodes.find((n) => n.type === "email")?.data.recipient ?? ""
        }
      />
      <TextInput label="To" readOnly value="Original sender" />
      <NativeSelect
        label="Attach PDF report from"
        value={node.data.reportSourceNodeId ?? ""}
        data={[
          { value: "", label: "None" },
          ...reportSources(draft, node.id).map((n) => ({
            value: n.id,
            label: n.data.label,
          })),
          ...(node.data.reportSourceNodeId &&
          !reportSources(draft, node.id).some(
            (n) => n.id === node.data.reportSourceNodeId,
          )
            ? [
                {
                  value: node.data.reportSourceNodeId,
                  label: "Unavailable Agent — choose another source",
                },
              ]
            : []),
        ]}
        error={
          node.data.reportSourceNodeId &&
          !reportSources(draft, node.id).some(
            (n) => n.id === node.data.reportSourceNodeId,
          )
            ? "Select a PDF-enabled Agent earlier on this path."
            : undefined
        }
        onChange={(event) =>
          patchNode({
            reportSourceNodeId: event.currentTarget.value || undefined,
          })
        }
      />
      <TextInput
        label="Subject template"
        value={node.data.subjectTemplate ?? ""}
        description="Optional. Leave empty to reply to the original subject."
        onFocus={() => setField("subjectTemplate")}
        onChange={(event) => patchNode({ subjectTemplate: event.target.value })}
      />
      <Textarea
        label="Body template"
        required
        rows={8}
        value={node.data.bodyTemplate ?? ""}
        onFocus={() => setField("bodyTemplate")}
        onChange={(event) => patchNode({ bodyTemplate: event.target.value })}
      />
      <Text>
        Insert variable into {field === "bodyTemplate" ? "body" : "subject"}
      </Text>
      {[
        "email.subject",
        "email.from",
        "email.to",
        "email.text",
        ...earlierOutputReferences(draft, node.id),
      ].map((variable) => (
        <Button
          key={variable}
          variant="default"
          onClick={() =>
            patchNode({ [field]: (node.data[field] ?? "") + `{{${variable}}}` })
          }
        >{`{{${variable}}}`}</Button>
      ))}
      <Text c="dimmed">
        Test runs preview this email. Inbound runs send it through Resend.
      </Text>
    </Stack>
  );
}
