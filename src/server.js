import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { readJson, sendError, sendJson, serveStatic, getCookie } from "./http.js";
import { sendClaudeMessage } from "./anthropic.js";
import QRCode from "qrcode";
import {
  createWorldVerificationRequest,
  getWorldEligibilityStatus,
  isWorldEligible,
  verifyWorldProof,
} from "./world.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

export function createServer({ config = getConfig(), store = new JsonStore(config.dataFile) } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.baseUrl);

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const { email } = await readJson(req);
        if (!email || !email.includes("@")) return sendError(res, 400, "Valid email is required");
        const user = store.getOrCreateUser(email);
        const token = store.createSession(user.id);
        return sendJson(res, 200, { user }, {
          "set-cookie": `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const user = getCurrentUser(req, store);
        return sendJson(res, 200, { user });
      }

      if (req.method === "GET" && url.pathname === "/api/config/status") {
        return sendJson(res, 200, {
          world: {
            appIdConfigured: Boolean(config.worldAppId),
            rpIdConfigured: Boolean(config.worldRpId),
            signingKeyConfigured: Boolean(config.worldRpSigningKey),
            environment: config.worldEnvironment,
          },
          anthropic: {
            apiKeyConfigured: Boolean(config.anthropicApiKey),
            model: config.anthropicModel,
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/world/request") {
        const user = requireUser(req, res, store);
        if (!user) return;
        const request = await createWorldVerificationRequest({ config, store, user });
        store.saveVerification(user.id, {
          provider: "world",
          worldAttemptId: request.attemptId,
          eligibilityStatus: "pending",
          reasonCode: "verification_pending",
          reason: "Scan the World App QR code to verify your World ID.",
        });
        return sendJson(res, 200, request);
      }

      if (req.method === "GET" && url.pathname === "/api/identity/status") {
        const user = requireUser(req, res, store);
        if (!user) return;
        const verification = store.getVerification(user.id);
        return sendJson(res, 200, getWorldEligibilityStatus(verification));
      }

      if (req.method === "POST" && url.pathname === "/api/world/verify") {
        const user = requireUser(req, res, store);
        if (!user) return;
        const result = await verifyWorldProof({
          config,
          store,
          user,
          payload: await readJson(req),
        });
        if (!result.ok) {
          store.saveVerification(user.id, {
            provider: "world",
            eligibilityStatus: "ineligible",
            reasonCode: result.reasonCode,
            reason: result.reason,
          });
          return sendError(res, 403, result.reason);
        }
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/api/qr") {
        const user = requireUser(req, res, store);
        if (!user) return;
        const { text } = await readJson(req);
        if (!text || typeof text !== "string") return sendError(res, 400, "QR text is required");
        if (text.length > 4096) return sendError(res, 413, "QR text is too long");
        const svg = await QRCode.toString(text, {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 2,
          width: 240,
        });
        return sendJson(res, 200, { svg });
      }

      if (req.method === "POST" && url.pathname === "/api/llm/messages") {
        const user = requireUser(req, res, store);
        if (!user) return;

        const verification = store.getVerification(user.id);
        if (!isWorldEligible(verification)) {
          store.addAuditEvent({
            userId: user.id,
            allowed: false,
            promptLength: 0,
            reasonCode: verification?.reasonCode || getWorldEligibilityStatus(verification).status,
          });
          return sendError(res, 403, "Scan World App to verify your World ID before prompting the LLM.");
        }

        const { prompt } = await readJson(req);
        if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
          return sendError(res, 400, "Prompt is required");
        }
        if (prompt.length > 8000) {
          return sendError(res, 413, "Prompt is too long for this MVP");
        }

        const result = await sendClaudeMessage(config, prompt);
        store.addAuditEvent({
          userId: user.id,
          allowed: true,
          promptLength: prompt.length,
          anthropicMessageId: result.id,
          mock: result.mock,
        });
        return sendJson(res, 200, { text: result.text, mock: result.mock });
      }

      if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, publicDir)) return;
      sendError(res, 404, "Not found");
    } catch (error) {
      sendError(res, 500, error.message || "Internal server error");
    }
  });
}

function getCurrentUser(req, store) {
  const token = getCookie(req, "sid");
  if (!token) return null;
  return store.getUserBySession(token);
}

function requireUser(req, res, store) {
  const user = getCurrentUser(req, store);
  if (!user) {
    sendError(res, 401, "Sign in is required");
    return null;
  }
  return user;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = getConfig();
  createServer({ config }).listen(config.port, () => {
    console.log(`AI compliance MVP listening on http://localhost:${config.port}`);
  });
}
