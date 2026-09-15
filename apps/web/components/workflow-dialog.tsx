"use client";
import {
  Alert,
  Button,
  Group,
  Modal,
  NativeSelect,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useRef } from "react";
import { isNotEmpty, useForm } from "@mantine/form";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
export function WorkflowDialog({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const form = useForm({
    initialValues: {
      name: "My workflow",
      method: "blank",
      duplicateFromWorkflowId: "",
    },
    validate: {
      name: (value) =>
        !value.trim()
          ? "Enter a workflow name"
          : value.length > 100
            ? "Use at most 100 characters"
            : null,
      duplicateFromWorkflowId: (value, values) =>
        values.method === "duplicate" && !value ? "Choose a workflow" : null,
    },
  });
  const manualName = useRef(false);
  const submitting = useRef(false);
  const workflows = c.data?.workflows ?? [];
  function suggestName(method: string, sourceId: string) {
    if (manualName.current) return;
    const source = workflows.find((workflow) => workflow.id === sourceId);
    form.setFieldValue(
      "name",
      method === "duplicate" && source
        ? `Copy of ${source.draft.name}`.slice(0, 100)
        : "My workflow",
    );
  }
  return (
    <Modal
      opened={c.modal === "workflow"}
      onExitTransitionEnd={() => {
        form.reset();
        manualName.current = false;
      }}
      onClose={() => !c.busy && c.setModal(null)}
      title="Create workflow"
      closeButtonProps={{ "aria-label": "Close dialog", disabled: c.busy }}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(async (values) => {
          if (submitting.current || c.busy) return;
          submitting.current = true;
          try {
            await c.action(async () => {
              const created = await api("workflows", "POST", {
                name: values.name.trim(),
                ...(values.method === "duplicate"
                  ? { duplicateFromWorkflowId: values.duplicateFromWorkflowId }
                  : {}),
              });
              await c.refresh();
              c.setModal(null);
              c.navigate(`/workflows/${created.id}`);
            });
          } finally {
            submitting.current = false;
          }
        })}
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
            maxLength={100}
            disabled={c.busy}
            {...form.getInputProps("name")}
            onChange={(event) => {
              manualName.current = true;
              form.setFieldValue("name", event.currentTarget.value);
            }}
          />
          <NativeSelect
            label="Creation method"
            disabled={c.busy}
            data={[
              { value: "blank", label: "Blank canvas" },
              {
                value: "duplicate",
                label: "Duplicate existing",
                disabled: !workflows.length,
              },
            ]}
            {...form.getInputProps("method")}
            onChange={(event) => {
              const method = event.currentTarget.value;
              form.setFieldValue("method", method);
              form.clearFieldError("duplicateFromWorkflowId");
              suggestName(method, form.values.duplicateFromWorkflowId);
            }}
          />
          {form.values.method === "duplicate" && (
            <Select
              label="Workflow to duplicate"
              description="Copies the saved draft, excluding unsaved changes."
              placeholder="Search workflows"
              searchable
              required
              disabled={c.busy}
              nothingFoundMessage="No workflows found"
              data={workflows.map((workflow) => {
                const recipient = workflow.draft.nodes.find(
                  (node) => node.type === "email",
                )?.data.recipient;
                return {
                  value: workflow.id,
                  label: `${workflow.draft.name} (${[recipient, workflow.id.slice(0, 8)].filter(Boolean).join(" · ")})`,
                };
              })}
              {...form.getInputProps("duplicateFromWorkflowId")}
              onChange={(value) => {
                form.setFieldValue("duplicateFromWorkflowId", value ?? "");
                suggestName(form.values.method, value ?? "");
              }}
            />
          )}
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
