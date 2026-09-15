export function claudeEvents(blocks: Record<string, any>[], stop = "tool_use") {
  const events: Record<string, any>[] = [
    {
      type: "message_start",
      message: {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "synthetic",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ];
  for (const [index, block] of blocks.entries()) {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use" ? { ...block, input: {} } : block,
    });
    if (block.type === "tool_use") {
      const value = JSON.stringify(block.input);
      for (const partial_json of [value.slice(0, 7), value.slice(7)])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json },
        });
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  );
  return events;
}
export const eventBytes = (event: Record<string, any>) =>
  new TextEncoder().encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
export function claudeResponse(
  blocks: Record<string, any>[],
  stop = "tool_use",
) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of claudeEvents(blocks, stop))
          controller.enqueue(eventBytes(event));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "request-id": "req_synthetic",
      },
    },
  );
}
