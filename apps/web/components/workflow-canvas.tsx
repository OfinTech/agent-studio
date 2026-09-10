"use client";
import { useState, useEffect } from "react";
import { Box, Group, Paper, Stack, Text, ThemeIcon } from "@mantine/core";
import { Mail, FileUp, Bot, Wrench, GitBranch, Play, Send } from "lucide-react";
import {
  ReactFlow,
  useUpdateNodeInternals,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeProps,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import {
  canConnect,
  type WorkflowNode,
} from "../../../packages/contracts/src/index";
import type { PlatformController } from "./use-platform";
import classes from "./workflow-canvas.module.css";
export const nodeIcons = {
  email: Mail,
  upload: FileUp,
  agent: Bot,
  tool: Wrench,
  outcome: GitBranch,
  action: Play,
  send_email: Send,
};
export const typeLabels = {
  email: "Email trigger",
  upload: "Attachment upload",
  agent: "AI agent",
  tool: "MCP tool",
  outcome: "Outcome",
  action: "Tool action",
  send_email: "Send email",
};
function FlowNode({ id, data, selected }: NodeProps) {
  const kind = data.kind as WorkflowNode["type"];
  const Icon = nodeIcons[kind];
  const updateNodeInternals = useUpdateNodeInternals();
  const states = data.states as WorkflowNode["data"]["states"];
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, states, updateNodeInternals]);
  return (
    <Paper
      withBorder
      p="md"
      className={selected ? classes.selectedNode : classes.node}
    >
      {kind !== "email" && kind !== "tool" && (
        <Handle type="target" position={Position.Left} id="in" />
      )}
      {kind === "agent" && (
        <Handle
          type="target"
          position={Position.Bottom}
          id="tools"
          className={classes.toolHandle}
        />
      )}
      <Stack gap="md">
        <Group gap="md">
          <ThemeIcon>
            <Icon size={19} />
          </ThemeIcon>
          <Text>{typeLabels[kind]}</Text>
        </Group>
        <Text>{String(data.label)}</Text>
        {Boolean(data.summary) && (
          <Text c="dimmed">{String(data.summary)}</Text>
        )}
      </Stack>
      {kind === "outcome" && (
        <Stack gap="md">
          {states?.map((state) => (
            <Box key={state.id} className={classes.outcomeState}>
              <Text>{state.name}</Text>
              <Handle
                type="source"
                position={Position.Right}
                id={state.id}
                aria-label={`${state.name} output`}
              />
            </Box>
          ))}
        </Stack>
      )}
      {kind !== "outcome" && kind !== "send_email" && (
        <Handle
          type="source"
          position={kind === "tool" ? Position.Top : Position.Right}
          id={kind === "tool" ? "tool" : "out"}
          className={kind === "tool" ? classes.toolHandle : undefined}
        />
      )}
    </Paper>
  );
}
const nodeTypes = { platform: FlowNode };
export function WorkflowCanvas({
  controller,
}: {
  controller: PlatformController;
}) {
  const {
    draft,
    data,
    selected,
    setSelected,
    update,
    canvasStates,
    workflowId,
  } = controller;
  const [initialCanvas] = useState(() => canvasStates.current[workflowId]);
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >(initialCanvas?.measurements ?? {});
  const flowNodes: Node[] =
    draft?.nodes.map((n) => ({
      ...n,
      type: "platform",
      measured: measurements[n.id],
      selected: n.id === selected,
      data: {
        ...n.data,
        kind: n.type,
        summary:
          n.type === "email"
            ? n.data.recipient
            : n.type === "upload"
              ? n.data.mimeTypes
                  ?.map((mime) => mime.split("/")[1].toUpperCase())
                  .join(" · ") || "No attachment types"
              : n.type === "agent"
                ? n.data.provider === "mock"
                  ? "Mock"
                  : n.data.model
                : n.type === "send_email"
                  ? "Reply to original sender"
                  : n.type === "outcome"
                    ? undefined
                    : (data?.tools.find((t) => t.id === n.data.toolId)?.name ??
                      "Choose a tool"),
      },
    })) ?? [];
  const flowEdges: Edge[] =
    draft?.edges.map((e) => ({
      ...e,
      sourceHandle: e.kind === "tool" ? "tool" : (e.stateId ?? "out"),
      targetHandle: e.kind === "tool" ? "tools" : "in",
      type: "smoothstep",
      className: e.kind === "tool" ? classes.toolEdge : classes.executionEdge,
      label: e.kind === "tool" ? "tool connection" : undefined,
    })) ?? [];
  function connect(connection: Connection) {
    if (!draft) return;
    const source = draft.nodes.find((n) => n.id === connection.source);
    const kind = source?.type === "tool" ? "tool" : "execution";
    if (
      draft.edges.some(
        (e) =>
          e.source === connection.source &&
          e.target === connection.target &&
          e.stateId ===
            (source?.type === "outcome" ? connection.sourceHandle : undefined),
      )
    )
      return;
    update({
      ...draft,
      edges: [
        ...draft.edges,
        {
          id: crypto.randomUUID(),
          source: connection.source!,
          target: connection.target!,
          kind,
          ...(source?.type === "outcome"
            ? { stateId: connection.sourceHandle! }
            : {}),
        },
      ],
    });
  }

  if (!draft) return null;
  return (
    <Box className={classes.canvas} data-testid="workflow-canvas">
      <ReactFlow
        colorMode="dark"
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => {
          const dimensions = changes.filter((c) => c.type === "dimensions");
          if (dimensions.length)
            setMeasurements((previous) => {
              const next = { ...previous };
              let changed = false;
              for (const change of dimensions)
                if (
                  change.dimensions &&
                  (previous[change.id]?.width !== change.dimensions.width ||
                    previous[change.id]?.height !== change.dimensions.height)
                ) {
                  next[change.id] = change.dimensions;
                  changed = true;
                }
              canvasStates.current[workflowId] = {
                ...canvasStates.current[workflowId],
                measurements: changed ? next : previous,
              };
              return changed ? next : previous;
            });
          if (
            changes.every((c) => c.type === "select" || c.type === "dimensions")
          )
            return;
          const next = applyNodeChanges(changes, flowNodes);
          update({
            ...draft,
            nodes: next.map((n) => ({
              ...draft.nodes.find((old) => old.id === n.id)!,
              position: n.position,
            })),
            edges: draft.edges.filter(
              (e) =>
                next.some((n) => n.id === e.source) &&
                next.some((n) => n.id === e.target),
            ),
          });
        }}
        onEdgesChange={(changes) => {
          if (changes.every((c) => c.type === "select")) return;
          const next = applyEdgeChanges(changes, flowEdges);
          update({
            ...draft,
            edges: draft.edges.filter((e) => next.some((n) => n.id === e.id)),
          });
        }}
        onConnect={connect}
        isValidConnection={(c) =>
          canConnect(draft, {
            id: "candidate",
            source: c.source!,
            target: c.target!,
            kind: c.sourceHandle === "tool" ? "tool" : "execution",
            ...(draft.nodes.find((n) => n.id === c.source)?.type === "outcome"
              ? { stateId: c.sourceHandle! }
              : {}),
          })
        }
        onNodeClick={(event, n) => {
          if (event.currentTarget instanceof HTMLElement)
            event.currentTarget.focus();
          setSelected(n.id);
        }}
        onPaneClick={() => setSelected(undefined)}
        defaultViewport={initialCanvas?.viewport}
        onViewportChange={(viewport) => {
          canvasStates.current[workflowId] = { measurements, viewport };
        }}
        fitView={!initialCanvas?.viewport}
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.15}
        maxZoom={1.6}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}
