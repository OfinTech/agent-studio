import { afterEach, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../packages/providers/src/index";
import { claudeEvents, eventBytes } from "./helpers/claude-stream";

afterEach(() => vi.useRealTimers());
const tool = {
  type: "tool_use",
  id: "call",
  name: "write",
  input: { text: "complete arguments" },
};
function fixture(events = claudeEvents([tool]), delay = 0, hang = false) {
  let cancelled = false;
  const request = vi.fn(async (_url: unknown, options: RequestInit = {}) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(eventBytes(events[0]));
          const timer = setTimeout(() => {
            for (const event of events.slice(1))
              controller.enqueue(eventBytes(event));
            if (!hang) controller.close();
          }, delay);
          options.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              clearTimeout(timer);
              controller.error(new Error("aborted"));
            },
            { once: true },
          );
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_fixture",
        },
      },
    );
  });
  return {
    request,
    provider: new ClaudeProvider("synthetic", request),
    cancelled: () => cancelled,
  };
}
const infer = (
  provider: ClaudeProvider,
  signal = new AbortController().signal,
) => provider.infer([], { label: "Agent", model: "synthetic" }, [], signal);

it("streams beyond 60 seconds, accumulates split tool arguments and waits for message_stop", async () => {
  vi.useFakeTimers();
  const f = fixture(undefined, 61000);
  let complete = false;
  const promise = infer(f.provider).then((result) => {
    complete = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(60001);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect((await promise).parts?.[0].functionCall?.args).toEqual(tool.input);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.request.mock.calls[0][1]!.body as string).stream).toBe(
    true,
  );
});

it.each(["interrupted", "malformed", "error-after-200"])(
  "rejects %s streams without exposing partial tool calls",
  async (kind) => {
    let events = claudeEvents([tool]);
    if (kind === "interrupted") events = events.slice(0, -1);
    if (kind === "malformed")
      events = events.map((event) =>
        event.delta?.type === "input_json_delta"
          ? {
              ...event,
              delta: { type: "input_json_delta", partial_json: '{"text":' },
            }
          : event,
      );
    if (kind === "error-after-200")
      events = [
        ...events.slice(0, -1),
        {
          type: "error",
          error: { type: "overloaded_error", message: "SECRET raw upstream" },
        },
      ];
    const f = fixture(events);
    await expect(infer(f.provider)).rejects.toMatchObject({
      retryable: true,
      message: expect.stringMatching(/^Provider Claude stream interrupted/),
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  },
);

it("cancels stream consumption at 180 seconds without SDK retries", async () => {
  vi.useFakeTimers();
  const f = fixture(claudeEvents([tool]).slice(0, 2), 0, true);
  const result = expect(infer(f.provider)).rejects.toMatchObject({
    retryable: true,
    message: expect.stringContaining("timed out after 180 seconds"),
  });
  await vi.advanceTimersByTimeAsync(180001);
  await result;
  expect(f.cancelled()).toBe(true);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("propagates the remaining run deadline during stream consumption", async () => {
  const f = fixture(claudeEvents([tool]).slice(0, 2), 0, true);
  const controller = new AbortController();
  const result = expect(infer(f.provider, controller.signal)).rejects.toThrow(
    "run deadline",
  );
  await vi.waitFor(() => expect(f.request).toHaveBeenCalled());
  controller.abort(new Error("run deadline"));
  await result;
  expect(f.cancelled()).toBe(true);
});
