import { readFileSync } from "node:fs";
import {
  retrieveEmail,
  inboundSchema,
  LocalStorage,
} from "../packages/connectors/src/index";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addOutcome,
  canConnect,
  receiptWorkflow,
  receiptTool,
  validateWorkflow,
  workflowSchema,
  type WorkflowNode,
} from "../packages/contracts/src/index";
import {
  renderEmailReply,
  mailbox,
  emailRetryWindowOpen,
  sendEmail,
} from "../packages/connectors/src/send-email";
import {
  boundedRequest,
  NetworkError,
} from "../packages/connectors/src/network";
import { settings } from "../packages/persistence/src/settings";
vi.mock("../packages/connectors/src/network", async (original) => ({
  ...(await original<object>()),
  boundedRequest: vi.fn(),
}));
const node: WorkflowNode = {
  id: "reply",
  type: "send_email",
  position: { x: 0, y: 0 },
  data: { label: "Send email", bodyTemplate: "Thanks {{steps.agent.text}}" },
};
const email = {
  id: "mail",
  from: '"Doe, Jane" <jane@example.com>',
  to: ["inbox@example.com"],
  subject: "Receipt",
  text: "Original",
  attachments: [],
};
const render = (data = node.data, mail = email) =>
  renderEmailReply({ ...node, data }, "inbox@example.com", mail, {
    agent: { text: "Jane" },
  });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe("terminal email contracts", () => {
  it("allows agents, actions and individual Outcome states to end in email, with no outputs or joins", () => {
    const w = addOutcome(structuredClone(receiptWorkflow), "agent", "outcome");
    w.nodes.push(node, {
      ...node,
      id: "action",
      type: "action",
      data: { label: "Action", toolId: receiptTool.id, arguments: {} },
    });
    for (const source of ["agent", "action", "outcome"]) {
      const edge = {
        id: "send",
        source,
        target: "reply",
        kind: "execution" as const,
        ...(source === "outcome" ? { stateId: "failure" } : {}),
      };
      const free = { ...w, edges: w.edges.filter((e) => e.source !== source) };
      expect(canConnect(free, edge)).toBe(true);
      expect(
        canConnect(
          { ...free, edges: [...free.edges, edge] },
          { ...edge, source: "action" },
        ),
      ).toBe(false);
    }
    expect(
      canConnect(w, {
        id: "out",
        source: "reply",
        target: "action",
        kind: "execution",
      }),
    ).toBe(false);
  });
  it("validates branch ancestry, malformed templates, required bodies and immutable schema fields without changing legacy workflows", () => {
    expect(validateWorkflow(receiptWorkflow, [receiptTool])).toEqual([]);
    const w = addOutcome(structuredClone(receiptWorkflow), "agent", "outcome");
    w.nodes.push({
      ...node,
      data: { ...node.data, bodyTemplate: "{{steps.agent.outcome.result}}" },
    });
    w.edges.push({
      id: "send",
      source: "outcome",
      target: "reply",
      kind: "execution",
      stateId: "failure",
    });
    expect(validateWorkflow(w, [receiptTool])).toEqual([]);
    expect(workflowSchema.parse(w)).toEqual(w);
    for (const bodyTemplate of [
      "",
      "  ",
      "{{steps.sibling.data}}",
      "{{steps.reply.text}}",
      "{{email.constructor}}",
      "{{email.text",
      "{{process.exit()}}",
    ])
      expect(
        validateWorkflow(
          {
            ...w,
            nodes: w.nodes.map((n) =>
              n.id === "reply"
                ? { ...n, data: { ...n.data, bodyTemplate } }
                : n,
            ),
          },
          [receiptTool],
        ).length,
      ).toBeGreaterThan(0);
  });
});
describe("reply rendering and Resend", () => {
  it("renders default/custom subjects, display names and legacy emails without headers", () => {
    expect(render()).toEqual({
      from: "inbox@example.com",
      to: ["jane@example.com"],
      subject: "Re: Receipt",
      text: "Thanks Jane",
    });
    expect(
      render(node.data, { ...email, subject: "re: Receipt" }).subject,
    ).toBe("re: Receipt");
    expect(
      render({ ...node.data, subjectTemplate: "Done: {{email.subject}}" })
        .subject,
    ).toBe("Done: Receipt");
    expect(mailbox("Jane Doe <jane@example.com>")).toBe("jane@example.com");
    expect(mailbox("jane@example.com")).toBe("jane@example.com");
    const threaded = renderEmailReply(
      node,
      "inbox@example.com",
      { ...email, messageId: "<original@example.com>" },
      { agent: { text: "Jane" } },
    );
    expect(threaded.headers).toEqual({
      "In-Reply-To": "<original@example.com>",
      References: "<original@example.com>",
    });
  });
  it("rejects empty resolved text, multiple recipients and header injection", () => {
    expect(() =>
      render(
        { ...node.data, bodyTemplate: "{{email.text}}" },
        { ...email, text: "  " },
      ),
    ).toThrow("empty");
    for (const from of [
      "a@example.com,b@example.com",
      "Jane <a@example.com> <b@example.com>",
      "a@example.com\r\nBcc: b@example.com",
      "not an address",
    ])
      expect(() => render(node.data, { ...email, from })).toThrow(
        "Email address",
      );
    expect(() =>
      render(
        { ...node.data, subjectTemplate: "{{email.text}}" },
        { ...email, text: "Hi\nBcc: x" },
      ),
    ).toThrow("subject");
    expect(() =>
      renderEmailReply(
        node,
        "inbox@example.com",
        { ...email, messageId: "<x@y>\nBcc: x" },
        { agent: { text: "ok" } },
      ),
    ).toThrow("message ID");
  });
  it("keeps bounded requests, the run signal and a stable idempotency header", async () => {
    settings.set("RESEND_API_KEY", "synthetic-key");
    vi.mocked(boundedRequest).mockResolvedValue({
      status: 200,
      body: Buffer.from('{"id":"provider-id"}'),
    });
    const signal = new AbortController().signal;
    expect(await sendEmail(render(), "stable-key", signal)).toEqual({
      ok: true,
      providerEmailId: "provider-id",
    });
    expect(boundedRequest).toHaveBeenCalledWith(
      new URL("https://api.resend.com/emails"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(render()),
        maxBytes: 65536,
        timeoutMs: 30000,
        signal,
        headers: expect.objectContaining({ "Idempotency-Key": "stable-key" }),
      }),
    );
  });
  it.each([
    [401, "authentication", false],
    [403, "domain", false],
    [422, "rejected", false],
    [429, "temporarily", true],
    [500, "temporarily", true],
    [409, "temporarily", true],
  ])("reports HTTP %s safely", async (status, message, retryable) => {
    settings.set("RESEND_API_KEY", "synthetic-key");
    vi.mocked(boundedRequest).mockResolvedValue({
      status: Number(status),
      body: Buffer.from("secret upstream details"),
    });
    const result = await sendEmail(render(), "key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(message);
      expect(!!result.retryable).toBe(retryable);
      expect(result.error).not.toContain("secret");
    }
  });
  it("treats interrupted or malformed acceptance as uncertain and missing credentials as definitive", async () => {
    settings.delete("RESEND_API_KEY");
    expect(await sendEmail(render(), "key")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Resend API key"),
    });
    expect(boundedRequest).not.toHaveBeenCalled();
    settings.set("RESEND_API_KEY", "synthetic");
    vi.mocked(boundedRequest).mockRejectedValue(
      new NetworkError("secret", true, true),
    );
    expect(await sendEmail(render(), "key")).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: true,
    });
    vi.mocked(boundedRequest).mockResolvedValue({
      status: 200,
      body: Buffer.from("invalid"),
    });
    expect(await sendEmail(render(), "key")).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: true,
    });
    expect(emailRetryWindowOpen(new Date(0), 86400000)).toBe(false);
    expect(emailRetryWindowOpen(new Date(0), 86400000 - 60000)).toBe(false);
    expect(emailRetryWindowOpen(null)).toBe(true);
  });
});

