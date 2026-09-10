"use client";
import Link from "next/link";
import {
  Anchor,
  Button,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type { PlatformController } from "./use-platform";
export function WorkflowList({
  controller: c,
}: {
  controller: PlatformController;
}) {
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>Workflows</Title>
        <Button
          onClick={() => {
            c.setError("");
            c.setModal("workflow");
          }}
        >
          New workflow
        </Button>
      </Group>
      {c.data?.workflows.length ? (
        <ScrollArea>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Receiving address</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.data.workflows.map((workflow) => {
                const href = `/workflows/${workflow.id}`;
                return (
                  <Table.Tr key={workflow.id}>
                    <Table.Td>
                      <Anchor
                        component={Link}
                        href={href}
                        onNavigate={c.onNavigate(href)}
                      >
                        {workflow.draft.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      {workflow.draft.nodes.find(
                        (node) => node.type === "email",
                      )?.data.recipient || "—"}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        <Text>No workflows yet</Text>
      )}
    </Stack>
  );
}
