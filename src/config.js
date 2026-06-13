import fs from "node:fs";

export function getConfig(env = process.env) {
  const mergedEnv = { ...loadDotEnv(), ...env };
  return {
    port: Number(mergedEnv.PORT || 3000),
    baseUrl: mergedEnv.BASE_URL || `http://localhost:${mergedEnv.PORT || 3000}`,
    worldAppId: mergedEnv.WORLD_APP_ID || "",
    worldRpId: mergedEnv.WORLD_RP_ID || "",
    worldRpSigningKey: mergedEnv.WORLD_RP_SIGNING_KEY || "",
    worldEnvironment: mergedEnv.WORLD_ENV || "staging",
    worldVerifyBaseUrl: mergedEnv.WORLD_VERIFY_BASE_URL || "https://developer.world.org/api/v4",
    worldEligibilityTtlMs: Number(mergedEnv.WORLD_ELIGIBILITY_TTL_MS || 24 * 60 * 60 * 1000),
    anthropicApiKey: mergedEnv.ANTHROPIC_API_KEY || "",
    anthropicModel: mergedEnv.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    dataFile: mergedEnv.DATA_FILE || "data/store.json",
  };
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
