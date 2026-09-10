"use client";
import {
  Badge,
  Button,
  Group,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
export function SettingsView({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const current = c.data!.settings;
  const form = useForm({
    initialValues: {
      TOOL_ALLOWED_ORIGINS: current.TOOL_ALLOWED_ORIGINS,
      MAX_ATTACHMENT_BYTES: current.MAX_ATTACHMENT_BYTES,
      RESEND_API_KEY: "",
      RESEND_WEBHOOK_SECRET: "",
    },
  });
  const secretLabel = (label: string, configured: boolean) => (
    <Group gap="xs" component="span">
      {label}
      <Badge color={configured ? "green" : "gray"} variant="light">
        {configured ? "Configured" : "Not configured"}
      </Badge>
    </Group>
  );
  const secretProps = (
    key: "RESEND_API_KEY" | "RESEND_WEBHOOK_SECRET",
    label: string,
  ) => ({
    label: secretLabel(label, current[key]),
    description: current[key]
      ? "Stored. Enter a new value to replace it."
      : undefined,
    placeholder: current[key] ? "••••••••••••" : undefined,
    autoComplete: "new-password",
    flex: 1,
    ...form.getInputProps(key),
  });
  const clear = (key: "RESEND_API_KEY" | "RESEND_WEBHOOK_SECRET") =>
    void c.action(async () => {
      await api("settings", "PUT", { [key]: "" });
      await c.refresh();
      form.setFieldValue(key, "");
      c.setNotice("Cleared");
    });
  return (
    <form
      noValidate
      onSubmit={form.onSubmit(
        (values) =>
          void c.action(async () => {
            await api("settings", "PUT", {
              TOOL_ALLOWED_ORIGINS: values.TOOL_ALLOWED_ORIGINS,
              MAX_ATTACHMENT_BYTES: values.MAX_ATTACHMENT_BYTES,
              ...(values.RESEND_API_KEY && {
                RESEND_API_KEY: values.RESEND_API_KEY,
              }),
              ...(values.RESEND_WEBHOOK_SECRET && {
                RESEND_WEBHOOK_SECRET: values.RESEND_WEBHOOK_SECRET,
              }),
            });
            await c.refresh();
            form.setFieldValue("RESEND_API_KEY", "");
            form.setFieldValue("RESEND_WEBHOOK_SECRET", "");
            c.setNotice("Saved");
          }),
      )}
    >
      <Stack gap="md">
        <Title order={1}>Settings</Title>
        <TextInput
          label="Allowed tool origins"
          description="Comma-separated exact origins that MCP tools may call, for example https://api.example.com"
          {...form.getInputProps("TOOL_ALLOWED_ORIGINS")}
        />
        <TextInput
          label="Maximum attachment bytes per email"
          placeholder="20971520"
          inputMode="numeric"
          {...form.getInputProps("MAX_ATTACHMENT_BYTES")}
        />
        <Group align="flex-end" wrap="nowrap">
          <PasswordInput {...secretProps("RESEND_API_KEY", "Resend API key")} />
          <Button
            variant="default"
            disabled={!current.RESEND_API_KEY || c.busy}
            onClick={() => clear("RESEND_API_KEY")}
          >
            Clear
          </Button>
        </Group>
        <Group align="flex-end" wrap="nowrap">
          <PasswordInput
            {...secretProps("RESEND_WEBHOOK_SECRET", "Resend webhook secret")}
          />
          <Button
            variant="default"
            disabled={!current.RESEND_WEBHOOK_SECRET || c.busy}
            onClick={() => clear("RESEND_WEBHOOK_SECRET")}
          >
            Clear
          </Button>
        </Group>
        <Group>
          <Button type="submit" loading={c.busy}>
            Save settings
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
