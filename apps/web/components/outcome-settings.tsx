"use client";
import {
  Button,
  NativeSelect,
  Paper,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import {
  canConnect,
  updateOutcomeStates,
  type WorkflowNode,
} from "../../../packages/contracts/src/index";
import type { PlatformController } from "./use-platform";
export function OutcomeSettings({
  controller: c,
  node,
}: {
  controller: PlatformController;
  node: WorkflowNode;
}) {
  const { draft, update } = c;
  if (!draft) return null;
  return (
    <Stack gap="md">
      <NativeSelect
        label="Source agent"
        value={
          draft.edges.find(
            (e) => e.kind === "execution" && e.target === node.id,
          )?.source ?? ""
        }
        disabled
        data={[
          { value: "", label: "Disconnected" },
          ...draft.nodes
            .filter((n) => n.type === "agent")
            .map((n) => ({ value: n.id, label: n.data.label })),
        ]}
      />
      {(node.data.states ?? []).map((state, index, states) => (
        <Paper withBorder p="md" key={state.id}>
          <Stack gap="md">
            <TextInput
              label={`State ${index + 1} name`}
              value={state.name}
              onChange={(e) =>
                update(
                  updateOutcomeStates(
                    draft,
                    node.id,
                    states.map((s) =>
                      s.id === state.id ? { ...s, name: e.target.value } : s,
                    ),
                  ),
                )
              }
            />
            <Textarea
              label={`State ${index + 1} criteria`}
              value={state.criteria}
              onChange={(e) =>
                update(
                  updateOutcomeStates(
                    draft,
                    node.id,
                    states.map((s) =>
                      s.id === state.id
                        ? { ...s, criteria: e.target.value }
                        : s,
                    ),
                  ),
                )
              }
            />
            <NativeSelect
              label={`State ${index + 1} next step`}
              value={
                draft.edges.find(
                  (e) => e.source === node.id && e.stateId === state.id,
                )?.target ?? ""
              }
              data={[
                { value: "", label: "End execution" },
                ...draft.nodes
                  .filter((candidate) =>
                    canConnect(
                      {
                        ...draft,
                        edges: draft.edges.filter(
                          (edge) =>
                            !(
                              edge.kind === "execution" &&
                              edge.source === node.id &&
                              edge.stateId === state.id
                            ),
                        ),
                      },
                      {
                        id: "candidate",
                        source: node.id,
                        target: candidate.id,
                        kind: "execution",
                        stateId: state.id,
                      },
                    ),
                  )
                  .map((candidate) => ({
                    value: candidate.id,
                    label: candidate.data.label,
                  })),
              ]}
              onChange={(e) =>
                update({
                  ...draft,
                  edges: [
                    ...draft.edges.filter(
                      (edge) =>
                        !(edge.source === node.id && edge.stateId === state.id),
                    ),
                    ...(e.target.value
                      ? [
                          {
                            id: crypto.randomUUID(),
                            source: node.id,
                            target: e.target.value,
                            kind: "execution" as const,
                            stateId: state.id,
                          },
                        ]
                      : []),
                  ],
                })
              }
            />
            <Button
              variant="default"
              disabled={index === 0}
              onClick={() => {
                const next = [...states];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                update(updateOutcomeStates(draft, node.id, next));
              }}
            >
              Move state up
            </Button>
            <Button
              color="red"
              disabled={states.length === 1}
              onClick={() =>
                update(
                  updateOutcomeStates(
                    draft,
                    node.id,
                    states.filter((s) => s.id !== state.id),
                  ),
                )
              }
            >
              Remove state {index + 1}
            </Button>
          </Stack>
        </Paper>
      ))}
      <Button
        variant="default"
        disabled={(node.data.states?.length ?? 0) >= 20}
        onClick={() =>
          update(
            updateOutcomeStates(draft, node.id, [
              ...(node.data.states ?? []),
              {
                id: crypto.randomUUID(),
                name: "Custom state",
                criteria: "Describe when to select this state.",
              },
            ]),
          )
        }
      >
        Add state
      </Button>
    </Stack>
  );
}
