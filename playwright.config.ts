import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
try {
  process.loadEnvFile(".env");
} catch {
  /* CI uses environment variables */
}
export default defineConfig({
  testDir: "tests/browser",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: process.env.CI
        ? "pnpm --filter @platform/web start"
        : "pnpm dev",
      env: {
        ATTACHMENT_DIR: resolve(
          process.env.ATTACHMENT_DIR ?? ".data/attachments",
        ),
      },
      url: (process.env.APP_URL ?? "http://localhost:3000") + "/login",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: "pnpm mock-api",
      url: "http://localhost:4010/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: "pnpm worker",
      wait: { stdout: /Agent worker ready/ },
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
