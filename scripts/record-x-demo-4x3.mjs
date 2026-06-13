import { chromium } from "playwright";
import path from "node:path";

const baseUrl = process.env.DEMO_BASE_URL || "http://localhost:3001";
const outputDir = path.resolve("artifacts/x-demo-4x3-video");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outputDir, size: { width: 1440, height: 1080 } },
});

const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.addStyleTag({
  content: `
    .demo-badge {
      position: fixed;
      left: 28px;
      bottom: 28px;
      z-index: 20;
      padding: 12px 16px;
      border-radius: 999px;
      background: #050505;
      color: white;
      font: 800 17px Inter, system-ui, sans-serif;
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 360ms ease, transform 360ms ease;
    }
    .demo-badge.show {
      opacity: 1;
      transform: translateY(0);
    }
  `,
});
await page.evaluate(() => {
  const badge = document.createElement("div");
  badge.className = "demo-badge";
  document.body.append(badge);
});

const showBadge = async (text) => {
  await page.evaluate((value) => {
    const badge = document.querySelector(".demo-badge");
    badge.textContent = value;
    badge.classList.add("show");
  }, text);
};
const hideBadge = async () => {
  await page.evaluate(() => document.querySelector(".demo-badge")?.classList.remove("show"));
};

await page.waitForTimeout(700);
await showBadge("1. Verify with World");
await page.waitForTimeout(900);
await page.click("#start-verification");
await page.waitForSelector("#chat-view:not([hidden])", { timeout: 15_000 });
await showBadge("Verified US Citizen 🇺🇸");
await page.waitForTimeout(1200);
await hideBadge();

await showBadge("2. Chat with the agent");
await page.waitForTimeout(600);
await page.fill("#prompt", "Write one punchy X post about verified US Citizens getting access to AI agents.");
await page.waitForTimeout(400);
await page.click("#send-prompt");
await page.waitForFunction(
  () => {
    const messages = Array.from(document.querySelectorAll(".message .message-body")).map((el) => el.textContent || "");
    return messages.length >= 3 && !messages.at(-1)?.includes("Thinking...");
  },
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(3600);
await hideBadge();
await page.waitForTimeout(500);

const video = page.video();
await context.close();
await browser.close();
console.log(await video.path());
