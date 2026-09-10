import { z } from "zod";
import { query, transaction } from "../../persistence/src/index";
import type { Message } from "../../providers/src/index";

const message = z.custom<Message>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
);
const nodeState = z.object({
  files: z.array(
    z.object({ name: z.string(), uri: z.string(), mimeType: z.string() }),
  ),
  // Provider continuation blocks are opaque and must survive recovery unchanged.
  messages: z.array(message),
  turn: z.number().int().nonnegative(),
  pending: message.optional(),
  successes: z.array(z.string()),
});
const checkpoint = z.object({
  version: z.literal(2),
  cursor: z.string().nullable(),
  nodes: z.record(nodeState),
  outputs: z.record(z.unknown()),
  legacyCalls: z.boolean().optional(),
});
export type NodeState = z.infer<typeof nodeState>;
export type Checkpoint = z.infer<typeof checkpoint>;
export function decodeCheckpoint(
  value: unknown,
  firstAgent: string,
): Checkpoint {
  if (value == null)
    return { version: 2, cursor: firstAgent, nodes: {}, outputs: {} };
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported checkpoint data");
  if ("version" in value) {
    if (value.version !== 2) throw new Error("Unsupported checkpoint version");
    const parsed = checkpoint.safeParse(value);
    if (!parsed.success) throw new Error("Unsupported checkpoint data");
    return parsed.data;
  }
  const legacy = nodeState.safeParse(value);
  if (!legacy.success) throw new Error("Unsupported checkpoint data");
  return {
    version: 2,
    cursor: firstAgent,
    nodes: { [firstAgent]: legacy.data },
    outputs: {},
    legacyCalls: true,
  };
}

export type CompletionDetails = {
  additionalStep?: { nodeId: string; output: unknown };
  emailAcceptance?: { providerEmailId: string | null };
};
export function checkpointWriter(
  runId: string,
  state: Checkpoint,
  afterCheckpoint?: (state: Checkpoint) => Promise<void>,
) {
  const notify = () => afterCheckpoint?.(structuredClone(state));
  return {
    async save() {
      await query(
        "INSERT INTO checkpoints(run_id,state) VALUES($1,$2) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state",
        [runId, JSON.stringify(state)],
      );
      await notify();
    },
    async complete(
      nodeId: string,
      output: unknown,
      successor: string | null,
      details: CompletionDetails = {},
    ) {
      const nextState: Checkpoint = {
        ...state,
        outputs: { ...state.outputs, [nodeId]: output },
        cursor: successor,
      };
      // Acceptance, step outputs and the cursor share one commit; failed writes cannot advance memory either.
      await transaction(async (client) => {
        if (details.emailAcceptance)
          await client.query(
            "UPDATE email_sends SET status='succeeded',provider_email_id=$3,error=NULL WHERE run_id=$1 AND node_id=$2",
            [runId, nodeId, details.emailAcceptance.providerEmailId],
          );
        for (const step of [
          { nodeId, output },
          ...(details.additionalStep ? [details.additionalStep] : []),
        ])
          await client.query(
            "INSERT INTO steps(id,run_id,node_id,status,output) VALUES($1,$2,$3,'succeeded',$4) ON CONFLICT(run_id,node_id) DO UPDATE SET status='succeeded',output=excluded.output",
            [
              runId + ":" + step.nodeId,
              runId,
              step.nodeId,
              JSON.stringify(step.output),
            ],
          );
        await client.query(
          "INSERT INTO checkpoints(run_id,state) VALUES($1,$2) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state",
          [runId, JSON.stringify(nextState)],
        );
      });
      Object.assign(state, nextState);
      await notify();
    },
  };
}
export type CompleteStep = ReturnType<typeof checkpointWriter>["complete"];

export function stateForNode(state: Checkpoint, nodeId: string): NodeState {
  if (!Object.hasOwn(state.nodes, nodeId)) {
    Object.defineProperty(state.nodes, nodeId, {
      value: { files: [], messages: [], turn: 0, successes: [] },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return state.nodes[nodeId];
}
