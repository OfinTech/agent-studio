"use client";
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ApplicationShell } from "./application-shell";
import { Credentials, CredentialDialog } from "./credentials";
import { MockReceipts } from "./mock-receipts";
import { RunHistory, RunInspector } from "./run-inspection";
import { Tools, ToolDialog } from "./tools";
import { usePlatform } from "./use-platform";
import { WorkflowDialog } from "./workflow-dialog";
import { WorkflowList } from "./workflow-list";
import { WorkflowSettings } from "./workflow-dialog";
import { WorkflowEditor } from "./workflow-editor";
export function Platform({ children }: { children: React.ReactNode }) {
  const c = usePlatform();
  return (
    <ApplicationShell controller={c}>
      <Stack gap="md" h={c.workflowId ? "100%" : undefined}>
        {c.error && !c.modal && !c.pendingNavigation && (
          <Alert
            role="alert"
            color="red"
            withCloseButton
            closeButtonLabel="Dismiss message"
            onClose={() => c.setError("")}
          >
            {c.error}
          </Alert>
        )}
        {c.notice && <Text role="status">{c.notice}</Text>}
        {!c.data ? (
          <>
            <Title order={1}>
              {c.error ? "Workspace unavailable" : "Loading…"}
            </Title>
            {!c.error && <Loader aria-label="Loading workspace" />}
          </>
        ) : c.view === "workflows" ? (
          c.workflowId ? (
            <WorkflowEditor key={c.workflowId} controller={c} />
          ) : (
            <WorkflowList controller={c} />
          )
        ) : c.view === "tools" ? (
          <Tools controller={c} />
        ) : c.view === "credentials" ? (
          <Credentials controller={c} />
        ) : c.view === "mock-receipts" ? (
          <MockReceipts controller={c} />
        ) : (
          <RunHistory controller={c} />
        )}
      </Stack>
      {children}
      <Modal
        opened={Boolean(c.pendingNavigation)}
        onClose={() => !c.busy && c.setPendingNavigation(undefined)}
        title="Unsaved changes"
        closeButtonProps={{ "aria-label": "Close dialog", disabled: c.busy }}
      >
        <Stack gap="md">
          {c.error && (
            <Alert role="alert" color="red">
              {c.error}
            </Alert>
          )}
          <Group>
            <Button
              loading={c.busyAction === "save-leave"}
              disabled={c.busy}
              onClick={() =>
                void c.action(() => c.resolveNavigation(false), "save-leave")
              }
            >
              Save and leave
            </Button>
            <Button
              variant="default"
              disabled={c.busy}
              onClick={() =>
                void c.action(() => c.resolveNavigation(true), "discard-leave")
              }
            >
              Discard and leave
            </Button>
            <Button
              variant="default"
              data-autofocus
              disabled={c.busy}
              onClick={() => c.setPendingNavigation(undefined)}
            >
              Stay
            </Button>
          </Group>
        </Stack>
      </Modal>
      <WorkflowSettings controller={c} />
      <WorkflowDialog controller={c} />
      <CredentialDialog controller={c} />
      <ToolDialog controller={c} />
      <RunInspector controller={c} />
    </ApplicationShell>
  );
}
