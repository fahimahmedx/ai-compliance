import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { SqliteStore } from "../src/store.js";

test("verified users only receive their own persisted conversation", async () => {
  const app = await startTestServer();
  try {
    const alice = await verifyMockUser(app);
    const bob = await verifyMockUser(app);

    await api(app, "/api/llm/messages", {
      method: "POST",
      cookie: alice.cookie,
      body: { prompt: "alice private prompt" },
    });
    await api(app, "/api/llm/messages", {
      method: "POST",
      cookie: bob.cookie,
      body: { prompt: "bob private prompt" },
    });

    const aliceConversation = await api(app, "/api/conversation", { cookie: alice.cookie });
    const bobConversation = await api(app, "/api/conversation", { cookie: bob.cookie });

    assert.deepEqual(
      aliceConversation.messages.filter((message) => message.role === "user").map((message) => message.content),
      ["alice private prompt"],
    );
    assert.deepEqual(
      bobConversation.messages.filter((message) => message.role === "user").map((message) => message.content),
      ["bob private prompt"],
    );
    assert.equal(aliceConversation.messages.some((message) => message.content.includes("bob private prompt")), false);
    assert.equal(bobConversation.messages.some((message) => message.content.includes("alice private prompt")), false);
  } finally {
    await app.close();
  }
});

test("verified users can send five messages before the conversation closes", async () => {
  const app = await startTestServer();
  try {
    const user = await verifyMockUser(app);

    for (let index = 1; index <= 5; index += 1) {
      const result = await api(app, "/api/llm/messages", {
        method: "POST",
        cookie: user.cookie,
        body: { prompt: `prompt ${index}` },
      });
      assert.equal(result.conversation.closed, index === 5);
      assert.equal(result.conversation.userMessageCount, index);
    }

    const conversation = await api(app, "/api/conversation", { cookie: user.cookie });
    assert.equal(conversation.conversation.closed, true);
    assert.equal(conversation.conversation.userMessageCount, 5);

    const blocked = await api(app, "/api/llm/messages", {
      method: "POST",
      cookie: user.cookie,
      body: { prompt: "prompt 6" },
      expectOk: false,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "This conversation is closed.");
  } finally {
    await app.close();
  }
});

test("user-facing API responses do not expose credit or cost details", async () => {
  const app = await startTestServer();
  try {
    const user = await verifyMockUser(app);

    const me = await api(app, "/api/me", { cookie: user.cookie });
    const message = await api(app, "/api/llm/messages", {
      method: "POST",
      cookie: user.cookie,
      body: { prompt: "hello" },
    });
    const conversation = await api(app, "/api/conversation", { cookie: user.cookie });

    assert.equal("credits" in user.body, false);
    assert.equal("credits" in me, false);
    assert.equal("credits" in conversation, false);
    assert.equal("credits" in message, false);
    assert.equal("usage" in message, false);
    assert.equal("costMicros" in message, false);
    assert.equal("costMicros" in message.message, false);
    assert.equal("inputTokens" in conversation.messages[0], false);
    assert.equal("outputTokens" in conversation.messages[0], false);
    assert.equal("costMicros" in conversation.messages[0], false);
  } finally {
    await app.close();
  }
});

async function startTestServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-compliance-server-"));
  const config = {
    port: 0,
    baseUrl: "http://127.0.0.1",
    worldEnvironment: "staging",
    worldEligibilityTtlMs: 60_000,
    anthropicApiKey: "",
    anthropicModel: "claude-haiku-4-5-20251001",
    dataFile: path.join(tempDir, "app.sqlite"),
  };
  const store = new SqliteStore(config.dataFile);
  const server = createServer({ config, store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl: config.baseUrl,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function verifyMockUser(app) {
  const request = await api(app, "/api/world/request", { method: "POST", body: {} });
  const result = await api(app, "/api/world/verify", {
    method: "POST",
    body: {
      attemptId: request.attemptId,
      action: request.action,
      mock: true,
    },
    includeHeaders: true,
  });
  return {
    cookie: result.headers.get("set-cookie").split(";")[0],
    body: result.body,
  };
}

async function api(app, pathname, options = {}) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (options.expectOk === false) return { status: response.status, body, headers: response.headers };
  if (!response.ok) {
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  if (options.includeHeaders) return { body, headers: response.headers };
  return body;
}
