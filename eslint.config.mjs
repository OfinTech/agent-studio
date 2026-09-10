import js from "@eslint/js";
import ts from "typescript-eslint";
import uiPolicy from "./scripts/ui-policy/rules.mjs";
export default ts.config(
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx}"],
    linterOptions: { noInlineConfig: true },
    plugins: { "ui-policy": uiPolicy },
    rules: { "ui-policy/defaults": "error" },
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  },
);
