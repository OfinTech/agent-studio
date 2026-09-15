"use client";
import { pdfInstructions } from "../../../packages/contracts/src/reports";
import {
  Button,
  Checkbox,
  Code,
  NativeSelect,
  NumberInput,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import {
  connectedOutcome,
  earlierOutputReferences,
  completionInstructions,
  type WorkflowNode,
} from "../../../packages/contracts/src/index";
import type { PlatformController } from "./use-platform";
export function AgentSettings({
  controller: c,
  node,
}: {
  controller: PlatformController;
  node: WorkflowNode;
}) {
  const { draft, data, patchNode, setSelected } = c;
  const outcome = draft && connectedOutcome(draft, node.id);
  const pdfCollision = draft?.edges.some(
    (edge) =>
      edge.kind === "tool" &&
      edge.target === node.id &&
      data?.tools.some(
        (tool) =>
          tool.name === "generate_pdf" &&
          tool.id ===
            draft.nodes.find((n) => n.id === edge.source)?.data.toolId,
      ),
  );
  return (
    <>
      <NativeSelect
        label="Provider"
        value={node.data.provider ?? "mock"}
        data={[
          { value: "mock", label: "Mock · local testing" },
          { value: "gemini", label: "Google Gemini" },
          { value: "openai", label: "OpenAI" },
          { value: "claude", label: "Claude" },
        ]}
        onChange={(e) =>
          patchNode({
            provider: e.target.value as WorkflowNode["data"]["provider"],
          })
        }
      />
      {node.data.provider !== "mock" && (
        <NativeSelect
          label={
            node.data.provider === "gemini"
              ? "Gemini credential"
              : "Provider credential"
          }
          value={node.data.credentialId ?? ""}
          data={[
            { value: "", label: "Choose a credential" },
            ...(data?.credentials
              .filter((c) => c.kind === node.data.provider)
              .map((c) => ({ value: c.id, label: c.name })) ?? []),
          ]}
          onChange={(e) => patchNode({ credentialId: e.target.value })}
        />
      )}
      <TextInput
        label="Model ID"
        value={node.data.model ?? ""}
        onChange={(e) => patchNode({ model: e.target.value })}
      />
      <Textarea
        label="System prompt"
        rows={6}
        value={node.data.systemPrompt ?? ""}
        onChange={(e) => patchNode({ systemPrompt: e.target.value })}
      />
      <Textarea
        label="User prompt"
        rows={7}
        value={node.data.userPrompt ?? ""}
        onChange={(e) => patchNode({ userPrompt: e.target.value })}
      />
      <Text>Insert variable</Text>
      <Stack gap="md">
        {[
          "email.subject",
          "email.from",
          "email.text",
          ...(draft ? earlierOutputReferences(draft, node.id) : []),
          `steps.${draft?.nodes.find((n) => n.type === "upload")?.id ?? "upload"}.count`,
        ].map((variable) => (
          <Button
            variant="default"
            key={variable}
            onClick={() =>
              patchNode({
                userPrompt: (node.data.userPrompt ?? "") + ` {{${variable}}}`,
              })
            }
          >{`{{${variable}}}`}</Button>
        ))}
      </Stack>
      {(node.data.provider === "gemini" || node.data.provider === "mock") && (
        <NumberInput
          label="Temperature"
          min={0}
          max={2}
          step={0.1}
          value={node.data.temperature ?? 0.1}
          onChange={(value) => patchNode({ temperature: Number(value) })}
        />
      )}
      <NumberInput
        label="Output tokens"
        min={1}
        max={65536}
        value={node.data.maxOutputTokens ?? 4096}
        onChange={(value) => patchNode({ maxOutputTokens: Number(value) })}
      />
      <Checkbox
        label="Generate PDF reports"
        disabled={pdfCollision && !node.data.generatePdf}
        error={
          pdfCollision
            ? "Rename the attached generate_pdf tool before enabling PDF reports."
            : undefined
        }
        checked={node.data.generatePdf ?? false}
        onChange={(event) =>
          patchNode({ generatePdf: event.currentTarget.checked })
        }
      />
      {node.data.generatePdf && (
        <Stack gap="md">
          <Text>Generated PDF instructions</Text>
          <Code block>{pdfInstructions}</Code>
        </Stack>
      )}
      {outcome ? (
        <Stack gap="md">
          <Text>Generated completion instructions</Text>
          <Code block>{completionInstructions(outcome)}</Code>
          <Button variant="default" onClick={() => setSelected(outcome.id)}>
            Open Outcome block
          </Button>
        </Stack>
      ) : (
        <>
          <Button variant="default" onClick={() => c.addOutcome(node.id)}>
            Add outcome
          </Button>
          <TextInput
            label="Required success tool"
            value={node.data.requiredTool ?? ""}
            placeholder="Optional tool name"
            onChange={(e) =>
              patchNode({ requiredTool: e.target.value || undefined })
            }
          />
          <Text c="dimmed">
            A run succeeds only after this tool returns a successful API
            response. Maximum 10 turns and 5 minutes.
          </Text>
        </>
      )}
    </>
  );
}
