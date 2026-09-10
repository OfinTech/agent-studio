import { describe, it, expect, vi, beforeEach } from "vitest";
import { pool, transaction } from "../packages/persistence/src/index";
import { withRunLock } from "../packages/runtime/src/run-lifecycle";
import {
  checkpointWriter,
  decodeCheckpoint,
  stateForNode,
} from "../packages/runtime/src/checkpoint";
vi.mock("../packages/persistence/src/index", () => ({
  pool: { connect: vi.fn() },
  query: vi.fn(),
  transaction: vi.fn(),
}));
const client = { query: vi.fn(), release: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(pool.connect).mockResolvedValue(client as never);
  client.query.mockResolvedValue({ rows: [{ acquired: true }] });
});
describe("run lock lifetime", () => {
  it("releases the lock when execution fails", async () => {
    const failure = new Error("execution failed");
    await expect(
      withRunLock("run", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      ["run"],
    );
    expect(client.release).toHaveBeenCalledWith(false);
  });
  it("releases a failed acquisition and discards failed unlock connections", async () => {
    client.query.mockRejectedValueOnce(new Error("connection lost"));
    await expect(withRunLock("run", async () => {})).rejects.toThrow(
      "connection lost",
    );
    expect(client.release).toHaveBeenCalledWith(true);
    client.release.mockClear();
    client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    await expect(withRunLock("run", async () => "committed")).resolves.toBe(
      "committed",
    );
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it("never executes when another worker owns the lock", async () => {
    client.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const execute = vi.fn();
    await expect(withRunLock("run", execute)).rejects.toThrow(
      "already executing",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(false);
  });
});
describe("checkpoint boundaries", () => {
  it("decodes legacy state and retains opaque provider continuation blocks", () => {
    const legacy = {
      files: [],
      messages: [
        {
          role: "model",
          continuation: {
            provider: "claude",
            blocks: [
              { type: "thinking", signature: "opaque", future_field: true },
            ],
          },
        },
      ],
      turn: 1,
      successes: [],
    };
    const state = decodeCheckpoint(legacy, "agent");
    expect(state.nodes.agent).toEqual(legacy);
    expect(state.legacyCalls).toBe(true);
    expect(decodeCheckpoint(state, "agent")).toEqual(state);
  });
  it("rejects malformed state rather than mistaking it for completed execution", () => {
    for (const state of [
      [],
      "bad",
      { version: 3 },
      { version: 2, cursor: null },
      { version: 2, cursor: 0, nodes: {}, outputs: {} },
      { version: 2, cursor: null, nodes: { agent: {} }, outputs: {} },
    ])
      expect(() => decodeCheckpoint(state, "agent")).toThrow(
        "Unsupported checkpoint",
      );
  });
  it("does not advance the in-memory cursor when its transaction fails", async () => {
    const state = decodeCheckpoint(undefined, "agent");
    vi.mocked(transaction).mockRejectedValue(new Error("rollback"));
    await expect(
      checkpointWriter("run", state).complete("agent", { text: "done" }, null),
    ).rejects.toThrow("rollback");
    expect(state.cursor).toBe("agent");
    expect(state.outputs).toEqual({});
  });
  it("creates own node state even when an ID matches an Object property", () => {
    const state = decodeCheckpoint(undefined, "toString");
    expect(stateForNode(state, "toString")).toEqual({
      files: [],
      messages: [],
      turn: 0,
      successes: [],
    });
    expect(Object.hasOwn(state.nodes, "toString")).toBe(true);
  });
});
