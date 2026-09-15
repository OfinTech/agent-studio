import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../../persistence/src/index";
import { ConfigurationError, type Workflow } from "../../contracts/src/index";
import {
  imageResourcesSchema,
  type ImageResource,
} from "../../contracts/src/pdf-templates";
import {
  TemplateResourceStorage,
  compilationFilename,
  validateImage,
} from "../../connectors/src/template-resources";
import { reportChecksum } from "../../connectors/src/reports";

export async function readTemplateResource(
  workflowId: string,
  image: ImageResource,
  client?: PoolClient,
) {
  const sql =
    "SELECT metadata FROM template_resources WHERE workflow_id=$1 AND id=$2";
  const rows = client
    ? (await client.query(sql, [workflowId, image.id])).rows
    : await query(sql, [workflowId, image.id]);
  const stored = rows[0]?.metadata;
  if (
    !stored ||
    Object.keys(image).some(
      (key) => image[key as keyof ImageResource] !== stored[key],
    )
  )
    throw new ConfigurationError(
      "Template image does not belong to this workflow or its metadata changed",
    );
  return new TemplateResourceStorage().readImage(image);
}
export async function validateTemplateResources(
  workflowId: string,
  workflow: Workflow,
  client: PoolClient,
) {
  for (const node of workflow.nodes)
    if (node.type === "pdf_template") {
      const images = imageResourcesSchema.parse(
        node.data.pdfTemplate?.images ?? [],
      );
      for (const image of images)
        await readTemplateResource(workflowId, image, client);
    }
}
export async function uploadTemplateResource(
  workflowId: string,
  filename: string,
  bytes: Buffer,
  existing: ImageResource[] = [],
) {
  let mimeType: ImageResource["mimeType"];
  try {
    mimeType = await validateImage(bytes);
    filename = compilationFilename(filename, mimeType);
  } catch (error) {
    throw new ConfigurationError((error as Error).message);
  }
  const image: ImageResource = {
    id: randomUUID(),
    filename,
    mimeType,
    size: bytes.length,
    checksum: reportChecksum(bytes),
  };
  imageResourcesSchema.parse([...existing, image]);
  await transaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id FROM workflows WHERE id=$1 FOR UPDATE",
      [workflowId],
    );
    if (!rows.length) throw new ConfigurationError("Workflow not found");
    for (const previous of existing)
      await readTemplateResource(workflowId, previous, client);
    await new TemplateResourceStorage().put(image.id, bytes);
    await client.query(
      "INSERT INTO template_resources(id,workflow_id,metadata) VALUES($1,$2,$3)",
      [image.id, workflowId, JSON.stringify(image)],
    );
  });
  return image;
}
export async function compilationResources(
  runId: string,
  images: ImageResource[],
) {
  imageResourcesSchema.parse(images);
  if (!images.length) return [];
  const [run] = await query(
    "SELECT v.workflow_id FROM runs r JOIN versions v ON v.id=r.version_id WHERE r.id=$1",
    [runId],
  );
  if (!run) throw new Error("Run not found");
  const resources = [];
  for (const image of images)
    resources.push({
      ...image,
      content: (await readTemplateResource(run.workflow_id, image)).toString(
        "base64",
      ),
    });
  return resources;
}
export async function cleanupTemplateResources() {
  const storage = new TemplateResourceStorage();
  for (const workflow of await query("SELECT id FROM workflows")) {
    const removed = await transaction(async (client) => {
      // Save, publish, upload, deletion and maintenance share the workflow row lock.
      const { rows } = await client.query(
        "SELECT draft FROM workflows WHERE id=$1 FOR UPDATE",
        [workflow.id],
      );
      if (!rows.length) return [];
      const versions = await client.query(
        "SELECT snapshot->'workflow' AS workflow FROM versions WHERE workflow_id=$1",
        [workflow.id],
      );
      const keep = new Set<string>();
      for (const draft of [
        rows[0].draft,
        ...versions.rows.map((v) => v.workflow),
      ] as Workflow[])
        for (const node of draft.nodes)
          for (const image of node.data.pdfTemplate?.images ?? [])
            keep.add(image.id);
      const deleted = await client.query(
        "DELETE FROM template_resources WHERE workflow_id=$1 AND created_at < now()-interval '7 days' AND NOT (id=ANY($2::text[])) RETURNING id",
        [workflow.id, [...keep]],
      );
      return deleted.rows;
    });
    for (const image of removed) await storage.delete(image.id);
  }
  const keep = new Set(
    (await query("SELECT id FROM template_resources")).map(
      (r) => r.id as string,
    ),
  );
  await storage.expireOrphans(keep, new Date(Date.now() - 7 * 86400000));
}
