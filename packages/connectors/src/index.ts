import { Webhook } from "svix";
import { z } from "zod";
import type { Email, Attachment } from "../../contracts/src/index";
import { boundedRequest, NetworkError } from "./network";
import { LocalStorage } from "./storage";
export { LocalStorage, validateAttachment } from "./storage";
export const inboundSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.string().min(1).max(200),
    message_id: z.string().max(998).optional(),
    to: z.array(z.string()).min(1),
    from: z.string().optional(),
    subject: z.string().optional(),
  }),
});
export function verifyWebhook(body: string, headers: Record<string, string>) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new Error("Inbound webhook is not configured");
  return inboundSchema.parse(new Webhook(secret).verify(body, headers));
}
async function resend(path: string, signal?: AbortSignal) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Resend is not configured");
  const result = await boundedRequest(
    new URL("https://api.resend.com" + path),
    {
      headers: { Authorization: `Bearer ${key}` },
      maxBytes: 2 * 1024 * 1024,
      signal,
    },
  );
  if (result.status !== 200)
    throw new NetworkError(
      "Email retrieval failed",
      false,
      result.status === 429 || result.status >= 500,
    );
  return JSON.parse(result.body.toString());
}
export async function retrieveEmail(
  providerId: string,
  id: string,
  storage = new LocalStorage(),
  signal?: AbortSignal,
): Promise<Email> {
  const mail = await resend(
    `/emails/receiving/${encodeURIComponent(providerId)}`,
    signal,
  );
  const attachments: Attachment[] = [];
  const limit = Number(process.env.MAX_ATTACHMENT_BYTES ?? 20971520);
  let total = 0;
  for (const file of mail.attachments ?? []) {
    signal?.throwIfAborted();
    if (
      !["application/pdf", "image/jpeg", "image/png"].includes(
        file.content_type,
      )
    )
      throw new Error("Email has an unsupported attachment type");
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      total + file.size > limit
    )
      throw new Error("Email attachments exceed the size limit");
    const metadata = await resend(
      `/emails/receiving/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(file.id)}`,
      signal,
    );
    const url = new URL(metadata.download_url);
    if (url.protocol !== "https:")
      throw new Error("Attachment download requires HTTPS");
    const response = await boundedRequest(url, {
      maxBytes: limit - total,
      signal,
    });
    if (response.status !== 200)
      throw new NetworkError(
        "Attachment download failed",
        false,
        response.status >= 500 || response.status === 429,
      );
    total += response.body.length;
    if (total > limit)
      throw new Error("Email attachments exceed the size limit");
    attachments.push(
      await storage.put(
        id,
        file.id,
        file.filename ?? "attachment",
        file.content_type,
        response.body,
      ),
    );
  }
  if (!attachments.length)
    throw new Error("Email contains no supported attachments");
  return {
    id,
    from: mail.from,
    ...(mail.message_id ? { messageId: mail.message_id } : {}),
    to: mail.to,
    subject: mail.subject ?? "",
    text: mail.text ?? mail.html ?? "",
    attachments,
  };
}
export async function syntheticEmail(
  id: string,
  storage = new LocalStorage(),
): Promise<Email> {
  const content =
    "Receipt\nMerchant: Paper & Pine\nDate: 2026-09-09\nCurrency: USD\nTotal: 42.50\nTax: 2.50";
  // Minimal valid single-page PDF, usable by Gemini as well as the mock adapter.
  const stream =
    "BT /F1 14 Tf 50 760 Td " +
    content
      .split("\n")
      .map((line, i) => `${i ? "0 -24 Td " : ""}(${line}) Tj`)
      .join(" ") +
    " ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, o] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const attachment = await storage.put(
    id,
    "receipt",
    "receipt.pdf",
    "application/pdf",
    Buffer.from(pdf),
  );
  return {
    id,
    from: "receipts@paperandpine.example",
    to: ["receipts@example.com"],
    subject: "Your Paper & Pine receipt",
    text: content,
    attachments: [attachment],
  };
}
