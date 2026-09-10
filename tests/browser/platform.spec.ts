import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import type { Workflow } from "../../packages/contracts/src/index";
// Reuse the authenticated session in memory so UI scenarios respect the login
// rate limit while keeping separate browser contexts and testing real sign-in.
let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;
async function signIn(page: Page, fresh = false) {
  if (sessionCookies && !fresh) {
    await page.context().addCookies(sessionCookies);
    await page.goto("/workflows");
    await expect(
      page.getByRole("heading", { name: "Workflows", exact: true }),
    ).toBeVisible();
    return;
  }
  await page.goto("/login");
  await page
    .getByLabel("Email address")
    .fill(process.env.ADMIN_EMAIL ?? "admin@example.com");
  await page
    .getByLabel(/^Password/)
    .fill(process.env.E2E_ADMIN_PASSWORD ?? "local-test-password-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/workflows$/);
  sessionCookies = await page.context().cookies();
}
async function expectCanvasFillsHeight(page: Page) {
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const main = element.closest("main")!;
        const bottomPadding = parseFloat(getComputedStyle(main).paddingBottom);
        return Math.abs(
          window.innerHeight -
            element.getBoundingClientRect().bottom -
            bottomPadding,
        );
      }),
    )
    .toBeLessThan(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(page.viewportSize()!.height);
}
async function connect(
  page: Page,
  source: string,
  target: string,
  tool = false,
) {
  const from = page.locator(
    `.react-flow__node[data-id="${source}"] .react-flow__handle[data-handleid="${tool ? "tool" : "out"}"]`,
  );
  const to = page.locator(
    `.react-flow__node[data-id="${target}"] .react-flow__handle[data-handleid="${tool ? "tools" : "in"}"]`,
  );
  const a = await from.boundingBox(),
    b = await to.boundingBox();
  if (!a || !b) throw new Error("Connection handles are not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}
test("administrator builds, publishes and executes the receipt workflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser receipt " + Date.now());
  await page.getByLabel("Start from").selectOption("blank");
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  for (const type of ["email", "upload", "agent", "tool"]) {
    await page.getByRole("button", { name: "Add step", exact: true }).click();
    await page
      .getByRole("menuitem", {
        name:
          type === "tool" ? "MCP tool" : type[0].toUpperCase() + type.slice(1),
        exact: true,
      })
      .click();
    if (type === "email")
      await page
        .getByLabel("Receiving address")
        .fill(`browser-${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Close settings" }).click();
  }
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.waitForTimeout(400);
  await connect(page, "email", "upload");
  await connect(page, "upload", "agent");
  await connect(page, "tool", "agent", true);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Published v1");
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Execution details" }),
  ).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", {
    timeout: 30000,
  });
  await expect(page.getByTestId("run-inspector")).toContainText(
    "submit_receipt",
  );
  await expect(page.getByTestId("run-inspector")).toContainText("Paper & Pine");
  await expect(page.getByTestId("run-inspector")).toContainText("42.5");
  expect(errors).toEqual([]);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/receipt-run.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close run inspector" }).click();
  await expect(
    page.getByRole("dialog", { name: "Execution details" }),
  ).not.toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="email"]'),
  ).toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="agent"]'),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/workflow-builder.png",
    fullPage: true,
  });
  await expectCanvasFillsHeight(page);
  const workflowUrl = page.url();
  await page.getByRole("link", { name: "Run history", exact: true }).click();
  const historyRun = page
    .getByRole("button", { name: /^Browser receipt/ })
    .first();
  await historyRun.click();
  const drawer = page.getByRole("dialog", { name: "Execution details" });
  await expect(drawer).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? "Tab" : "Shift+Tab");
    expect(
      await drawer.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(historyRun).toBeFocused();
  await page.reload();
  await page.goto(workflowUrl);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(
    page.locator('.react-flow__node[data-id="agent"]'),
  ).toBeInViewport();
  await page.locator('.react-flow__node[data-id="email"]').click();
  await page.getByLabel("Step name").fill("Updated receipt inbox");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.reload();
  await expect(
    page.locator('.react-flow__node[data-id="email"]'),
  ).toContainText("Updated receipt inbox");
  await expect(
    page.locator('.react-flow__node[data-id="agent"]'),
  ).toBeInViewport();
});
test("credentials are stored without being returned to the browser and API requires authentication", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/bootstrap")).status()).toBe(401);
  expect(
    (
      await request.post("/api/webhooks/resend", {
        data: { type: "email.received" },
      })
    ).status(),
  ).toBe(400);
  await signIn(page);
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  await page
    .getByRole("button", { name: "Add credential", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser credential " + Date.now());
  await dialog.getByLabel(/^Secret/).fill("synthetic-secret-never-return");
  await dialog.getByRole("button", { name: "Save credential" }).click();
  await expect(dialog).not.toBeVisible();
  const body = await page.evaluate(
    async () => await (await fetch("/api/bootstrap")).text(),
  );
  expect(body).not.toContain("synthetic-secret-never-return");
  expect(body).not.toContain("encrypted");
  const csrf = await page.request.post("/api/credentials", {
    headers: { origin: "https://evil.example" },
    data: { name: "blocked", kind: "api", secret: "x" },
  });
  expect(csrf.status()).toBe(403);
});
test("mobile login and workflow editor remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, true);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/mobile-workflows.png",
    fullPage: true,
  });
  await page.getByRole("table").getByRole("link").first().click();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/mobile-builder.png",
    fullPage: true,
  });
});

test("tool creator validates destinations and saves declarative tools", async ({
  page,
}) => {
  await signIn(page);
  const endpoint = await page.evaluate(async () => {
    const data = await (await fetch("/api/bootstrap")).json();
    return data.tools[0].endpoint as string;
  });
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  await page.getByRole("button", { name: "Create tool", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = "browser_tool_" + Date.now();
  await dialog
    .getByRole("textbox", { name: "Tool name", exact: true })
    .fill(name);
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Submit a receipt from a browser-created tool");
  await dialog
    .getByLabel("Fixed API endpoint")
    .fill("https://not-allowed.example/receipts");
  await dialog.getByRole("button", { name: "Save tool", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("not allowed");
  await dialog.getByLabel("Fixed API endpoint").fill(endpoint);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/tool-form.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Save tool", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
});

test("login reports accessible field errors and uses default light styling", async ({
  page,
}) => {
  await page.goto("/login");
  await page.screenshot({
    animations: "disabled",
    caret: "initial",
    path: "test-results/login.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Email address")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByText("Enter a valid email address", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Password/)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-mantine-color-scheme",
    "light",
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/login-errors.png",
    fullPage: true,
  });
});

test("dialogs trap keyboard focus, dismiss with Escape, and restore focus", async ({
  page,
}) => {
  await signIn(page);
  const trigger = page.getByRole("button", {
    name: "New workflow",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create workflow" });
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("");
  await dialog
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? "Tab" : "Shift+Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.screenshot({
    animations: "disabled",
    path: "test-results/workflow-form.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  const add = page.getByRole("button", { name: "Add credential", exact: true });
  await add.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save credential" })
    .click();
  await expect(page.getByLabel(/^Secret/)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/credential-form.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
});

test("mobile navigation, tool form scrolling, and settings are usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("table").getByRole("link").first().click();
  await expectCanvasFillsHeight(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  await page.getByRole("button", { name: "Create tool", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("textbox", { name: "Tool name", exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Input JSON Schema").fill("invalid JSON");
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Synthetic test");
  await dialog.getByRole("button", { name: "Save tool", exact: true }).click();
  await expect(dialog.getByLabel("Input JSON Schema")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/mobile-tool-form.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Create tool", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  await page.getByRole("table").getByRole("link").first().click();
  const node = page.locator('.react-flow__node[data-id="email"]');
  await node.click();
  const settings = page.getByRole("dialog", {
    name: "Step settings",
    exact: true,
  });
  await expect(settings.getByLabel("Step name")).toBeFocused();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? "Tab" : "Shift+Tab");
    expect(
      await settings.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.screenshot({
    animations: "disabled",
    path: "test-results/mobile-settings.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(node).toBeFocused();
  await expectCanvasFillsHeight(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

async function createReceipt(page: Page, prefix = "Navigation") {
  const name = `${prefix} ${Date.now()}`;
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create workflow" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/);
  return { name, url: page.url() };
}
async function rename(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Workflow settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Workflow settings" });
  await dialog.getByLabel("Workflow name").fill(name);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("routes, unsaved navigation choices, failed saves, and explicit naming", async ({
  page,
}) => {
  await signIn(page);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/workflows.png",
    fullPage: true,
  });
  const { name, url } = await createReceipt(page);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  const settingsButton = page.getByRole("button", {
    name: "Workflow settings",
    exact: true,
  });
  await settingsButton.click();
  const settings = page.getByRole("dialog", { name: "Workflow settings" });
  await expect(settings.getByLabel("Workflow name")).toBeFocused();
  await settings.getByLabel("Workflow name").fill("Unapplied");
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(settingsButton).toBeFocused();
  await expect(save).toBeDisabled();
  const changed = name + " renamed";
  await rename(page, changed);
  await expect(save).toBeEnabled();
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  expect(
    bootstrap.workflows.find((w: { id: string }) => url.endsWith(w.id)).draft
      .name,
  ).toBe(name);
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  const leave = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(
    leave.getByRole("button", { name: "Stay", exact: true }),
  ).toBeFocused();
  await leave.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("heading", { name: changed, exact: true }),
  ).toBeVisible();
  await page.route("**/api/workflows/*", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 500,
        json: { error: "Synthetic save failure" },
      });
    else await route.continue();
  });
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  await leave
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(leave.getByRole("alert")).toHaveText("Synthetic save failure");
  await expect(page).toHaveURL(url);
  await leave.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(save).toBeEnabled();
  await page.unroute("**/api/workflows/*");
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  await leave
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tools$/);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/tools.png",
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "MCP tools", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("heading", { name: changed, exact: true }),
  ).toBeVisible();
  await rename(page, name + " discarded");
  await page
    .getByRole("banner")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  await leave
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.getByRole("link", { name: changed, exact: true }).click();
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: changed, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.goto("/workflows/missing-workflow-id");
  await expect(
    page.getByRole("heading", { name: "Workflow not found" }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test("Back and Forward preserve separate drafts and canvas state through bootstrap refreshes", async ({
  page,
}) => {
  await signIn(page);
  const first = await createReceipt(page, "First draft");
  await page
    .getByRole("banner")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  const second = await createReceipt(page, "Second draft");
  await rename(page, second.name + " unsaved");
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.goBack();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: second.name + " unsaved", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    transform!,
  );
  await page.goBack();
  await page.getByRole("link", { name: first.name, exact: true }).click();
  await rename(page, first.name + " unsaved");
  await page.goBack();
  await page.getByRole("link", { name: "Run history", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  await page.getByRole("link", { name: second.name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: second.name + " unsaved", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.goBack();
  await page.getByRole("link", { name: first.name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: first.name + " unsaved", exact: true }),
  ).toBeVisible();
  const warning = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload());
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload;
  await expect(
    page.getByRole("heading", { name: first.name + " unsaved", exact: true }),
  ).toBeVisible();
});

test("contextual settings resize the canvas without replacing it, and Add step supports keyboard", async ({
  page,
}) => {
  await signIn(page);
  await createReceipt(page, "Contextual");
  const canvas = page.getByTestId("workflow-canvas");
  await expectCanvasFillsHeight(page);
  const full = (await canvas.boundingBox())!.width;
  const before = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.locator('.react-flow__node[data-id="email"]').click();
  await expect(page.getByLabel("Receiving address")).toBeVisible();
  expect((await canvas.boundingBox())!.width).toBeLessThan(full);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    before!,
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/desktop-settings.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Step settings" }),
  ).not.toBeVisible();
  expect((await canvas.boundingBox())!.width).toBe(full);
  const add = page.getByRole("button", { name: "Add step", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Email", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Upload", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await expect(page.getByLabel("Step name")).toBeVisible();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await add.click();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  for (const copy of [
    "Workflow overview",
    "Draft",
    "Changes are saved as a draft",
    "Available to agent",
    "When an email arrives",
    "Executions",
    "Drag to arrange. Connect handles to link steps.",
  ]) {
    await expect(page.getByText(copy, { exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectCanvasFillsHeight(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectCanvasFillsHeight(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
});

test("empty lists are factual and all application routes require authentication", async ({
  page,
  request,
}) => {
  for (const path of [
    "/",
    "/workflows",
    "/workflows/missing",
    "/tools",
    "/credentials",
    "/runs",
  ]) {
    const response = await request.get(path);
    expect(new URL(response.url()).pathname).toBe("/login");
  }
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        adminEmail: "admin@example.com",
        workflows: [],
        tools: [],
        credentials: [],
        runs: [],
      },
    }),
  );
  await signIn(page);
  await expect(
    page.getByText("No workflows yet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("workflow-canvas")).toHaveCount(0);
  await page.getByRole("link", { name: "MCP tools", exact: true }).click();
  await expect(page.getByText("No tools yet.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  await expect(
    page.getByText("No credentials yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Encrypted|Protection|encrypted at rest/),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Run history", exact: true }).click();
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
});

test("desktop and mobile management and run inspector screenshots", async ({
  page,
}) => {
  await signIn(page);
  const headers = { Origin: new URL(page.url()).origin };
  const credential = await page.request.post("/api/credentials", {
    headers,
    data: { name: "Screenshot fixture", kind: "api", secret: "synthetic-only" },
  });
  expect(credential.ok()).toBe(true);
  const created = await page.request.post("/api/workflows", {
    headers,
    data: { name: "Screenshot receipt " + Date.now(), template: "receipt" },
  });
  expect(created.ok()).toBe(true);
  const workflow = (await created.json()) as { id: string; draft: Workflow };
  const inbox = workflow.draft.nodes.find((node) => node.type === "email")!;
  inbox.data.recipient = `screenshot-${workflow.id}@example.com`;
  expect(
    (
      await page.request.put(`/api/workflows/${workflow.id}`, {
        headers,
        data: workflow.draft,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`/api/workflows/${workflow.id}/publish`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  const queued = await page.request.post(`/api/workflows/${workflow.id}/test`, {
    headers,
  });
  expect(queued.ok()).toBe(true);
  const run = (await queued.json()) as { id: string };
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/runs/${run.id}`);
        expect(response.ok()).toBe(true);
        return (await response.json()).status;
      },
      { timeout: 30000 },
    )
    .toBe("succeeded");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const prefix = viewport.width === 390 ? "mobile" : "desktop";
    for (const path of ["workflows", "tools", "credentials", "runs"]) {
      await page.goto(`/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("table")).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: `test-results/${prefix}-${path}.png`,
        fullPage: true,
      });
      if (path === "runs") {
        await page.getByRole("table").getByRole("button").first().click();
        await expect(page.getByTestId("run-status")).toBeVisible();
        await page.screenshot({
          animations: "disabled",
          path: `test-results/${prefix}-run-inspector.png`,
          fullPage: true,
        });
        await page.keyboard.press("Escape");
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test("Outcome editing, stable branches, generated settings and tool actions survive Save/Publish/refresh", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Outcome browser " + Date.now());
  await page.getByLabel("Start from").selectOption("receipt");
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[^/]+$/);
  const workflowId = page.url().split("/").at(-1)!;
  await page.locator('.react-flow__node[data-id="email"]').click();
  await page
    .getByLabel("Receiving address")
    .fill(`outcome-${workflowId}@example.com`);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator('.react-flow__node[data-id="agent"]').click();
  const system = await page
    .getByLabel("System prompt", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Add outcome", exact: true }).click();
  await expect(page.getByLabel("State 1 name")).toHaveValue("Success");
  await expect(page.getByLabel("State 2 name")).toHaveValue("Failure");
  await page.getByRole("button", { name: "Add state", exact: true }).click();
  await page.getByLabel("State 3 name").fill("Review");
  await page.getByLabel("State 3 criteria").fill("Missing receipt details");
  const outcome = page.locator('.react-flow__node[data-id^="outcome-"]');
  const outcomeId = (await outcome.getAttribute("data-id"))!;
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Tool action", exact: true })
    .click();
  await page.getByLabel("Step name").fill("Submit outcome result");
  await page
    .getByLabel("MCP tool", { exact: true })
    .selectOption("receipt-tool");
  await page.getByLabel("Input arguments").fill(
    JSON.stringify({
      merchant: "{{steps.agent.outcome.result}}",
      date: "2026-09-09",
      currency: "USD",
      total: 1,
    }),
  );
  const actionId = (await page
    .locator(".react-flow__node")
    .filter({ hasText: "Submit outcome result" })
    .getAttribute("data-id"))!;
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await outcome.click();
  await page.getByLabel("State 1 next step").selectOption(actionId);
  await expect(
    page.getByLabel("State 1 next step").locator(`option[value="${actionId}"]`),
  ).toHaveCount(1);
  await page.getByLabel("State 1 name").fill("Completed");
  await page
    .getByLabel("State 1 criteria")
    .fill("All required information is available");
  await page
    .getByRole("button", { name: "Move state up", exact: true })
    .nth(1)
    .click();
  await expect(page.getByLabel("State 2 next step")).toHaveValue(actionId);
  await page
    .getByRole("button", { name: "Move state up", exact: true })
    .nth(1)
    .click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator('.react-flow__node[data-id="agent"]').click();
  await expect(
    page.getByText("Generated completion instructions", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/success: Completed/)).toContainText(
    "All required information is available",
  );
  await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue(
    system,
  );
  await expect(page.getByLabel("Required success tool")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Outcome block" }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.screenshot({
    path: "test-results/desktop-outcome-settings.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Published v1");
  await page.reload();
  await expect(outcome).toContainText("Completed");
  await expect(outcome.locator('[data-handleid="success"]')).toBeVisible();
  await page.screenshot({
    path: "test-results/desktop-outcome-editor.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", {
    timeout: 30000,
  });
  const inspector = page.getByTestId("run-inspector");
  await inspector
    .getByRole("button", { name: "agent succeeded", exact: true })
    .click();
  await expect(inspector).toContainText("Reported outcome: Completed");
  await expect(inspector).toContainText("Reason: Synthetic task completed");
  await expect(inspector).toContainText(`Selected branch: ${actionId}`);
  await expect(inspector).toContainText(`submit_receipt · ${actionId}`);
  await page.screenshot({
    path: "test-results/desktop-outcome-inspector.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Test run", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await expect(outcome).toBeInViewport();
  await page.screenshot({
    path: "test-results/mobile-outcome-editor.png",
    fullPage: true,
    animations: "disabled",
  });
  await outcome.click();
  const settings = page.getByRole("dialog", { name: "Step settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Step name")).toBeFocused();
  await settings.getByLabel("State 1 criteria").click();
  await expect(settings).toBeInViewport({ ratio: 0.95 });
  await page.screenshot({
    path: "test-results/mobile-outcome-settings.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(outcome).toBeFocused();
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", {
    timeout: 30000,
  });
  await page
    .getByTestId("run-inspector")
    .getByRole("button", { name: "agent succeeded", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/mobile-outcome-inspector.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await outcome.click();
  await page
    .getByRole("button", { name: "Remove state 1", exact: true })
    .click();
  await expect(outcome.locator('[data-handleid="success"]')).toHaveCount(0);
  await expect(
    page.locator(`.react-flow__edge[data-id]`).filter({ hasText: "success" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  const bootstrap = await page.request.get("/api/bootstrap");
  const saved = (await bootstrap.json()).workflows.find(
    (w: any) => w.id === workflowId,
  ).draft;
  expect(
    saved.edges.some(
      (e: any) => e.source === outcomeId && e.stateId === "success",
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Remove step", exact: true }).click();
  await page.locator('.react-flow__node[data-id="agent"]').click();
  await expect(
    page.getByText("Generated completion instructions", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Required success tool")).toBeVisible();
});

test("Add step Outcome source selection supports keyboard, cancellation and existing successor rerouting", async ({
  page,
}) => {
  await signIn(page);
  const response = await page.request.post("/api/workflows", {
    headers: { Origin: new URL(page.url()).origin },
    data: { name: "Outcome source " + Date.now(), template: "receipt" },
  });
  expect(response.ok()).toBe(true);
  const record = await response.json();
  record.draft.nodes.push({
    ...record.draft.nodes[2],
    id: "second",
    position: { x: 1320, y: 150 },
    data: {
      ...record.draft.nodes[2].data,
      label: "Second agent",
      requiredTool: undefined,
    },
  });
  record.draft.edges.push({
    id: "continuation",
    source: "agent",
    target: "second",
    kind: "execution",
  });
  await page.request.put(`/api/workflows/${record.id}`, {
    headers: { Origin: new URL(page.url()).origin },
    data: record.draft,
  });
  await page.goto(`/workflows/${record.id}`);
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Outcome", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add outcome" });
  await expect(dialog.getByLabel("Source agent")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Outcome", exact: true }).click();
  await dialog.getByLabel("Source agent").selectOption("agent");
  await dialog
    .getByRole("button", { name: "Add outcome", exact: true })
    .click();
  await expect(page.getByLabel("State 1 next step")).toHaveValue("second");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Outcome", exact: true }).click();
  await expect(dialog.getByLabel("Source agent")).toBeFocused();
  await expect(
    dialog.getByLabel("Source agent").locator('option[value="agent"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.reload();
  await page.locator('.react-flow__node[data-id^="outcome-"]').click();
  await expect(page.getByLabel("State 1 next step")).toHaveValue("second");
});

test("long step settings scroll independently without extending the editor page", async ({
  page,
}) => {
  await signIn(page);
  await createReceipt(page, "Scrollable settings");
  const pageHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await page.locator('.react-flow__node[data-id="agent"]').click();
  const settings = page.getByRole("region", {
    name: "Step settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect
    .poll(() =>
      settings.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    pageHeight,
  );
  await settings.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => settings.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    settings.getByRole("button", { name: "Remove step", exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await settings.hover();
  await page.mouse.wheel(0, 1500);
  await expect(settings).toHaveCSS("overscroll-behavior-y", "contain");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "test-results/desktop-settings-scrolled.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.locator('.react-flow__node[data-id="email"]').click();
  await expect(settings.getByLabel("Receiving address")).toBeInViewport();
  expect(await settings.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    pageHeight,
  );

  await page.locator('.react-flow__node[data-id="agent"]').click();
  await settings
    .getByRole("button", { name: "Add outcome", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Add state", exact: true })
    .click();
  await expect(settings.getByLabel("State 3 name")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    pageHeight,
  );
  await settings
    .getByRole("button", { name: "Remove step", exact: true })
    .focus();
  await expect(
    settings.getByRole("button", { name: "Remove step", exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.locator('.react-flow__node[data-id^="outcome-"]').click();
  const drawer = page.getByRole("dialog", {
    name: "Step settings",
    exact: true,
  });
  await expect(drawer).toBeVisible();
  await expect(settings).toHaveCount(0);
  await drawer.getByLabel("State 3 criteria").fill("Custom outcome criteria");
  await expect(drawer.getByLabel("State 3 criteria")).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
});

test("canvas and settings use the remaining viewport height after resize and notices", async ({
  page,
}) => {
  await signIn(page);
  await createReceipt(page, "Viewport canvas");
  await expectCanvasFillsHeight(page);
  const canvas = page.getByTestId("workflow-canvas");
  const initialHeight = (await canvas.boundingBox())!.height;
  await page.setViewportSize({ width: 1440, height: 1200 });
  await expectCanvasFillsHeight(page);
  expect((await canvas.boundingBox())!.height).toBeCloseTo(
    initialHeight + 200,
    0,
  );
  await page.locator('.react-flow__node[data-id="agent"]').click();
  const settings = page.getByRole("region", {
    name: "Step settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs(
        (await settings.boundingBox())!.height -
          (await canvas.boundingBox())!.height,
      ),
    )
    .toBeLessThan(2);
  await page.getByLabel("Step name").fill("Viewport agent");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await expectCanvasFillsHeight(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectCanvasFillsHeight(page);
  await settings
    .getByRole("button", { name: "Remove step", exact: true })
    .focus();
  await expect(
    settings.getByRole("button", { name: "Remove step", exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "test-results/desktop-viewport-canvas.png",
    fullPage: true,
    animations: "disabled",
  });
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectCanvasFillsHeight(page);
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.screenshot({
    path: "test-results/mobile-viewport-canvas.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expectCanvasFillsHeight(page);
});

test("terminal email settings, references, preview and mobile scrolling survive publication", async ({
  page,
}) => {
  await signIn(page);
  await createReceipt(page, "Email reply");
  const workflowId = page.url().split("/").at(-1)!;
  await page.locator('.react-flow__node[data-id="email"]').click();
  await page
    .getByLabel("Receiving address")
    .fill(`email-${workflowId}@example.com`);
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Send email", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Body template")).toHaveValue("");
  await expect(page.getByLabel("From: trigger inbox")).toHaveValue(
    `email-${workflowId}@example.com`,
  );
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(
    "Original sender",
  );
  await expect(page.getByLabel("From: trigger inbox")).toHaveAttribute(
    "readonly",
    "",
  );
  await page.getByLabel("Body template").fill("Receipt processed. ");
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.locator('.react-flow__node[data-id="agent"]').click();
  await page
    .getByLabel("Next step", { exact: true })
    .selectOption("send_email");
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  const reply = page.locator('.react-flow__node[data-id="send_email"]');
  await reply.click();
  await expect(reply.locator(".react-flow__handle")).toHaveCount(1);
  await expect(page.getByLabel("Next step", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "{{steps.agent.text}}", exact: true })
    .click();
  await expect(page.getByLabel("Body template")).toHaveValue(
    "Receipt processed. {{steps.agent.text}}",
  );
  await page.getByLabel("Subject template").fill("Processed: ");
  await page
    .getByRole("button", { name: "{{email.subject}}", exact: true })
    .click();
  await expect(page.getByLabel("Subject template")).toHaveValue(
    "Processed: {{email.subject}}",
  );
  await expectCanvasFillsHeight(page);
  const settings = page.getByRole("region", {
    name: "Step settings",
    exact: true,
  });
  await settings.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => settings.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "test-results/desktop-email-settings.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Published v1");
  await page.reload();
  await expect(reply).toBeVisible();
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("succeeded", {
    timeout: 30000,
  });
  const inspector = page.getByTestId("run-inspector");
  await expect(
    inspector.getByText("Preview only", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByText("Subject: Processed: Your Paper & Pine receipt", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector.getByText("To: receipts@paperandpine.example", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/desktop-email-preview.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Test run", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await reply.click();
  const drawer = page.getByRole("dialog", {
    name: "Step settings",
    exact: true,
  });
  await expect(drawer.getByLabel("Body template")).toHaveValue(
    "Receipt processed. {{steps.agent.text}}",
  );
  await drawer
    .getByRole("button", { name: "{{steps.agent.text}}", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    drawer.getByRole("button", { name: "{{steps.agent.text}}", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "test-results/mobile-email-settings.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expectCanvasFillsHeight(page);
  await reply.click();
  await drawer
    .getByRole("button", { name: "Remove step", exact: true })
    .click();
  await expect(reply).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(reply).toHaveCount(0);
  await expectCanvasFillsHeight(page);
});

test("publication returns actionable validation errors for invalid execution graphs", async ({
  page,
}) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/workflows", {
    headers: { Origin: origin },
    data: { name: "Invalid publication " + Date.now(), template: "receipt" },
  });
  expect(created.ok()).toBe(true);
  const workflow = await created.json();
  workflow.draft.nodes = workflow.draft.nodes.filter(
    (node: { type: string }) => node.type !== "agent",
  );
  expect(
    (
      await page.request.put(`/api/workflows/${workflow.id}`, {
        headers: { Origin: origin },
        data: workflow.draft,
      })
    ).ok(),
  ).toBe(true);
  const publication = await page.request.post(
    `/api/workflows/${workflow.id}/publish`,
    { headers: { Origin: origin }, data: {} },
  );
  expect(publication.status()).toBe(400);
  expect((await publication.json()).error).toContain(
    "Add at least one agent node.",
  );
});
