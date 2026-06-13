import fs from "node:fs";

export function getConfig(env = process.env) {
  const mergedEnv = { ...loadDotEnv(), ...env };
  const nodeEnv = stringValue(mergedEnv.NODE_ENV) || "development";
  return {
    port: Number(mergedEnv.PORT || 3000),
    nodeEnv,
    envKeys: Object.keys(mergedEnv),
    baseUrl: stringValue(mergedEnv.BASE_URL) || `http://localhost:${mergedEnv.PORT || 3000}`,
    worldAppId: stringValue(mergedEnv.WORLD_APP_ID),
    worldRpId: stringValue(mergedEnv.WORLD_RP_ID),
    worldRpSigningKey: stringValue(mergedEnv.WORLD_RP_SIGNING_KEY),
    worldEnvironment: stringValue(mergedEnv.WORLD_ENV) || "staging",
    worldVerifyBaseUrl: stringValue(mergedEnv.WORLD_VERIFY_BASE_URL) || "https://developer.world.org/api/v4",
    worldEligibilityTtlMs: Number(mergedEnv.WORLD_ELIGIBILITY_TTL_MS || 24 * 60 * 60 * 1000),
    anthropicApiKey: stringValue(mergedEnv.ANTHROPIC_API_KEY),
    anthropicModel: stringValue(mergedEnv.ANTHROPIC_MODEL) || "claude-haiku-4-5-20251001",
    dataFile: stringValue(mergedEnv.DATA_FILE) || "data/app.sqlite",
    allowMockProviders: parseBoolean(mergedEnv.ALLOW_MOCK_PROVIDERS, nodeEnv !== "production"),
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
