import { chromium } from "playwright";
import path from "node:path";

const baseUrl = process.env.DEMO_BASE_URL || "http://localhost:3001";
const outputDir = path.resolve("artifacts/world-agent-demo-video");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outputDir, size: { width: 1440, height: 1000 } },
});

const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.click("#start-verification");
await page.waitForSelector("#qr-card:not([hidden])", { timeout: 15_000 });
await page.waitForTimeout(1300);
await page.click("#mock-verify");
await page.waitForSelector("#chat-view:not([hidden])", { timeout: 15_000 });
await page.waitForTimeout(900);
await page.fill("#prompt", "What can you help me with now that I am verified with World ID?");
await page.waitForTimeout(500);
await page.click("#send-prompt");
await page.waitForFunction(
  () => document.querySelector("#response")?.textContent?.includes("Mock Claude response"),
  null,
  { timeout: 15_000 },
);
await page.waitForTimeout(2200);

const video = page.video();
await context.close();
await browser.close();
console.log(await video.path());
