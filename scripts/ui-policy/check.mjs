import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exceptions, forbiddenDependency } from "./rules.mjs";
export async function checkPolicy(root = process.cwd(), registry = exceptions) {
  const errors = [];
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      if (
        [
          "node_modules",
          ".next",
          ".git",
          "test-results",
          "playwright-report",
          ".data",
        ].includes(entry.name)
      )
        continue;
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else files.push(relative);
    }
  }
  await walk("");
  const seen = new Set();
  const exceptionRules = new Set([
    "styling-escape",
    "theme-override",
    "visual-token",
    "forbidden-import",
    "stylesheet-import",
    "raw-element",
    "stylesheet",
  ]);
  for (const e of registry) {
    const location = `${e.file}:${e.line}:${e.column}:${e.rule}`;
    if (seen.has(location)) errors.push(`Duplicate exception: ${location}`);
    seen.add(location);
    if (
      !e.reason?.trim() ||
      !e.insufficient?.trim() ||
      !exceptionRules.has(e.rule) ||
      !e.file?.startsWith("apps/web/") ||
      e.file.includes("..") ||
      /[*?]/.test(e.file)
    ) {
      errors.push(`Invalid exception: ${location}`);
      continue;
    }
    try {
      const content = await readFile(path.join(root, e.file), "utf8");
      if (e.rule === "stylesheet") {
        if (
          e.line !== 1 ||
          e.column !== 1 ||
          !e.sha256 ||
          createHash("sha256").update(content).digest("hex") !== e.sha256
        )
          errors.push(`Stylesheet exception is stale: ${location}`);
      } else {
        if (
          !Number.isInteger(e.line) ||
          !Number.isInteger(e.column) ||
          e.line < 1 ||
          e.column < 1 ||
          !e.source
        ) {
          errors.push(`Invalid source location: ${location}`);
          continue;
        }
        const lines = content.split("\n");
        const tail = lines
          .slice(e.line - 1)
          .join("\n")
          .slice(e.column - 1);
        if (!tail.startsWith(e.source))
          errors.push(`Exception is stale: ${location}`);
      }
    } catch {
      errors.push(`Exception file is missing: ${e.file}`);
    }
  }
  const frontendDependencies = new Set([
    "@mantine/core",
    "@mantine/hooks",
    "@mantine/form",
    "@xyflow/react",
    "lucide-react",
    "next",
    "react",
    "react-dom",
    "postcss",
    "postcss-preset-mantine",
    "postcss-simple-vars",
  ]);
  for (const file of files) {
    if (file.endsWith("package.json")) {
      const manifest = JSON.parse(
        await readFile(path.join(root, file), "utf8"),
      );
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })) {
        if (
          forbiddenDependency.test(name) ||
          (file === "apps/web/package.json" && !frontendDependencies.has(name))
        )
          errors.push(
            `${file}: UI dependency is prohibited or unreviewed: ${name}`,
          );
      }
      if (file === "apps/web/package.json") {
        const versions = ["core", "hooks", "form"].map(
          (name) => manifest.dependencies?.[`@mantine/${name}`],
        );
        if (versions.some((v) => !v) || new Set(versions).size !== 1)
          errors.push("Mantine core/hooks/form versions must match.");
      }
      if (
        JSON.stringify(manifest.pnpm?.patchedDependencies ?? {}).includes(
          "@mantine/",
        )
      )
        errors.push(`${file}: Mantine patches are prohibited.`);
    }
    if (
      /\.(css|scss|sass|less)$/.test(file) &&
      file.startsWith("apps/web/") &&
      !registry.some((e) => e.file === file && e.rule === "stylesheet")
    )
      errors.push(`${file}: Unregistered application stylesheet.`);
    if (/\.(woff2?|ttf|otf)$/.test(file) && file.startsWith("apps/web/"))
      errors.push(`${file}: Custom fonts are prohibited.`);
    if (
      (file.includes("patches/") || file === "pnpm-workspace.yaml") &&
      /@mantine|mantine.*patch/i.test(
        await readFile(path.join(root, file), "utf8"),
      )
    )
      errors.push(`${file}: Mantine patches are prohibited.`);
  }
  return errors;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = await checkPolicy();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "UI policy: dependencies, stylesheets and scoped exceptions verified.",
    );
}
