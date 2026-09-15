import { receiptWorkflow, receiptTool } from "../fixtures/receipt-workflow";
import { describe, it, expect } from "vitest";
import {
  validateWorkflow,
  renderPrompt,
  getPath,
  workflowSchema,
} from "../packages/contracts/src/index";
describe("workflow contracts", () => {
  it("validates the receipt workflow", () =>
    expect(
      validateWorkflow(workflowSchema.parse(receiptWorkflow), [receiptTool]),
    ).toEqual([]));
  it("rejects branches, cycles, missing nodes and malformed tool connections", () => {
    const branch = structuredClone(receiptWorkflow);
    branch.edges.push({
      id: "branch",
      source: "email",
      target: "agent",
      kind: "execution",
    });
    expect(validateWorkflow(branch, [receiptTool]).join(" ")).toMatch(
      /Branching/,
    );
    const cycle = structuredClone(receiptWorkflow);
    cycle.edges.push({
      id: "cycle",
      source: "agent",
      target: "email",
      kind: "execution",
    });
    expect(validateWorkflow(cycle, [receiptTool]).length).toBeGreaterThan(0);
    const malformed = structuredClone(receiptWorkflow);
    malformed.edges[2].target = "upload";
    expect(validateWorkflow(malformed, [receiptTool]).join(" ")).toMatch(
      /Tool connections/,
    );
    expect(
      validateWorkflow(
        { ...receiptWorkflow, nodes: receiptWorkflow.nodes.slice(1) },
        [receiptTool],
      ).length,
    ).toBeGreaterThan(0);
  });
  it("requires a connected tool for the success condition", () =>
    expect(
      validateWorkflow(
        { ...receiptWorkflow, edges: receiptWorkflow.edges.slice(0, 2) },
        [receiptTool],
      ).join(" "),
    ).toMatch(/Required success tool/));
  it("substitutes email and previous outputs once, without evaluating input", () =>
    expect(
      renderPrompt("{{email.text}} / {{steps.upload-123.count}}", {
        email: { text: "{{credentials.secret}}" },
        steps: { "upload-123": { count: 2 } },
      }),
    ).toBe("{{credentials.secret}} / 2"));
  it("fails closed for unknown and inherited variables", () => {
    expect(() => renderPrompt("{{credentials.key}}", { email: {} })).toThrow(
      /Unknown/,
    );
    expect(getPath({}, "constructor")).toBeUndefined();
    expect(getPath({}, "__proto__.secret")).toBeUndefined();
  });
  it("validates action result references against known fields and dynamic data", () => {
    const workflow = structuredClone(receiptWorkflow);
    workflow.nodes.push(
      {
        id: "action",
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: "Action", toolId: receiptTool.id, arguments: {} },
      },
      {
        id: "reply",
        type: "send_email",
        position: { x: 0, y: 0 },
        data: {
          label: "Reply",
          bodyTemplate:
            "{{steps.action.data.nested.result}} / {{steps.action.ok}}",
        },
      },
    );
    workflow.edges.push(
      { id: "action", kind: "execution", source: "agent", target: "action" },
      { id: "reply", kind: "execution", source: "action", target: "reply" },
    );
    expect(validateWorkflow(workflow, [receiptTool])).toEqual([]);
    workflow.nodes.at(-1)!.data.bodyTemplate = "{{steps.action.nonexistent}}";
    expect(validateWorkflow(workflow, [receiptTool]).join(" ")).toContain(
      "Unknown prompt variable",
    );
  });
});
