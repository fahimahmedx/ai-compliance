import { chromium } from "playwright";
import path from "node:path";

const baseUrl = process.env.DEMO_BASE_URL || "http://localhost:3001";
const outputDir = path.resolve("artifacts/x-demo-video");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outputDir, size: { width: 1280, height: 720 } },
});

const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

await page.click("#start-verification");
await page.waitForSelector("#chat-view:not([hidden])", { timeout: 15_000 });
await page.waitForTimeout(900);

await page.fill("#prompt", "Write a viral one-liner about why AI agents should verify humans before responding.");
await page.waitForTimeout(450);
await page.click("#send-prompt");
await page.waitForFunction(
  () => {
    const messages = Array.from(document.querySelectorAll(".message .message-body")).map((el) => el.textContent || "");
    return messages.length >= 3 && !messages.at(-1)?.includes("Thinking...");
  },
  null,
  { timeout: 45_000 },
);
await page.waitForTimeout(2200);

await page.fill("#prompt", "Now make it even shorter for X.");
await page.waitForTimeout(350);
await page.click("#send-prompt");
await page.waitForFunction(
  () => {
    const messages = Array.from(document.querySelectorAll(".message .message-body")).map((el) => el.textContent || "");
    return messages.length >= 5 && !messages.at(-1)?.includes("Thinking...");
  },
  null,
  { timeout: 45_000 },
);
await page.waitForTimeout(2800);

const video = page.video();
await context.close();
await browser.close();
console.log(await video.path());
