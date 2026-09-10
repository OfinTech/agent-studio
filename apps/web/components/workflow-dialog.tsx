"use client";
import {
  Alert,
  Button,
  Group,
  Modal,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect } from "react";
import { isNotEmpty, useForm } from "@mantine/form";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
export function WorkflowDialog({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const form = useForm({
    initialValues: { name: "My workflow", template: "receipt" },
    validate: { name: isNotEmpty("Enter a workflow name") },
  });
  return (
    <Modal
      opened={c.modal === "workflow"}
      onExitTransitionEnd={() => form.reset()}
      onClose={() => c.setModal(null)}
      title="Create workflow"
      closeButtonProps={{ "aria-label": "Close dialog" }}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(
          (values) =>
            void c.action(async () => {
              const created = await api("workflows", "POST", values);
              await c.refresh();
              c.setModal(null);
              c.navigate(`/workflows/${created.id}`);
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
            required
            data-autofocus
            {...form.getInputProps("name")}
          />
          <NativeSelect
            label="Start from"
            data={[
              { value: "receipt", label: "Receipt intake example" },
              { value: "blank", label: "Blank canvas" },
            ]}
            {...form.getInputProps("template")}
          />
          <Button type="submit" loading={c.busy}>
            Create workflow
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

export function WorkflowSettings({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const form = useForm({
    initialValues: { name: "" },
    validate: { name: isNotEmpty("Enter a workflow name") },
  });
  useEffect(() => {
    if (c.modal === "workflow-settings") {
      form.setValues({ name: c.draft?.name ?? "" });
      form.clearErrors();
    }
  }, [c.modal]);
  return (
    <Modal
      opened={c.modal === "workflow-settings"}
      onClose={() => c.setModal(null)}
      title="Workflow settings"
      closeButtonProps={{ "aria-label": "Close dialog" }}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(({ name }) => {
          if (c.draft && name !== c.draft.name) c.update({ ...c.draft, name });
          c.setModal(null);
        })}
      >
        <Stack gap="md">
          <TextInput
            label="Workflow name"
            required
            data-autofocus
            {...form.getInputProps("name")}
          />
          <Group justify="space-between">
            <Button type="submit">Apply</Button>
            <Button
              variant="default"
              color="red"
              onClick={() => c.setModal("delete-workflow")}
            >
              Delete workflow
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
export function DeleteWorkflow({
  controller: c,
}: {
  controller: PlatformController;
}) {
  return (
    <Modal
      opened={c.modal === "delete-workflow"}
      onClose={() => !c.busy && c.setModal(null)}
      title="Delete workflow"
      closeButtonProps={{ "aria-label": "Close dialog", disabled: c.busy }}
    >
      <Stack gap="md">
        {c.error && (
          <Alert color="red" role="alert">
            {c.error}
          </Alert>
        )}
        <Text>
          This removes {c.draft?.name ?? "the workflow"}, its published version,
          and its run history.
        </Text>
        <Group>
          <Button
            color="red"
            loading={c.busyAction === "delete"}
            disabled={c.busy}
            onClick={() => void c.action(c.deleteWorkflow, "delete")}
          >
            Delete
          </Button>
          <Button
            variant="default"
            data-autofocus
            disabled={c.busy}
            onClick={() => c.setModal(null)}
          >
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
