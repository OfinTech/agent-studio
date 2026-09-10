import path from "node:path";
import { readFileSync } from "node:fs";
export const exceptions = JSON.parse(
  readFileSync(new URL("./exceptions.json", import.meta.url), "utf8"),
);
export const forbiddenDependency =
  /^(?:@(?:radix-ui|mui|chakra-ui|headlessui|emotion|fontsource|nextui-org|heroui|shadcn|ark-ui|ant-design|fluentui)\/|(?:tailwindcss|@tailwindcss\/|daisyui|bootstrap|react-bootstrap|antd|styled-components|styled-jsx|@vanilla-extract\/|bulma|semantic-ui|primereact|normalize\.css|react-select|react-modal|@stitches\/|@kobalte\/|react-aria-components|class-variance-authority|twind|unocss))/;
const escapes = new Set([
  "style",
  "styles",
  "className",
  "classNames",
  "unstyled",
  "vars",
  "renderRoot",
  "dangerouslySetInnerHTML",
]);
const themeApis = new Set([
  "createTheme",
  "mergeThemeOverrides",
  "MantineThemeProvider",
  "useMantineTheme",
  "useMantineColorScheme",
  "useComputedColorScheme",
  "setColorScheme",
  "defaultProps",
  "theme",
  "themeOverride",
  "cssVariablesResolver",
  "withCssVariables",
  "getStyleNonce",
]);
const scaffolding = new Set(["html", "head", "body", "form"]);
const color =
  /^(?:dark|gray|red|pink|grape|violet|indigo|blue|cyan|teal|green|lime|yellow|orange)(?:\.[0-9])?$|^(?:dimmed|bright|white|black)$/;
