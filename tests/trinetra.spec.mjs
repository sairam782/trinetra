import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
let server;

test.beforeAll(async () => {
  server = spawn(process.execPath, ["backend/server.mjs"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "4175", HOST: "127.0.0.1", LOG_TO_CONSOLE: "false" },
    stdio: "ignore"
  });
  await waitForServer();
});

test.afterAll(async () => {
  if (server && !server.killed) server.kill();
});

test("switches from Demo to Realtime mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#demoModeButton")).toHaveClass(/active/);

  await Promise.all([
    page.waitForURL("**/runtime"),
    page.locator("#realtimeModeButton").click()
  ]);

  await expect(page.locator("#realtimePanel")).toBeVisible();
  await expect(page.locator("#workspaceTitle")).toHaveText("Runtime operations");
  await expect(page.locator('[data-nav="runtime"]')).toHaveClass(/active/);
  await expect(page.locator('[data-nav="evidence"]')).not.toHaveClass(/active/);
});

test("runs the demo pipeline and renders a root cause", async ({ page }) => {
  await page.goto("/");
  await page.locator("#runButton").click();

  const rootCause = page.locator("#rootCause");
  await expect(rootCause).not.toHaveText(/Waiting for agent run|Could not run incident agents/);
  await expect(rootCause).not.toHaveText("--");
});

test("injects a demo-site error", async ({ page }) => {
  await page.goto("/runtime");
  await page.locator("#failureSelect").selectOption("apiTimeout");
  await page.locator("#injectErrorButton").click();

  await expect(page.locator("#interfaceStatus")).toContainText("failure injected");
  await expect(page.locator("#demoSiteTitle")).toContainText("broken");
});

test("keeps evidence separate from runtime and filters its logs", async ({ page }) => {
  await page.goto("/evidence?tab=logs");
  await expect(page.locator("#workspaceTitle")).toHaveText("Evidence and reasoning");
  await expect(page.locator("#realtimePanel")).toBeHidden();
  await page.locator("#refreshLogsButton").click();
  await expect(page.locator("#liveLogs .log-row").first()).toBeVisible();

  await page.locator("#logSearch").fill("no-such-log-entry");
  await expect(page.locator("#liveLogs")).toContainText("No log entries match the current filter");
});

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4175/api/health");
      if (response.ok) return;
    } catch {
      // The process has not opened its listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the test server");
}
