import { z } from "zod";
import type { ReplyEnvelope, EmailMessage } from "../../contracts/src/index";
import { mailbox, renderEmailReply } from "./send-email";

export function validateReplyEnvelope(value: unknown): ReplyEnvelope | null {
  const parsed = z
    .object({
      from: z.string().max(1000),
      subject: z.string().max(998),
      messageId: z.string().max(998).optional(),
      headers: z.record(z.string().max(2000)).optional(),
    })
    .safeParse(value);
  if (!parsed.success) return null;
  try {
    mailbox(parsed.data.from);
    // Reuse the reply header validation before freezing a destination.
    renderEmailReply(
      { data: { bodyTemplate: "System notice" } } as never,
      "validation@example.com",
      { ...parsed.data, id: "", to: [], text: "", attachments: [] },
      {},
    );
    return parsed.data;
  } catch {
    return null;
  }
}

export function noticeSuppression(
  envelope: ReplyEnvelope,
  from: string,
): string | null {
  const sender = mailbox(envelope.from).toLowerCase();
  if (sender === mailbox(from).toLowerCase()) return "Self-reply";
  const headers = Object.fromEntries(
    Object.entries(envelope.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value.trim().toLowerCase(),
    ]),
  );
  if (
    (headers["auto-submitted"] && headers["auto-submitted"] !== "no") ||
    /^(bulk|list|junk)$/.test(headers.precedence ?? "") ||
    headers["list-id"] ||
    headers["x-auto-response-suppress"] ||
    /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)([+._-]|@)/.test(
      sender,
    )
  )
    return "Automatic message";
  return null;
}

export function systemNoticeMessage(
  runId: string,
  from: string,
  envelope: ReplyEnvelope,
  failure: string,
): EmailMessage {
  const explanation = /deadline/i.test(failure)
    ? "The workflow reached its execution time limit. Try a shorter brief or fewer attachments."
    : /attachment/i.test(failure)
      ? "The workflow could not process the attachments. Check that the files are valid, supported, and within the size limit."
      : /timed out|retry|temporar|stream/i.test(failure)
        ? "A required service did not complete the request. Please try again later."
        : /Provider /i.test(failure)
          ? "The AI service could not process the request. Please contact the workflow administrator."
          : "The workflow could not complete the request. Please contact the workflow administrator.";
  // Fixed text; never interpolate untrusted content as a template.
  const message = renderEmailReply(
    {
      data: {
        bodyTemplate: `We could not complete your request because of a system error.\n\n${explanation}\n\nRun ID: ${runId}`,
      },
    } as never,
    from,
    { ...envelope, id: "", to: [], text: "", attachments: [] },
    {},
  );
  message.headers = { ...message.headers, "Auto-Submitted": "auto-replied" };
  return message;
}
