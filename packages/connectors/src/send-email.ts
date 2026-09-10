import { z } from "zod";
import {
  renderPrompt,
  hasHeaderControls,
  type Email,
  type EmailMessage,
  type WorkflowNode,
} from "../../contracts/src/index";
import { boundedRequest, NetworkError } from "./network";

export type { EmailMessage } from "../../contracts/src/index";
export type EmailSendResult =
  | { ok: true; providerEmailId: string }
  | { ok: false; error: string; retryable?: boolean; ambiguous?: boolean };

export function mailbox(value: string): string {
  if (typeof value !== "string" || hasHeaderControls(value))
    throw new Error("Email address contains invalid characters");
  const match = /^(?:"(?:[^"\\]|\\.)*"|[^<>";,]+)?\s*<([^<>]+)>$/.exec(
    value.trim(),
  );
  const address = (match?.[1] ?? value).trim();
  if (!z.string().email().max(254).safeParse(address).success)
    throw new Error("Email address must contain one valid mailbox");
  return address;
}
export function renderEmailReply(
  node: WorkflowNode,
  from: string,
  email: Email,
  outputs: Record<string, unknown>,
): EmailMessage {
  const context = { email, steps: outputs };
  const text = renderPrompt(node.data.bodyTemplate ?? "", context);
  const subject = node.data.subjectTemplate?.trim()
    ? renderPrompt(node.data.subjectTemplate, context)
    : /^re:/i.test(email.subject.trim())
      ? email.subject.trim()
      : `Re: ${email.subject}`;
  if (!text.trim()) throw new Error("Email body resolved to empty text");
  if (!subject.trim() || subject.length > 998 || hasHeaderControls(subject))
    throw new Error(
      "Email subject must be nonempty and contain no control characters (maximum 998 characters)",
    );
  if (
    email.messageId !== undefined &&
    (email.messageId.length > 998 ||
      !/^<[^<>\s@]+@[^<>\s@]+>$/.test(email.messageId) ||
      hasHeaderControls(email.messageId))
  )
    throw new Error(
      "Email message ID is invalid; reply headers cannot be sent",
    );
  return {
    from: mailbox(from),
    to: [mailbox(email.from)],
    subject,
    text,
    ...(email.messageId
      ? {
          headers: {
            "In-Reply-To": email.messageId,
            References: email.messageId,
          },
        }
      : {}),
  };
}

// Leave a full request timeout of margin before Resend's 24-hour key expiry.
export function emailRetryWindowOpen(
  firstAttempt: Date | string | null,
  now = Date.now(),
) {
  return (
    firstAttempt === null ||
    now - new Date(firstAttempt).getTime() < 86400000 - 60000
  );
}
export async function sendEmail(
  message: EmailMessage,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<EmailSendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key)
    return { ok: false, error: "Email sending requires RESEND_API_KEY" };
  try {
    const response = await boundedRequest(
      new URL("https://api.resend.com/emails"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(message),
        maxBytes: 65536,
        timeoutMs: 30000,
        signal,
      },
    );
    if (response.status >= 200 && response.status < 300) {
      let data;
      try {
        data = JSON.parse(response.body.toString());
      } catch {
        /* Acceptance cannot be confirmed. */
      }
      if (typeof data?.id === "string" && /^[\w-]{1,200}$/.test(data.id))
        return { ok: true, providerEmailId: data.id };
      return {
        ok: false,
        ambiguous: true,
        retryable: true,
        error: "Email acceptance response was invalid; retry with the same key",
      };
    }
    if (response.status === 401)
      return {
        ok: false,
        error: "Email authentication failed; check RESEND_API_KEY",
      };
    if (response.status === 403)
      return {
        ok: false,
        error:
          "Email sending forbidden; verify the trigger inbox domain and RESEND_API_KEY sending permissions",
      };
    if (
      response.status === 429 ||
      response.status >= 500 ||
      response.status === 409
    )
      return {
        ok: false,
        retryable: true,
        ambiguous: response.status !== 429,
        error: `Email provider temporarily unavailable (HTTP ${response.status}); retry with the same key`,
      };
    return {
      ok: false,
      error: `Email rejected by Resend (HTTP ${response.status}); check the sender domain, addresses and message configuration`,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      ambiguous: !(error instanceof NetworkError) || error.ambiguous,
      error: "Email connection failed; retry with the same key",
    };
  }
}