it("keeps migration timestamps ordered so upgrades apply every additive migration", () => {
  const journal = JSON.parse(
    readFileSync("packages/persistence/migrations/meta/_journal.json", "utf8"),
  );
  for (let i = 1; i < journal.entries.length; i++)
    expect(journal.entries[i].when).toBeGreaterThan(
      journal.entries[i - 1].when,
    );
});

it("retains Resend message_id in signed event parsing and retrieved email metadata", async () => {
  expect(
    inboundSchema.parse({
      type: "email.received",
      data: {
        email_id: "id",
        to: ["inbox@example.com"],
        message_id: "<original@example.com>",
      },
    }).data.message_id,
  ).toBe("<original@example.com>");
  settings.set("RESEND_API_KEY", "synthetic");
  const storage = new LocalStorage();
  const attachment = {
    id: "attachment",
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    size: 5,
    storageKey: "synthetic",
  };
  vi.spyOn(storage, "put").mockResolvedValue(attachment);
  vi.mocked(boundedRequest)
    .mockResolvedValueOnce({
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          ...email,
          message_id: "<original@example.com>",
          attachments: [
            {
              id: "attachment",
              filename: "receipt.pdf",
              content_type: "application/pdf",
              size: 5,
            },
          ],
        }),
      ),
    })
    .mockResolvedValueOnce({
      status: 200,
      body: Buffer.from('{"download_url":"https://example.com/receipt"}'),
    })
    .mockResolvedValueOnce({ status: 200, body: Buffer.from("%PDF-") });
  expect(await retrieveEmail("provider-id", "mail", storage)).toMatchObject({
    messageId: "<original@example.com>",
    attachments: [attachment],
  });
});

