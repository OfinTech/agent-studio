"use client";
import { useEffect } from "react";
import {
  Alert,
  Anchor,
  Button,
  Group,
  JsonInput,
  Modal,
  NativeSelect,
  ScrollArea,
  Table,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { isNotEmpty, useForm } from "@mantine/form";
import {
  receiptTool,
  type ToolDefinition,
} from "../../../packages/contracts/src/index";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
export function Tools({ controller: c }: { controller: PlatformController }) {
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>MCP tools</Title>
        <Button
          onClick={() => {
            c.setEditingTool(undefined);
            c.setError("");
            c.setModal("tool");
          }}
        >
          Create tool
        </Button>
      </Group>
      {c.data?.tools.length ? (
        <ScrollArea>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>HTTP method</Table.Th>
                <Table.Th>Endpoint</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.data.tools.map((tool) => (
                <Table.Tr key={tool.id}>
                  <Table.Td>
                    <Anchor
                      component="button"
                      onClick={() => {
                        c.setEditingTool(tool);
                        c.setError("");
                        c.setModal("tool");
                      }}
                    >
                      {tool.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{tool.method}</Table.Td>
                  <Table.Td>{tool.endpoint}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        <Text>No tools yet.</Text>
      )}
    </Stack>
  );
}
function jsonError(value: string) {
  try {
    JSON.parse(value);
    return null;
  } catch {
    return "Enter valid JSON";
  }
}
export function ToolDialog({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const initial = c.editingTool ?? {
    ...receiptTool,
    id: "new",
    name: "my_api_tool",
    description: "",
    endpoint: "https://api.example.com/receipts",
    auth: { type: "none" as const, header: "X-API-Key" },
  };
  const form = useForm({
    initialValues: {
      ...initial,
      schema: JSON.stringify(initial.inputSchema, null, 2),
      mappingJson: JSON.stringify(initial.mappings, null, 2),
    },
    validate: {
      name: (value) =>
        /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value)
          ? null
          : "Use a letter followed by up to 63 letters, numbers, or underscores",
      description: isNotEmpty("Enter a description"),
      endpoint: (value) => {
        try {
          new URL(value);
          return null;
        } catch {
          return "Enter a valid URL";
        }
      },
      schema: jsonError,
      mappingJson: jsonError,
      auth: {
        credentialId: (value, values) =>
          values.auth.type !== "none" && !value ? "Choose a credential" : null,
        header: (value, values) =>
          values.auth.type === "api-key" && !value
            ? "Enter an API key header"
            : null,
      },
    },
  });
  // Refresh the form when opening an existing tool, while leaving Modal mounted
  // through its close transition so Mantine can restore keyboard focus.
  useEffect(() => {
    if (c.modal !== "tool") return;
    const values = {
      ...initial,
      schema: JSON.stringify(initial.inputSchema, null, 2),
      mappingJson: JSON.stringify(initial.mappings, null, 2),
    };
    form.setInitialValues(values);
    form.setValues(values);
    form.clearErrors();
  }, [c.modal, c.editingTool]);
  return (
    <Modal
      opened={c.modal === "tool"}
      onExitTransitionEnd={() => form.reset()}
      onClose={() => c.setModal(null)}
      title={c.editingTool ? "Edit MCP tool" : "Create MCP tool"}
      size="lg"
      closeButtonProps={{ "aria-label": "Close dialog" }}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(
          ({ schema, mappingJson, ...values }) =>
            void c.action(async () => {
              const tool: ToolDefinition = {
                ...values,
                inputSchema: JSON.parse(schema),
                mappings: JSON.parse(mappingJson),
                idempotencyHeader: values.idempotencyHeader || undefined,
              };
              await api(
                c.editingTool ? `tools/${c.editingTool.id}` : "tools",
                c.editingTool ? "PUT" : "POST",
                tool,
              );
              await c.refresh();
              c.setModal(null);
              c.setNotice("Saved");
            }),
        )}
      >
        <Stack gap="md">
          {c.error && (
            <Alert color="red" role="alert">
              {c.error}
            </Alert>
          )}
          <TextInput
            label="Tool name"
            required
            data-autofocus
            {...form.getInputProps("name")}
          />
          <NativeSelect
            label="HTTP method"
            data={["GET", "POST", "PUT", "PATCH", "DELETE"]}
            {...form.getInputProps("method")}
          />
          <Textarea
            label="Description"
            rows={2}
            required
            {...form.getInputProps("description")}
          />
          <TextInput
            label="Fixed API endpoint"
            type="url"
            required
            description="Your instance owner must allow this API origin in the server configuration."
            {...form.getInputProps("endpoint")}
          />
          <JsonInput
            label="Input JSON Schema"
            rows={8}
            formatOnBlur
            {...form.getInputProps("schema")}
          />
          <JsonInput
            label="Request field mappings"
            rows={5}
            formatOnBlur
            description="Each mapping has a source argument path, a target field name, and a location of body or query."
            {...form.getInputProps("mappingJson")}
          />
          <NativeSelect
            label="Authentication"
            data={[
              { value: "none", label: "None" },
              { value: "bearer", label: "Bearer token" },
              { value: "api-key", label: "API key header" },
            ]}
            {...form.getInputProps("auth.type")}
          />
          {form.values.auth.type !== "none" && (
            <NativeSelect
              label="Credential"
              required
              data={[
                { value: "", label: "Choose credential" },
                ...(c.data?.credentials
                  .filter((credential) => credential.kind === "api")
                  .map((credential) => ({
                    value: credential.id,
                    label: credential.name,
                  })) ?? []),
              ]}
              {...form.getInputProps("auth.credentialId")}
            />
          )}
          {form.values.auth.type === "api-key" && (
            <TextInput
              label="API key header"
              required
              {...form.getInputProps("auth.header")}
            />
          )}
          <TextInput
            label="Idempotency header (optional)"
            placeholder="Idempotency-Key"
            description="Set this only if the client API guarantees idempotency for this header. Uncertain writes otherwise require manual review."
            {...form.getInputProps("idempotencyHeader")}
          />
          <Button type="submit" loading={c.busy}>
            Save tool
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}
