import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRules } from "../scripts/ui-policy/rules.mjs";
import { checkPolicy } from "../scripts/ui-policy/check.mjs";
const filename = "apps/web/components/example.jsx";
function lint(code, registry = [], file = filename) {
  return new Linter().verify(
    code,
    [
      {
        files: ["**/*.jsx"],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { ui: { rules: createRules(registry) } },
        rules: { "ui/defaults": "error" },
      },
    ],
    { filename: file },
  );
}
describe("Mantine UI lint policy", () => {
  it.each([
    'const shade = "#123456"; <Text c={shade} />',
    "const gap = 17; <Stack gap={gap} />",
    '<Box component="button">Save</Box>',
    'import * as Mantine from "@mantine/core"; Mantine.createTheme({});',
    'import "@mantine/core/src/Button";',
  ])("rejects indirect policy violations: %s", (code) => {
    expect(lint(code).length).toBeGreaterThan(0);
  });
  it("allows ordinary Mantine composition, tokens, form semantics, and icon components", () => {
    expect(
      lint(
        'import { Stack, Button, TextInput, Badge } from "@mantine/core"; const UI = () => <form><Stack gap="md" p={{ base: "sm", md: "md" }}><TextInput label="Name" /><Button variant="default">Save</Button><Badge color="red">Failed</Badge><item.icon size={16} /></Stack></form>;',
      ),
    ).toEqual([]);
  });
  it.each([
    "<button>Save</button>",
    "<div>Content</div>",
    "<input />",
    '<style>{"body {}"}</style>',
    '<Button style={{color: "red"}} />',
    "<Button styles={{root: {}}} />",
    '<Button className="custom" />',
    '<Button classNames={{root: "x"}} />',
    "<Button unstyled />",
    "<Button vars={() => ({})} />",
    "const props = { style: {} }; <Button {...props} />",
    '<Text c="#123456" />',
    '<Paper bg="rgb(1,2,3)" />',
    "<Stack gap={17} />",
    '<Text ff="Inter" />',
    "<Text fz={17} />",
    "<MantineProvider theme={{}} />",
    'import { createTheme as custom } from "@mantine/core";',
    "Button.extend({});",
    'import { Button } from "@mui/material";',
    'import "tailwindcss";',
    'import "@fontsource/inter";',
    'import "next/font/google";',
    'import "./other.css";',
    'import { Button } from "@mantine/core/lib/components/Button";',
    'const x = import("@radix-ui/react-dialog");',
  ])("rejects %s", (code) => {
    expect(lint(code).length).toBeGreaterThan(0);
  });
  it("limits exceptions to an exact file, location, rule and source", () => {
    const code = "<Paper className={classes.node} />";
    const registry = [
      {
        file: filename,
        line: 1,
        column: 8,
        rule: "styling-escape",
        source: "className={classes.node}",
        reason: "Node geometry",
        insufficient: "Graph rendering",
      },
    ];
    expect(lint(code, registry)).toEqual([]);
    expect(
      lint(code, registry, "apps/web/components/another.jsx"),
    ).toHaveLength(1);
    expect(lint("\n" + code, registry)).toHaveLength(1);
    expect(
      lint(code.replace("classes.node", "classes.custom"), registry),
    ).toHaveLength(1);
    expect(
      lint(code + "; <Paper className={classes.node} />", registry),
    ).toHaveLength(1);
    expect(lint(code, [{ ...registry[0], rule: "raw-element" }])).toHaveLength(
      1,
    );
  });
});
describe("repository UI policy", () => {
  async function fixture(test) {
    const root = await mkdtemp(path.join(tmpdir(), "mantine-policy-"));
    try {
      await mkdir(path.join(root, "apps/web"), { recursive: true });
      await writeFile(
        path.join(root, "apps/web/package.json"),
        JSON.stringify({
          dependencies: {
            "@mantine/core": "9.6.1",
            "@mantine/hooks": "9.6.1",
            "@mantine/form": "9.6.1",
          },
        }),
      );
      await test(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  it("accepts the default dependency foundation", () =>
    fixture(async (root) => {
      expect(await checkPolicy(root, [])).toEqual([]);
    }));
  it("rejects unregistered CSS, fonts, dependency conflicts and stale exceptions", () =>
    fixture(async (root) => {
      await writeFile(
        path.join(root, "apps/web/extra.css"),
        "body { color: red }",
      );
      await writeFile(path.join(root, "apps/web/font.woff2"), "font");
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@mui/material": "1" } }),
      );
      const errors = await checkPolicy(root, [
        {
          file: "apps/web/extra.css",
          line: 1,
          column: 1,
          rule: "stylesheet",
          sha256: "wrong",
          reason: "test",
          insufficient: "test",
        },
      ]);
      expect(errors.join("\n")).toContain("stale");
      expect(errors.join("\n")).toContain("Custom fonts");
      expect(errors.join("\n")).toContain("@mui/material");
      expect((await checkPolicy(root, [])).join("\n")).toContain(
        "Unregistered",
      );
    }));
  it("rejects blanket or undocumented exceptions", () =>
    fixture(async (root) => {
      expect(
        (
          await checkPolicy(root, [
            { file: "apps/web/**", rule: "styling-escape" },
          ])
        ).join("\n"),
      ).toContain("Invalid exception");
    }));
});