import {
  ReportStorage,
  reportChecksum,
} from "../packages/connectors/src/reports";
it("constructs Resend attachments from selected immutable bytes without persisting content or paths", async () => {
  vi.stubEnv("RESEND_API_KEY", "synthetic");
  settings.set("RESEND_API_KEY", "synthetic");
  const bytes = Buffer.from("%PDF-1.4 synthetic");
  const reference = {
    reportId: "11111111-1111-4111-8111-111111111111",
    nodeId: "agent",
    filename: "report.pdf" as const,
    checksum: reportChecksum(bytes),
    size: bytes.length,
    pageCount: 1,
  };
  const read = vi
    .spyOn(ReportStorage.prototype, "read")
    .mockResolvedValue(bytes);
  vi.mocked(boundedRequest).mockResolvedValue({
    status: 200,
    body: Buffer.from('{"id":"accepted"}'),
  });
  try {
    const message = { ...render(), attachments: [reference] };
    const before = JSON.stringify(message);
    expect((await sendEmail(message, "synthetic-idempotency")).ok).toBe(true);
    expect(read).toHaveBeenCalledWith(reference);
    const request = JSON.parse(
      vi.mocked(boundedRequest).mock.calls[0][1]!.body!,
    );
    expect(request.attachments).toEqual([
      {
        filename: "report.pdf",
        content: bytes.toString("base64"),
        content_type: "application/pdf",
      },
    ]);
    expect(JSON.stringify(message)).toBe(before);
    expect(request.attachments[0].reportId).toBeUndefined();
    read.mockRejectedValueOnce(new Error("corrupt"));
    expect(await sendEmail(message, "synthetic-idempotency")).toEqual({
      ok: false,
      error: "Email report file is missing or invalid",
    });
    expect(boundedRequest).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    settings.delete("RESEND_API_KEY");
  }
});
