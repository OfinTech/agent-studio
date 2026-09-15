import { z } from "zod";
import type { Workflow, WorkflowNode } from "./index";

export const LEGACY_TEMPLATE_PROFILE = "tectonic-0.15.0-bundle33-template-v2";
export const TEMPLATE_PROFILE = "tectonic-0.15.0-bundle33-template-v3";
export const TEMPLATE_PROFILES = [
  LEGACY_TEMPLATE_PROFILE,
  TEMPLATE_PROFILE,
] as const;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGES_MAX_BYTES = 20 * 1024 * 1024;
export const imageResourceSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(png|jpg)$/),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(IMAGE_MAX_BYTES),
});
export type ImageResource = z.infer<typeof imageResourceSchema>;
export const imageResourcesSchema = z
  .array(imageResourceSchema)
  .max(10)
  .refine(
    (images) =>
      images.reduce((n, image) => n + image.size, 0) <= IMAGES_MAX_BYTES,
    "Template images exceed 20 MiB",
  )
  .refine(
    (images) =>
      new Set(images.map((image) => image.filename)).size === images.length,
    "Duplicate image filenames",
  );
export const pdfTemplateSchema = z.object({
  toolName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  description: z.string().min(1).max(2000),
  source: z.string().max(131072),
  placeholders: z.record(z.string().max(2000)).default({}),
  images: imageResourcesSchema.default([]),
});
export type PdfTemplate = z.infer<typeof pdfTemplateSchema>;
export function detectPlaceholders(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/<<([\s\S]*?)>>/g)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(match[1]))
      throw new Error(
        "Placeholder names must be valid identifiers: <<section_name>>.",
      );
    names.add(match[1]);
  }
  if (/<<|>>/.test(source.replace(/<<[\s\S]*?>>/g, "")))
    throw new Error("Unclosed placeholder marker.");
  return [...names];
}
export function templateTool(template: PdfTemplate) {
  const names = detectPlaceholders(template.source);
  return {
    name: template.toolName,
    description: template.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: names,
      properties: Object.fromEntries(
        names.map((name) => [
          name,
          {
            type: "string",
            description: template.placeholders[name] ?? "",
          },
        ]),
      ),
    },
  };
}
export function renderTemplate(template: PdfTemplate, args: unknown) {
  const names = detectPlaceholders(template.source);
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).length !== names.length ||
    names.some(
      (name) =>
        !Object.hasOwn(args, name) ||
        typeof (args as Record<string, unknown>)[name] !== "string",
    )
  )
    throw new Error(
      "Provide exactly the required template parameters as strings; empty strings are allowed.",
    );
  // One pass over the original template; inserted LaTeX is never interpreted again.
  return template.source.replace(
    /<<([\s\S]*?)>>/g,
    (_, name: string) => (args as Record<string, string>)[name],
  );
}
export function attachedTemplates(
  workflow: Workflow,
  agentId: string,
): WorkflowNode[] {
  const ids = workflow.edges
    .filter((edge) => edge.kind === "tool" && edge.target === agentId)
    .map((edge) => edge.source);
  return workflow.nodes.filter(
    (node) => node.type === "pdf_template" && ids.includes(node.id),
  );
}
export const templateInstructions =
  "PDF template tools accept required strings as verbatim LaTeX fragments; use an empty string for an empty section. Fixed images and document layout are provided by the template. Across all PDF tools you have three distinct generation attempts per Agent. The latest attempt determines your single current report; failure clears an earlier candidate. Repeating a successful generation reuses it. Backend-owned report references are attached to your output automatically; finish_task is unchanged.";
export const defaultPdfTemplate: PdfTemplate = {
  toolName: "create_assessment_pdf",
  description: "Create an assessment PDF report.",
  source: String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section*{<<title>>}
<<assessment>>
\end{document}`,
  placeholders: {
    title: "Report title as LaTeX",
    assessment: "Assessment section as LaTeX",
  },
  images: [],
};
