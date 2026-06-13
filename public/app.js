import { IDKit, proofOfHuman } from "https://esm.sh/@worldcoin/idkit-core@4.1.8";

const loginForm = document.querySelector("#login-form");
const emailInput = document.querySelector("#email");
const statusPill = document.querySelector("#status-pill");
const statusCopy = document.querySelector("#status-copy");
const startVerification = document.querySelector("#start-verification");
const mockVerify = document.querySelector("#mock-verify");
const qrCard = document.querySelector("#qr-card");
const qrCode = document.querySelector("#qr-code");
const connectorLink = document.querySelector("#connector-link");
const verifyView = document.querySelector("#verify-view");
const chatView = document.querySelector("#chat-view");
const promptInput = document.querySelector("#prompt");
const sendPrompt = document.querySelector("#send-prompt");
const response = document.querySelector("#response");

let currentUser = null;
let currentStatus = "signed_out";
let currentAttemptId = null;
let pollTimer = null;
let idkitAbortController = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed with ${res.status}`);
  }
  return data;
}

function setStatus(status, reason) {
  currentStatus = status;
  statusPill.className = "pill";
  const labels = {
    signed_out: "Signed out",
    pending: "Pending",
    eligible: "Eligible",
    ineligible: "Ineligible",
    expired: "Expired",
    failed: "Failed",
  };

  if (status === "eligible") statusPill.classList.add("ok");
  if (status === "pending") statusPill.classList.add("warn");
  if (["ineligible", "expired", "failed"].includes(status)) statusPill.classList.add("bad");

  statusPill.textContent = labels[status] || status;
  statusCopy.textContent = currentUser
    ? reason || statusMessage(status)
    : "Verify with World to unlock the agent.";

  const signedIn = Boolean(currentUser);
  startVerification.disabled = false;
  mockVerify.disabled = !signedIn || !currentAttemptId;
  promptInput.disabled = status !== "eligible";
  sendPrompt.disabled = status !== "eligible";

  const isEligible = status === "eligible";
  verifyView.hidden = isEligible;
  chatView.hidden = !isEligible;
}

function statusMessage(status) {
  if (status === "eligible") return "World App verified your World ID. Prompt access is enabled.";
  if (status === "pending") return "Scan the QR code with World App to verify your World ID.";
  if (status === "ineligible") return "World verification did not prove a World ID.";
  if (status === "expired") return "World verification expired. Scan again to continue chatting.";
  if (status === "failed") return "World verification failed. Start a new scan and try again.";
  return "Start World App verification to unlock prompts.";
}

async function refresh() {
  const me = await api("/api/me");
  currentUser = me.user;
  if (currentUser) {
    emailInput.value = currentUser.email;
    const status = await api("/api/identity/status");
    setStatus(status.status, status.reason);
  } else {
    setStatus("signed_out");
  }
}

async function ensureSession() {
  if (currentUser) return;
  const email = emailInput.value || `human-${Date.now()}@world.local`;
  await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  await refresh();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  response.textContent = "";
  await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: emailInput.value }),
  });
  await refresh();
});

startVerification.addEventListener("click", async () => {
  response.textContent = "";
  startVerification.disabled = true;
  startVerification.textContent = "Preparing...";
  await ensureSession();
  const request = await api("/api/world/request", { method: "POST", body: "{}" });
  currentAttemptId = request.attemptId;

  if (idkitAbortController) idkitAbortController.abort();
  idkitAbortController = new AbortController();

  const connectorUri = request.mock
    ? `https://world.org/verify/mock?attempt=${encodeURIComponent(request.attemptId)}`
    : await createWorldConnectorUri(request, idkitAbortController.signal);

  const qr = await api("/api/qr", {
    method: "POST",
    body: JSON.stringify({ text: connectorUri }),
  });
  qrCode.innerHTML = qr.svg;
  connectorLink.href = connectorUri;
  qrCard.hidden = false;
  mockVerify.disabled = !request.mock;
  response.textContent = request.mock
    ? "World is not configured. Use mock completion for local development."
    : "Scan the QR code with World App, then return here.";
  startVerification.textContent = "Refresh QR";
  startVerification.disabled = false;
  startPolling();
});

mockVerify.addEventListener("click", async () => {
  response.textContent = "";
  if (!currentAttemptId) {
    response.textContent = "Start a World QR request first.";
    return;
  }
  await api("/api/world/verify", {
    method: "POST",
    body: JSON.stringify({
      attemptId: currentAttemptId,
      action: "world-id-chat-access-v1",
      mock: true,
    }),
  });
  await refresh();
});

sendPrompt.addEventListener("click", async () => {
  response.textContent = "Sending...";
  try {
    const result = await api("/api/llm/messages", {
      method: "POST",
      body: JSON.stringify({ prompt: promptInput.value }),
    });
    response.textContent = result.text;
  } catch (error) {
    response.textContent = error.message;
  }
});

refresh().catch((error) => {
  response.textContent = error.message;
  setStatus("signed_out");
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await refresh();
      if (currentStatus === "eligible") {
        clearInterval(pollTimer);
      }
    } catch {
      clearInterval(pollTimer);
    }
  }, 2500);
}

async function createWorldConnectorUri(request, signal) {
  const idkitRequest = await IDKit.request({
    app_id: request.appId,
    action: request.action,
    rp_context: request.rpContext,
    allow_legacy_proofs: request.allowLegacyProofs,
    require_user_presence: request.requireUserPresence,
    environment: request.environment,
  }).preset(proofOfHuman({ signal: request.signal }));

  idkitRequest.pollUntilCompletion({
    pollInterval: 2000,
    timeout: 120000,
    signal,
  }).then(async (completion) => {
    if (!completion.success) {
      response.textContent = `World verification failed: ${completion.error}`;
      await refresh();
      return;
    }

    await api("/api/world/verify", {
      method: "POST",
      body: JSON.stringify({
        ...completion.result,
        attemptId: request.attemptId,
        action: request.action,
        signal: request.signal,
      }),
    });
    await refresh();
    response.textContent = "World ID verified. Ask the agent anything.";
  }).catch((error) => {
    if (error.name !== "AbortError") response.textContent = error.message;
  });

  return idkitRequest.connectorURI;
}