const token = /^(?:xs|sm|md|lg|xl)$/;
const tokenProps = new Set([
  "p",
  "px",
  "py",
  "pt",
  "pb",
  "ps",
  "pe",
  "pl",
  "pr",
  "m",
  "mx",
  "my",
  "mt",
  "mb",
  "ms",
  "me",
  "ml",
  "mr",
  "gap",
  "rowGap",
  "columnGap",
  "spacing",
  "radius",
]);
function literals(node, source, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  const values = (child) => literals(child, source, new Set(seen));
  if (node.type === "Literal") return [node.value];
  if (node.type === "TemplateLiteral" && !node.expressions.length)
    return [node.quasis[0].value.cooked];
  if (
    [
      "JSXExpressionContainer",
      "TSAsExpression",
      "TSSatisfiesExpression",
    ].includes(node.type)
  )
    return values(node.expression);
  if (node.type === "Identifier") {
    let scope = source.getScope(node);
    while (scope) {
      const variable = scope.set.get(node.name);
      if (variable) return values(variable.defs[0]?.node.init);
      scope = scope.upper;
    }
  }
  if (node.type === "ConditionalExpression")
    return [...values(node.consequent), ...values(node.alternate)];
  if (node.type === "ObjectExpression")
    return node.properties.flatMap((p) => values(p.value));
  return [];
}
function keyName(node) {
  return node?.name ?? node?.value;
}
export function createRules(registry = exceptions) {
  return {
    defaults: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          policy:
            "{{reason}} Use Mantine defaults; register only necessary functional exceptions in scripts/ui-policy/exceptions.json.",
        },
      },
      create(context) {
        const source = context.sourceCode;
        const filename = path
          .relative(process.cwd(), context.filename)
          .split(path.sep)
          .join("/");
        function report(node, rule, reason) {
          const registered = registry.some(
            (e) =>
              e.file === filename &&
              e.rule === rule &&
              e.line === node.loc.start.line &&
              e.column === node.loc.start.column + 1 &&
              e.source === source.getText(node),
          );
          if (!registered)
            context.report({ node, messageId: "policy", data: { reason } });
        }
        function property(node, name, value) {
          if (escapes.has(name))
            report(
              node,
              "styling-escape",
              `The ${name} escape hatch is restricted.`,
            );
          if (
            themeApis.has(name) ||
            [
              "ff",
              "fontFamily",
              "fontSize",
              "fontWeight",
              "fontStyle",
              "lineHeight",
              "letterSpacing",
              "fw",
              "fz",
              "fs",
              "lh",
              "lts",
              "tt",
            ].includes(name)
          )
            report(
              node,
              "theme-override",
              "Custom themes and typography are restricted.",
            );
          if (
            [
              "c",
              "color",
              "bg",
              "background",
              "backgroundColor",
              "stroke",
              "fill",
            ].includes(name) &&
            literals(value, source).some(
              (v) => typeof v !== "string" || !color.test(v),
            )
          )
            report(node, "visual-token", "Use a built-in Mantine color token.");
          if (
            tokenProps.has(name) &&
            literals(value, source).some(
              (v) =>
                v !== 0 &&
                !(typeof v === "string" && (token.test(v) || v === "auto")),
            )
          )
            report(
              node,
              "visual-token",
              "Use built-in spacing and radius tokens.",
            );
          if (name === "size" && node.type === "JSXAttribute") {
            const component = source.getText(node.parent.name);
            // Icons use their documented numeric size; Mantine components use defaults or built-in sizes.
            if (
              mantineNames.has(component) &&
              literals(value, source).some(
                (v) => typeof v !== "string" || !token.test(v),
              )
            )
              report(node, "visual-token", "Use a built-in Mantine size.");
          }
        }
        const mantineNames = new Set();
        function checkImport(node, imported) {
          if (typeof imported !== "string") return;
          if (
            forbiddenDependency.test(imported) ||
            (/^(?:next\/font|@mantine\/(?:core|hooks|form)\/)/.test(imported) &&
              imported !== "@mantine/core/styles.css")
          )
            report(
              node,
              "forbidden-import",
              "Competing UI libraries, custom fonts and Mantine internals are prohibited.",
            );
          if (
            /\.(?:css|scss|sass|less)(?:\?|$)/.test(imported) &&
            imported !== "@mantine/core/styles.css"
          )
            report(
              node,
              "stylesheet-import",
              "Application stylesheets must be registered.",
            );
        }
        return {
          ImportDeclaration(node) {
            checkImport(node, node.source.value);
            for (const spec of node.specifiers) {
              if (node.source.value === "@mantine/core")
                mantineNames.add(spec.local.name);
              if (themeApis.has(keyName(spec.imported)))
                report(
                  spec,
                  "theme-override",
                  "Mantine theme override APIs are prohibited.",
                );
            }
          },
          ExportNamedDeclaration(node) {
            if (node.source) checkImport(node, node.source.value);
          },
          ExportAllDeclaration(node) {
            checkImport(node, node.source.value);
          },
          ImportExpression(node) {
            checkImport(node, node.source.value);
          },
          CallExpression(node) {
            if (
              node.callee.type === "MemberExpression" &&
              themeApis.has(keyName(node.callee.property))
            )
              report(
                node,
                "theme-override",
                "Mantine theme override APIs are prohibited.",
              );
            if (node.callee.name === "require")
              checkImport(node, node.arguments[0]?.value);
            if (
              node.callee.type === "MemberExpression" &&
              keyName(node.callee.property) === "extend"
            )
              report(
                node,
                "theme-override",
                "Do not extend Mantine component defaults.",
              );
            if (
              ["createElement", "cloneElement"].includes(
                node.callee.name ?? keyName(node.callee.property),
              )
            )
              report(
                node,
                "raw-element",
                "Use reviewable Mantine JSX composition.",
              );
          },
          JSXOpeningElement(node) {
            const name = source.getText(node.name);
            if (
              node.name.type === "JSXIdentifier" &&
              /^[a-z]/.test(name) &&
              !scaffolding.has(name)
            )
              report(
                node,
                "raw-element",
                `Replace handwritten ${name} with its Mantine component.`,
              );
          },
          JSXAttribute(node) {
            if (
              keyName(node.name) === "component" &&
              ["Box", "Stack", "Group", "Text"].includes(
                source.getText(node.parent.name),
              ) &&
              literals(node.value, source).some((v) =>
                ["button", "input", "select", "textarea"].includes(v),
              )
            )
              report(node, "raw-element", "Use the Mantine control directly.");
            property(node, keyName(node.name), node.value);
          },
          Property(node) {
            property(node, keyName(node.key), node.value);
          },
        };
      },
    },
  };
}
export default { rules: createRules() };
