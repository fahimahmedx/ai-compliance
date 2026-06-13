export async function sendClaudeMessage(config, messages, { maxTokens = 1024 } = {}) {
  if (!config.anthropicApiKey) {
    if (config.allowMockProviders === false || config.nodeEnv === "production") {
      throw new Error("ANTHROPIC_API_KEY is not configured for production.");
    }
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    return {
      id: "mock_claude_response",
      text: `Mock Claude response:\n\n${lastUserMessage?.content || ""}`,
      usage: { inputTokens: 0, outputTokens: 0 },
      mock: true,
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      messages,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || "Anthropic request failed");
  }

  return {
    id: payload.id,
    text: extractText(payload),
    usage: normalizeUsage(payload.usage),
    mock: false,
  };
}

function extractText(payload) {
  return (payload.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
  };
}
