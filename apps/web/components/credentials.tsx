"use client";
import {
  Alert,
  Button,
  Group,
  Modal,
  NativeSelect,
  PasswordInput,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { isNotEmpty, useForm } from "@mantine/form";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
export function Credentials({
  controller: c,
}: {
  controller: PlatformController;
}) {
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>Credentials</Title>
        <Button
          onClick={() => {
            c.setError("");
            c.setModal("credential");
          }}
        >
          Add credential
        </Button>
      </Group>
      {c.data?.credentials.length ? (
        <ScrollArea>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Type</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.data.credentials.map((credential) => (
                <Table.Tr key={credential.id}>
                  <Table.Td>{credential.name}</Table.Td>
                  <Table.Td>
                    {credential.kind === "gemini"
                      ? "Google Gemini"
                      : credential.kind === "api"
                        ? "Client API"
                        : credential.kind}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        <Text>No credentials yet.</Text>
      )}
    </Stack>
  );
}
export function CredentialDialog({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const form = useForm({
    initialValues: { name: "", kind: "gemini", secret: "" },
    validate: {
      name: isNotEmpty("Enter a credential name"),
      secret: isNotEmpty("Enter a secret"),
    },
  });
  return (
    <Modal
      opened={c.modal === "credential"}
      onExitTransitionEnd={() => form.reset()}
      onClose={() => c.setModal(null)}
      title="Add credential"
      closeButtonProps={{ "aria-label": "Close dialog" }}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(
          (values) =>
            void c.action(async () => {
              await api("credentials", "POST", values);
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
            label="Name"
            placeholder="Production Gemini"
            required
            data-autofocus
            {...form.getInputProps("name")}
          />
          <NativeSelect
            label="Type"
            data={[
              { value: "gemini", label: "Google Gemini" },
              { value: "openai", label: "OpenAI" },
              { value: "claude", label: "Claude" },
              {
                value: "api",
                label: "Client API",
              },
            ]}
            {...form.getInputProps("kind")}
          />
          <PasswordInput
            label="Secret"
            aria-invalid={Boolean(form.errors.secret) || undefined}
            autoComplete="new-password"
            placeholder="Paste API key or bearer token"
            required
            {...form.getInputProps("secret")}
          />
          <Button type="submit" loading={c.busy}>
            Save credential
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}
