import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { SqliteStore } from "./store.js";
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
const INPUT_MICROS_PER_TOKEN = 1;
const OUTPUT_MICROS_PER_TOKEN = 5;
const MAX_OUTPUT_TOKENS = 1024;

export function createServer({ config = getConfig(), store = new SqliteStore(config.dataFile) } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.baseUrl);

      if (req.method === "GET" && url.pathname === "/api/me") {
        const user = getCurrentUser(req, store);
        const verification = user ? store.getVerification(user.id) : null;
        return sendJson(res, 200, {
          user,
          identity: user ? getWorldEligibilityStatus(verification) : { status: "signed_out" },
          credits: user ? formatCredits(store.getCreditBalance(user.id)) : formatCredits(0),
          model: config.anthropicModel,
        });
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
        const user = getCurrentUser(req, store);
        const request = await createWorldVerificationRequest({ config, store, user });
        if (user) {
          store.saveVerification(user.id, {
            provider: "world",
            worldAttemptId: request.attemptId,
            eligibilityStatus: "pending",
            reasonCode: "verification_pending",
            reason: "Scan the World App QR code to verify your World ID.",
          });
        }
        return sendJson(res, 200, request);
      }

      if (req.method === "GET" && url.pathname === "/api/identity/status") {
        const user = getCurrentUser(req, store);
        if (!user) {
          return sendJson(res, 200, {
            status: "pending",
            reason: "Scan the World App QR code to verify your World ID.",
          });
        }
        const verification = store.getVerification(user.id);
        return sendJson(res, 200, getWorldEligibilityStatus(verification));
      }

      if (req.method === "POST" && url.pathname === "/api/world/verify") {
        const user = getCurrentUser(req, store);
        const payload = await readJson(req);
        const result = await verifyWorldProof({
          config,
          store,
          user,
          payload,
        });
        if (!result.ok) {
          console.warn("World verification rejected", {
            reasonCode: result.reasonCode,
            reason: result.reason,
            attemptId: payload?.attemptId,
          });
          if (user) store.saveVerification(user.id, {
            provider: "world",
            eligibilityStatus: "ineligible",
            reasonCode: result.reasonCode,
            reason: result.reason,
          });
          return sendError(res, 403, result.reason);
        }
        const token = store.createSession(result.user.id);
        return sendJson(res, 200, {
          user: result.user,
          verification: result.verification,
          credits: formatCredits(store.getCreditBalance(result.user.id)),
        }, {
          "set-cookie": sessionCookie(token, config),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/qr") {
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

      if (req.method === "GET" && url.pathname === "/api/conversation") {
        const user = requireUser(req, res, store);
        if (!user) return;
        return sendJson(res, 200, {
          messages: store.getConversationMessages(user.id),
          credits: formatCredits(store.getCreditBalance(user.id)),
        });
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

        const history = store.getConversationMessages(user.id).map(({ role, content }) => ({ role, content }));
        const messages = [...history, { role: "user", content: prompt.trim() }];
        let reservation = null;
        let maxTokens = MAX_OUTPUT_TOKENS;

        if (config.anthropicApiKey) {
          const estimatedInputCost = estimateInputTokens(messages) * INPUT_MICROS_PER_TOKEN;
          const balance = store.getCreditBalance(user.id);
          if (balance <= estimatedInputCost) {
            store.addAuditEvent({
              userId: user.id,
              allowed: false,
              promptLength: prompt.length,
              reasonCode: "insufficient_credits",
            });
            return sendError(res, 402, "You have used your Claude credits.");
          }
          maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.floor((balance - estimatedInputCost) / OUTPUT_MICROS_PER_TOKEN));
          if (maxTokens < 1) return sendError(res, 402, "You have used your Claude credits.");
          const reservationCost = estimatedInputCost + maxTokens * OUTPUT_MICROS_PER_TOKEN;
          reservation = store.createCreditReservation(user.id, reservationCost);
          if (!reservation) return sendError(res, 402, "You have used your Claude credits.");
        }

        let result;
        try {
          result = await sendClaudeMessage(config, messages, { maxTokens });
        } catch (error) {
          if (reservation) store.releaseCreditReservation(reservation.id);
          throw error;
        }

        const costMicros = result.mock ? 0 : calculateCostMicros(result.usage);
        if (reservation) {
          store.finalizeCreditReservation(reservation.id, costMicros, result.usage, result.id);
        }
        store.addMessage(user.id, { role: "user", content: prompt.trim(), mock: result.mock });
        const assistantMessage = store.addMessage(user.id, {
          role: "assistant",
          content: result.text,
          anthropicMessageId: result.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costMicros,
          mock: result.mock,
        });
        store.addAuditEvent({
          userId: user.id,
          allowed: true,
          promptLength: prompt.length,
          anthropicMessageId: result.id,
          mock: result.mock,
        });
        return sendJson(res, 200, {
          text: result.text,
          message: assistantMessage,
          mock: result.mock,
          usage: result.usage,
          costMicros,
          credits: formatCredits(store.getCreditBalance(user.id)),
        });
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

function sessionCookie(token, config) {
  const secure = config.baseUrl.startsWith("https://") ? "; Secure" : "";
  return `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

function formatCredits(balanceMicros) {
  return {
    balanceMicros,
    balanceUsd: balanceMicros / 1_000_000,
    displayCents: balanceMicros / 10_000,
  };
}

function estimateInputTokens(messages) {
  const textLength = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(textLength / 3) + messages.length * 8 + 100;
}

function calculateCostMicros(usage = {}) {
  return usage.inputTokens * INPUT_MICROS_PER_TOKEN + usage.outputTokens * OUTPUT_MICROS_PER_TOKEN;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = getConfig();
  createServer({ config }).listen(config.port, () => {
    console.log(`AI compliance MVP listening on http://localhost:${config.port}`);
  });
}
