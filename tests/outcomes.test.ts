import { receiptWorkflow, receiptTool } from "../fixtures/receipt-workflow";
import { describe, it, expect } from "vitest";
import {
  addOutcome,
  connectedOutcome,
  defaultStates,
  completionInstructions,
  completionTool,
  parseCompletion,
  updateOutcomeStates,
  resolveArguments,
  validateWorkflow,
  workflowSchema,
  type Workflow,
} from "../packages/contracts/src/index";
function branching(): Workflow {
  const w = addOutcome(structuredClone(receiptWorkflow), "agent", "outcome");
  w.nodes.push({
    id: "action",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Action",
      toolId: receiptTool.id,
      arguments: {
        merchant: "{{steps.agent.outcome.result}}",
        total: 42,
        date: "2026-09-09",
        currency: "USD",
      },
    },
  });
  w.edges.push({
    id: "branch",
    source: "outcome",
    target: "action",
    kind: "execution",
    stateId: "success",
  });
  return w;
}
describe("configurable outcomes", () => {
  it("preserves legacy snapshots while accepting branch graphs and all providers", () => {
    expect(workflowSchema.parse(receiptWorkflow)).toEqual(receiptWorkflow);
    for (const provider of ["gemini", "claude", "openai"] as const) {
      const w = branching();
      w.nodes[2].data.provider = provider;
      w.nodes[2].data.credentialId = "key";
      expect(validateWorkflow(w, [receiptTool])).toEqual([]);
    }
  });
  it("reroutes an existing successor through Success, with a single Outcome per agent", () => {
    const w = structuredClone(receiptWorkflow);
    w.nodes.push({ ...structuredClone(w.nodes[2]), id: "second" });
    w.edges.push({
      id: "next",
      source: "agent",
      target: "second",
      kind: "execution",
    });
    const next = addOutcome(w, "agent", "outcome");
    expect(next.edges.find((e) => e.id === "next")).toMatchObject({
      source: "outcome",
      target: "second",
      stateId: "success",
    });
    expect(() => addOutcome(next, "agent", "another")).toThrow();
    expect(w.nodes).toHaveLength(5);
  });
  it("keeps state IDs and edges across renaming/reordering; removes a state's edge atomically", () => {
    const w = branching();
    const renamed = updateOutcomeStates(
      w,
      "outcome",
      defaultStates()
        .reverse()
        .map((s) => ({ ...s, name: s.name + " renamed" })),
    );
    expect(renamed.edges).toEqual(w.edges);
    const removed = updateOutcomeStates(renamed, "outcome", [
      defaultStates()[1],
    ]);
    expect(removed.edges.some((e) => e.id === "branch")).toBe(false);
  });
  it("generates instructions separately and validates complete reports including custom states", () => {
    const w = branching(),
      o = connectedOutcome(w, "agent")!;
    o.data.states!.push({
      id: "review",
      name: "Review",
      criteria: "Receipt is unreadable",
    });
    expect(completionInstructions(o)).toContain("review: Review");
    expect(completionTool(o).inputSchema.properties.state.enum).toContain(
      "review",
    );
    expect(
      parseCompletion({ state: "review", reason: "Unreadable", result: "" }, o),
    ).toEqual({
      state: "review",
      name: "Review",
      reason: "Unreadable",
      result: "",
    });
    for (const args of [
      { state: "Review", reason: "", result: "" },
      { state: "success" },
      { state: "success", reason: 1, result: "" },
      { state: "success", reason: "", result: "", extra: true },
      [],
    ])
      expect(() => parseCompletion(args, o)).toThrow();
    expect(w.nodes[2].data.systemPrompt).toBe(
      receiptWorkflow.nodes[2].data.systemPrompt,
    );
  });
  it("preserves whole-value JSON types, embeds text once, and rejects executable/inherited references", () => {
    const context = {
      steps: {
        a: {
          data: {
            n: 3,
            b: true,
            a: [1],
            o: { x: 2 },
            nil: null,
            s: "{{email.secret}}",
          },
        },
      },
    };
    expect(
      resolveArguments(
        {
          n: "{{steps.a.data.n}}",
          b: "{{steps.a.data.b}}",
          a: "{{steps.a.data.a}}",
          o: "{{steps.a.data.o}}",
          nil: "{{steps.a.data.nil}}",
          text: "value={{steps.a.data.n}}",
          s: "{{steps.a.data.s}}",
        },
        context,
      ),
    ).toEqual({
      n: 3,
      b: true,
      a: [1],
      o: { x: 2 },
      nil: null,
      text: "value=3",
      s: "{{email.secret}}",
    });
    for (const ref of [
      "{{steps.a.constructor}}",
      "{{steps.a.data.n + 1}}",
      "{{unknown}}",
    ])
      expect(() => resolveArguments(ref, context)).toThrow();
  });
  it("rejects invalid state edges, joins, duplicate states, cycles and unavailable branch references", () => {
    const mutations: ((w: Workflow) => void)[] = [
      (w) => {
        w.edges.at(-1)!.stateId = "unknown";
      },
      (w) => {
        w.edges.push({
          ...w.edges.at(-1)!,
          id: "duplicate",
          stateId: "failure",
        });
      },
      (w) => {
        w.nodes
          .find((n) => n.id === "outcome")!
          .data.states!.push(defaultStates()[0]);
      },
      (w) => {
        w.edges.push({
          id: "cycle",
          source: "action",
          target: "agent",
          kind: "execution",
        });
      },
      (w) => {
        w.nodes[2].data.userPrompt = "{{steps.action.data.secret}}";
      },
      (w) => {
        w.nodes.push({
          id: "other",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Other",
            toolId: receiptTool.id,
            arguments: { x: "{{steps.action.data}}" },
          },
        });
        w.edges.push({
          id: "other-edge",
          source: "outcome",
          target: "other",
          kind: "execution",
          stateId: "failure",
        });
      },
    ];
    for (const mutate of mutations) {
      const w = branching();
      mutate(w);
      expect(validateWorkflow(w, [receiptTool]).length).toBeGreaterThan(0);
    }
    expect(
      validateWorkflow(branching(), [
        { ...receiptTool, name: "finish_task" },
      ]).join(" "),
    ).toContain("reserved");
  });
  it("uses explicit reporting in place of required-tool completion, while disconnection restores legacy validation", () => {
    const w = branching();
    w.nodes[2].data.requiredTool = "missing";
    expect(validateWorkflow(w, [receiptTool])).toEqual([]);
    w.edges = w.edges.filter((e) => e.target !== "outcome");
    expect(connectedOutcome(w, "agent")).toBeUndefined();
    expect(validateWorkflow(w, [receiptTool]).join(" ")).toContain(
      "Required success tool",
    );
  });
});
