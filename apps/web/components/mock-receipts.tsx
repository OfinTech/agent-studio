"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Code,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
type MockReceipt = {
  key: string;
  id: string;
  receipt: unknown;
  created_at: string;
};
export function MockReceipts({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const [receipts, setReceipts] = useState<MockReceipt[]>();
  const load = useCallback(
    () =>
      api("mock/receipts")
        .then(setReceipts)
        .catch((error: Error) => c.setError(error.message)),
    [c],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>Mock receipts</Title>
        <Button variant="default" onClick={() => void load()}>
          Refresh
        </Button>
      </Group>
      <Text>
        Requests received at <Code>/api/mock/receipts</Code>, newest first.
      </Text>
      {receipts?.length ? (
        <ScrollArea>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Received</Table.Th>
                <Table.Th>Idempotency key</Table.Th>
                <Table.Th>Body</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {receipts.map((r) => (
                <Table.Tr key={r.key}>
                  <Table.Td>{new Date(r.created_at).toLocaleString()}</Table.Td>
                  <Table.Td>
                    <Code>{r.key}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Code block>{JSON.stringify(r.receipt, null, 2)}</Code>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        receipts && <Text>No receipts received yet.</Text>
      )}
    </Stack>
  );
}
