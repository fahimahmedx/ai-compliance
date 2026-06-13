import test from "node:test";
import assert from "node:assert/strict";
import { sendClaudeMessage } from "../src/anthropic.js";

test("Claude mock response is allowed outside production without an API key", async () => {
  const result = await sendClaudeMessage(
    { nodeEnv: "development", allowMockProviders: true, anthropicApiKey: "" },
    [{ role: "user", content: "hello" }],
  );

  assert.equal(result.mock, true);
  assert.match(result.text, /Mock Claude response/);
});

test("Claude mock response is rejected in production without an API key", async () => {
  await assert.rejects(
    () => sendClaudeMessage(
      { nodeEnv: "production", allowMockProviders: false, anthropicApiKey: "" },
      [{ role: "user", content: "hello" }],
    ),
    /ANTHROPIC_API_KEY is not configured for production/,
  );
});
