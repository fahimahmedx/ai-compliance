export async function sendClaudeMessage(config, prompt) {
  if (!config.anthropicApiKey) {
    return {
      id: "mock_claude_response",
      text: `Mock Claude response:\n\n${prompt}`,
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
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || "Anthropic request failed");
  }

  return {
    id: payload.id,
    text: extractText(payload),
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
