"use client";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import Link from "next/link";
import { getPath } from "../../../packages/contracts/src/index";
import { statusLabel } from "./platform-types";
import type { PlatformController } from "./use-platform";
const statusColor = (status: string) =>
  status === "succeeded"
    ? "green"
    : status === "failed"
      ? "red"
      : status === "needs_review"
        ? "yellow"
        : "blue";
export function RunHistory({
  controller: c,
}: {
  controller: PlatformController;
}) {
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>Run history</Title>
        <Button
          variant="default"
          loading={c.busy}
          onClick={() =>
            void c.action(async () => {
              await c.refresh();
            })
          }
        >
          Refresh
        </Button>
      </Group>
      {c.data?.runs.length ? (
        <ScrollArea>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Workflow</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Started</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.data.runs.map((run) => (
                <Table.Tr key={run.id}>
                  <Table.Td>
                    <Button
                      variant="default"
                      onClick={(event) => {
                        c.runTrigger.current = event.currentTarget;
                        c.setRun(undefined);
                        c.setRunId(run.id);
                      }}
                    >
                      {run.workflow_name}
                    </Button>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={statusColor(run.status)}>
                      {statusLabel(run.status)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {new Date(run.created_at).toLocaleString()}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        <>
          <Text>No runs yet.</Text>
          <Button
            component={Link}
            href="/workflows"
            onNavigate={c.onNavigate("/workflows")}
            variant="default"
          >
            Workflows
          </Button>
        </>
      )}
    </Stack>
  );
}
export function RunInspector({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const run = c.run;
  return (
    <Drawer
      opened={Boolean(c.runId)}
      onClose={() => {
        c.setRunId(undefined);
      }}
      onExitTransitionEnd={() => {
        c.setRun(undefined);
        if (c.runTrigger.current?.isConnected) c.runTrigger.current.focus();
      }}
      position="right"
      title="Execution details"
      size="lg"
      closeButtonProps={{ "aria-label": "Close run inspector" }}
    >
      <Stack gap="md" data-testid="run-inspector">
        {!run ? (
          <>
            <Loader aria-label="Loading execution" />
            {c.error && (
              <Alert color="red" role="alert">
                {c.error}
              </Alert>
            )}
          </>
        ) : (
          <>
            <Group>
              <Badge data-testid="run-status" color={statusColor(run.status)}>
                {statusLabel(run.status)}
              </Badge>
            </Group>
            <Code>{run.id}</Code>
            {run.error && (
              <Alert color="red" role="alert">
                {run.error}
              </Alert>
            )}
            {run.systemNotices?.map((notice, index) => (
              <Stack gap="md" key={index} data-testid="system-notice">
                <Title order={3}>System-error notice</Title>
                <Badge color={statusColor(notice.status)}>
                  {notice.status === "preview"
                    ? "Preview only"
                    : notice.status === "succeeded"
                      ? "Accepted by Resend"
                      : notice.status === "needs_review"
                        ? "Uncertain delivery"
                        : statusLabel(notice.status)}
                </Badge>
                {notice.suppression_reason && (
                  <Text>Suppressed: {notice.suppression_reason}</Text>
                )}
                {notice.error && <Alert color="red">{notice.error}</Alert>}
                {notice.message && (
                  <>
                    <Text>From: {notice.message.from}</Text>
                    <Text>To: {notice.message.to.join(", ")}</Text>
                    <Text>Subject: {notice.message.subject}</Text>
                    <Stack gap="md">
                      {notice.message.text
                        .split("\n\n")
                        .map((paragraph, index) => (
                          <Text key={index}>{paragraph}</Text>
                        ))}
                    </Stack>
                  </>
                )}
                {notice.provider_email_id && (
                  <Text>Acceptance ID: {notice.provider_email_id}</Text>
                )}
              </Stack>
            ))}
            <Title order={3}>Steps</Title>
            {!run.steps?.length && <Text>No steps yet.</Text>}
            <Accordion multiple>
              {run.steps?.map((step) => (
                <Accordion.Item key={step.id} value={step.id}>
                  <Accordion.Control>
                    <Group>
                      <Text>{step.node_id}</Text>
                      <Badge color={statusColor(step.status)}>
                        {statusLabel(step.status)}
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    {getPath(step.output, "outcome") !== undefined && (
                      <Stack gap="md">
                        <Text>
                          Reported outcome:{" "}
                          {String(getPath(step.output, "outcome.name"))}
                        </Text>
                        <Text>
                          Reason:{" "}
                          {String(getPath(step.output, "outcome.reason"))}
                        </Text>
                        <Text>
                          Result:{" "}
                          {String(getPath(step.output, "outcome.result"))}
                        </Text>
                        <Text>
                          Selected branch:{" "}
                          {String(
                            getPath(step.output, "nextNode") ?? "End execution",
                          )}
                        </Text>
                      </Stack>
                    )}
                    <Code block>{JSON.stringify(step.output, null, 2)}</Code>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
            {run.snapshot?.workflow.nodes
              .filter(
                (n) =>
                  n.type !== "tool" &&
                  n.type !== "pdf_template" &&
                  !run.steps?.some((s) => s.node_id === n.id),
              )
              .map((n) => (
                <Text key={n.id}>
                  {n.data.label}:{" "}
                  {["succeeded", "failed", "needs_review"].includes(run.status)
                    ? "Not run"
                    : "Pending"}
                </Text>
              ))}
            {!!run.reports?.length && <Title order={3}>PDF reports</Title>}
            {run.reports?.map((report) => (
              <Stack gap="md" key={report.id}>
                <Text>
                  {report.node_id} · Attempt {report.attempt_order}
                  {report.template_node_id
                    ? ` · Template: ${run.snapshot?.workflow.nodes.find((n) => n.id === report.template_node_id)?.data.label ?? report.template_node_id}`
                    : ""}
                  {report.current ? " · Current report" : ""}
                </Text>
                <Badge color={statusColor(report.status)}>
                  {statusLabel(report.status)}
                </Badge>
                <Code block>{JSON.stringify(report.result, null, 2)}</Code>
                {report.report_id && (
                  <>
                    <Text>
                      {report.page_count} pages · {report.size} bytes
                    </Text>
                    {report.expired_at ? (
                      <Text>Report expired</Text>
                    ) : (
                      <Button
                        component="a"
                        variant="default"
                        href={`/api/runs/${run.id}/reports/${report.report_id}`}
                        download="report.pdf"
                      >
                        Download report.pdf
                      </Button>
                    )}
                    {report.extracted_text && (
                      <Stack gap="md">
                        <Text>
                          Extracted text
                          {report.text_truncated ? " (truncated)" : ""}
                        </Text>
                        <Code block>{report.extracted_text}</Code>
                      </Stack>
                    )}
                  </>
                )}
              </Stack>
            ))}
            {!!run.emailSends?.length && <Title order={3}>Emails</Title>}
            {run.emailSends?.map((send) => (
              <Stack gap="md" key={send.node_id}>
                <Text>
                  {run.snapshot?.workflow.nodes.find(
                    (n) => n.id === send.node_id,
                  )?.data.label ?? send.node_id}
                </Text>
                <Badge color={statusColor(send.status)}>
                  {send.status === "succeeded"
                    ? send.mode === "preview"
                      ? "Preview only"
                      : "Accepted by Resend"
                    : statusLabel(send.status)}
                </Badge>
                <Text>From: {send.message.from}</Text>
                <Text>To: {send.message.to.join(", ")}</Text>
                <Text>Subject: {send.message.subject}</Text>
                <Text>Body</Text>
                <Code block>{send.message.text}</Code>
                {send.message.attachments?.map((report) => (
                  <Stack gap="md" key={report.reportId}>
                    <Text>
                      {report.filename} · {report.pageCount} pages ·{" "}
                      {report.size} bytes
                    </Text>
                    <Button
                      component="a"
                      variant="default"
                      href={`/api/runs/${run.id}/reports/${report.reportId}`}
                      download="report.pdf"
                    >
                      Download email attachment
                    </Button>
                  </Stack>
                ))}
                {send.provider_email_id && (
                  <Text>Provider email ID: {send.provider_email_id}</Text>
                )}
                {send.error && <Alert color="red">{send.error}</Alert>}
              </Stack>
            ))}
            <Title order={3}>Tool calls</Title>
            {!run.calls?.length && <Text c="dimmed">No tool calls yet.</Text>}
            {run.calls?.map((call) => (
              <Accordion key={call.id} defaultValue={call.id}>
                <Accordion.Item value={call.id}>
                  <Accordion.Control>
                    <Group>
                      <Text>
                        {call.name}
                        {call.node_id ? ` · ${call.node_id}` : ""}
                      </Text>
                      <Badge color={statusColor(call.status)}>
                        {statusLabel(call.status)}
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="md">
                      <Text>Arguments</Text>
                      <Code block>{JSON.stringify(call.args, null, 2)}</Code>
                      <Text>Result</Text>
                      <Code block>{JSON.stringify(call.result, null, 2)}</Code>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            ))}
          </>
        )}
      </Stack>
    </Drawer>
  );
}
