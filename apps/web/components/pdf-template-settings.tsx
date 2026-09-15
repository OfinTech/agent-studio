"use client";
import { useRef, useState } from "react";
import {
  Button,
  Code,
  CopyButton,
  FileButton,
  Group,
  NativeSelect,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import {
  detectPlaceholders,
  imageResourcesSchema,
  type PdfTemplate,
} from "../../../packages/contracts/src/pdf-templates";
import type { WorkflowNode } from "../../../packages/contracts/src/index";
import type { PlatformController } from "./use-platform";

export function PdfTemplateSettings({
  controller: c,
  node,
}: {
  controller: PlatformController;
  node: WorkflowNode;
}) {
  const template = node.data.pdfTemplate!;
  const [uploading, setUploading] = useState(false);
  const resetRef = useRef<() => void>(null);
  let names: string[] = [],
    error: string | undefined;
  try {
    names = detectPlaceholders(template.source);
  } catch (e) {
    error = (e as Error).message;
  }
  const patch = (changes: Partial<PdfTemplate>) =>
    c.patchNode({ pdfTemplate: { ...template, ...changes } });
  async function upload(file: File | null) {
    if (!file) return;
    setUploading(true);
    c.setError("");
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error("Images must be at most 5 MiB");
      const response = await fetch(
        `/api/workflows/${c.workflowId}/resources?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-template-resources": JSON.stringify(template.images),
          },
          body: file,
        },
      );
      const image = await response.json();
      if (!response.ok) throw new Error(image.error ?? "Image upload failed");
      imageResourcesSchema.parse([...template.images, image]);
      c.addTemplateImage(c.workflowId, node.id, image);
    } catch (e) {
      c.setError((e as Error).message);
    } finally {
      setUploading(false);
      resetRef.current?.();
    }
  }
  return (
    <Stack gap="md">
      <NativeSelect
        label="Connected Agent"
        value={
          c.draft?.edges.find((e) => e.kind === "tool" && e.source === node.id)
            ?.target ?? ""
        }
        data={[
          { value: "", label: "Choose an Agent" },
          ...(c.draft?.nodes
            .filter((n) => n.type === "agent")
            .map((n) => ({ value: n.id, label: n.data.label })) ?? []),
        ]}
        onChange={(e) => {
          if (c.draft)
            c.update({
              ...c.draft,
              edges: [
                ...c.draft.edges.filter(
                  (edge) => !(edge.kind === "tool" && edge.source === node.id),
                ),
                ...(e.currentTarget.value
                  ? [
                      {
                        id: crypto.randomUUID(),
                        source: node.id,
                        target: e.currentTarget.value,
                        kind: "tool" as const,
                      },
                    ]
                  : []),
              ],
            });
        }}
      />
      <TextInput
        label="MCP tool name"
        value={template.toolName}
        onChange={(e) => patch({ toolName: e.currentTarget.value })}
      />
      <Textarea
        label="Tool description"
        value={template.description}
        onChange={(e) => patch({ description: e.currentTarget.value })}
      />
      <Textarea
        label="LaTeX template"
        rows={12}
        value={template.source}
        error={error}
        description="Use <<name>> for required LaTeX parameters. Values are inserted verbatim."
        onChange={(e) => {
          const source = e.currentTarget.value;
          let placeholders = template.placeholders;
          try {
            placeholders = Object.fromEntries(
              detectPlaceholders(source).map((name) => [
                name,
                template.placeholders[name] ?? "",
              ]),
            );
          } catch {
            /* Preserve descriptions while a marker is incomplete. */
          }
          patch({ source, placeholders });
        }}
      />
      {names.map((name) => (
        <TextInput
          key={name}
          label={`Description for ${name}`}
          value={template.placeholders[name] ?? ""}
          onChange={(e) =>
            patch({
              placeholders: {
                ...template.placeholders,
                [name]: e.currentTarget.value,
              },
            })
          }
        />
      ))}
      <Text>Tool signature</Text>
      <Code
        block
      >{`${template.toolName}({ ${names.map((name) => `${name}: string`).join(", ")} })`}</Code>
      <Text>Template images</Text>
      <Text c="dimmed">
        PNG/JPEG, up to 10 images, 5 MiB each and 20 MiB total. Up to 16
        megapixels per image.
      </Text>
      {template.images.map((image) => (
        <Stack key={image.id} gap="md">
          <Code>{`assets/${image.filename}`}</Code>
          <Group gap="md">
            <CopyButton value={`assets/${image.filename}`}>
              {({ copied, copy }) => (
                <Button variant="default" onClick={copy}>
                  {copied ? "Copied" : `Copy ${image.filename}`}
                </Button>
              )}
            </CopyButton>
            <Button
              component="a"
              variant="default"
              href={`/api/workflows/${c.workflowId}/resources/${image.id}`}
            >
              Download {image.filename}
            </Button>
            <Button
              color="red"
              disabled={uploading}
              onClick={() =>
                patch({
                  images: template.images.filter((i) => i.id !== image.id),
                })
              }
            >
              Remove {image.filename}
            </Button>
          </Group>
        </Stack>
      ))}
      <FileButton
        resetRef={resetRef}
        onChange={upload}
        accept="image/png,image/jpeg"
        disabled={uploading || template.images.length >= 10}
      >
        {(props) => (
          <Button {...props} loading={uploading} variant="default">
            Upload image
          </Button>
        )}
      </FileButton>
    </Stack>
  );
}
