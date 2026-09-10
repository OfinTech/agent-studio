"use client";
import Link from "next/link";
import { useState } from "react";
import { connectedOutcome } from "../../../packages/contracts/src/index";
import {
  Anchor,
  Button,
  Drawer,
  Box,
  Flex,
  Group,
  Menu,
  Modal,
  NativeSelect,
  ScrollArea,
  Stack,
  Title,
  useMatches,
} from "@mantine/core";
import { Plus, Play, Save } from "lucide-react";
import { api } from "./platform-types";
import type { PlatformController } from "./use-platform";
import { WorkflowCanvas, nodeIcons } from "./workflow-canvas";
import { NodeSettings } from "./node-settings";
export function WorkflowEditor({
  controller: c,
}: {
  controller: PlatformController;
}) {
  const [addingOutcome, setAddingOutcome] = useState(false);
  const [sourceAgent, setSourceAgent] = useState("");
  const desktop = useMatches({ base: false, md: true });
  const {
    draft,
    dirty,
    busy,
    record,
    workflowId,
    action,
    save,
    refresh,
    setNotice,
  } = c;
  if (!record || !draft)
    return (
      <Stack gap="md">
        <Title order={1}>Workflow not found</Title>
        <Anchor
          component={Link}
          href="/workflows"
          onNavigate={c.onNavigate("/workflows")}
        >
          Workflows
        </Anchor>
      </Stack>
    );
  return (
    <Stack gap="md" flex={1} mih={0}>
      <Group justify="space-between" flex="0 0 auto">
        <Title order={1}>{draft.name}</Title>
        <Group gap="md">
          <Menu>
            <Menu.Target>
              <Button
                variant="default"
                leftSection={<Plus size={16} />}
                disabled={busy}
              >
                Add step
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {(
                [
                  "email",
                  "upload",
                  "agent",
                  "tool",
                  "action",
                  "send_email",
                  "outcome",
                ] as const
              ).map((type) => {
                const Icon = nodeIcons[type];
                return (
                  <Menu.Item
                    key={type}
                    leftSection={<Icon size={16} />}
                    onClick={() => {
                      if (type === "outcome") {
                        setSourceAgent("");
                        setAddingOutcome(true);
                      } else c.addNode(type);
                    }}
                  >
                    {type === "tool"
                      ? "MCP tool"
                      : type === "action"
                        ? "Tool action"
                        : type === "send_email"
                          ? "Send email"
                          : type[0].toUpperCase() + type.slice(1)}
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => c.setModal("workflow-settings")}
          >
            Workflow settings
          </Button>
          <Button
            variant="default"
            leftSection={<Save size={16} />}
            loading={c.busyAction === "save"}
            disabled={busy || !dirty}
            onClick={() =>
              void action(async () => {
                await save();
                setNotice("Saved");
              }, "save")
            }
          >
            Save
          </Button>
          <Button
            variant="default"
            leftSection={<Play size={16} />}
            loading={c.busyAction === "test"}
            disabled={busy || !record.published_version || dirty}
            onClick={(event) => {
              c.runTrigger.current = event.currentTarget;
              void action(async () => {
                const result = await api(
                  `workflows/${workflowId}/test`,
                  "POST",
                );
                c.setRun(undefined);
                c.setRunId(result.id);
              }, "test");
            }}
          >
            Test run
          </Button>
          <Button
            loading={c.busyAction === "publish"}
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await save();
                const version = await api(
                  `workflows/${workflowId}/publish`,
                  "POST",
                );
                await refresh();
                setNotice(`Published v${version.number}`);
              }, "publish")
            }
          >
            Publish
          </Button>
        </Group>
      </Group>
      <Flex gap="md" flex={1} mih={0}>
        <Box flex={3} miw={0} h="100%">
          <WorkflowCanvas key={workflowId} controller={c} />
        </Box>
        {desktop && c.selectedNode && (
          <Box flex={1} miw={0} h="100%">
            <ScrollArea
              key={c.selectedNode.id}
              h="100%"
              scrollbars="y"
              type="auto"
              offsetScrollbars="present"
              overscrollBehavior="contain"
              viewportProps={{
                role: "region",
                "aria-label": "Step settings",
                tabIndex: 0,
              }}
            >
              <NodeSettings controller={c} />
            </ScrollArea>
          </Box>
        )}
      </Flex>
      <Modal
        opened={addingOutcome}
        onClose={() => setAddingOutcome(false)}
        title="Add outcome"
      >
        <Stack gap="md">
          <NativeSelect
            label="Source agent"
            data-autofocus
            value={sourceAgent}
            onChange={(e) => setSourceAgent(e.target.value)}
            data={[
              { value: "", label: "Choose an agent" },
              ...draft.nodes
                .filter(
                  (n) => n.type === "agent" && !connectedOutcome(draft, n.id),
                )
                .map((n) => ({ value: n.id, label: n.data.label })),
            ]}
          />
          <Button
            disabled={!sourceAgent}
            onClick={() => {
              c.addOutcome(sourceAgent);
              setAddingOutcome(false);
            }}
          >
            Add outcome
          </Button>
        </Stack>
      </Modal>
      <Drawer
        opened={!desktop && Boolean(c.selectedNode)}
        onClose={() => c.setSelected(undefined)}
        position="right"
        title="Step settings"
        closeButtonProps={{ "aria-label": "Close settings" }}
      >
        <NodeSettings controller={c} inDrawer />
      </Drawer>
    </Stack>
  );
}
