import { IDKit, identityCheck } from "https://esm.sh/@worldcoin/idkit-core@4.1.8";

const statusPill = document.querySelector("#status-pill");
const statusCopy = document.querySelector("#status-copy");
const startVerification = document.querySelector("#start-verification");
const qrCard = document.querySelector("#qr-card");
const qrCode = document.querySelector("#qr-code");
const connectorLink = document.querySelector("#connector-link");
const verifyView = document.querySelector("#verify-view");
const chatView = document.querySelector("#chat-view");
const promptInput = document.querySelector("#prompt");
const sendPrompt = document.querySelector("#send-prompt");
const response = document.querySelector("#response");
const demoPopup = document.querySelector("#demo-popup");
const demoPopupClose = document.querySelector("#demo-popup-close");

let currentUser = null;
let currentStatus = "signed_out";
let conversationClosed = false;
let currentAttemptId = null;
let pollTimer = null;
let bridgePollTimer = null;
let idkitAbortController = null;
let mockCompleteTimer = null;

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
    eligible: "US passport verified",
    ineligible: "Unverified",
    expired: "Expired",
    failed: "Failed",
  };

  if (status === "eligible") statusPill.classList.add("ok");
  if (status === "pending") statusPill.classList.add("warn");
  if (["ineligible", "expired", "failed"].includes(status)) statusPill.classList.add("bad");

  statusPill.textContent = labels[status] || status;
  statusCopy.textContent = currentUser
    ? reason || statusMessage(status)
    : "Verify your US-issued passport with World to access Claude.";

  startVerification.disabled = false;
  promptInput.disabled = status !== "eligible" || conversationClosed;
  sendPrompt.disabled = status !== "eligible" || conversationClosed;

  const isEligible = status === "eligible";
  verifyView.hidden = isEligible;
  chatView.hidden = !isEligible;
}

function statusMessage(status) {
  if (status === "eligible") return "World App verified your US-issued passport. Prompt access is enabled.";
  if (status === "pending") return "Scan the QR code with World App to verify your US-issued passport.";
  if (status === "ineligible") return "World verification did not prove a US-issued passport.";
  if (status === "expired") return "US passport verification expired. Scan again to continue chatting.";
  if (status === "failed") return "World verification failed. Start a new scan and try again.";
  return "Start US passport verification to unlock prompts.";
}

async function refresh() {
  const me = await api("/api/me");
  currentUser = me.user;
  if (currentUser) {
    setStatus(me.identity.status, me.identity.reason);
    if (me.identity.status === "eligible") await loadConversation();
  } else {
    conversationClosed = false;
    setStatus("signed_out");
  }
}

startVerification.addEventListener("click", async () => {
  startVerification.disabled = true;
  startVerification.textContent = "Preparing...";
  clearBridgePoll();
  const request = await api("/api/world/request", { method: "POST", body: "{}" });
  currentAttemptId = request.attemptId;

  if (request.mock) {
    if (mockCompleteTimer) clearTimeout(mockCompleteTimer);
    await refresh();
    const mockConnectorUri = `https://world.org/verify/mock?attempt=${encodeURIComponent(request.attemptId)}`;
    const qr = await api("/api/qr", {
      method: "POST",
      body: JSON.stringify({ text: mockConnectorUri }),
    });
    qrCode.innerHTML = qr.svg;
    connectorLink.href = mockConnectorUri;
    qrCard.hidden = false;
    startVerification.textContent = "Refreshing...";
    addMessage("assistant", "Mock World mode: showing a temporary US passport QR code.");
    mockCompleteTimer = setTimeout(() => {
      completeMockVerification().catch((error) => showSystemMessage(error.message));
    }, 1000);
    return;
  }

  if (idkitAbortController) idkitAbortController.abort();
  idkitAbortController = new AbortController();

  const connectorUri = await createWorldConnectorUri(request, idkitAbortController.signal);

  const qr = await api("/api/qr", {
    method: "POST",
    body: JSON.stringify({ text: connectorUri }),
  });
  qrCode.innerHTML = qr.svg;
  connectorLink.href = connectorUri;
  qrCard.hidden = false;
  startVerification.textContent = "Refresh QR";
  startVerification.disabled = false;
  statusCopy.textContent = "QR ready. Scan with World App, then approve the request on your phone.";
});

async function completeMockVerification() {
  if (!currentAttemptId) {
    addMessage("assistant", "Start a World passport QR request first.");
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
  await loadConversation();
  startVerification.textContent = "Verify with World";
  startVerification.disabled = false;
  if (mockCompleteTimer) {
    clearTimeout(mockCompleteTimer);
    mockCompleteTimer = null;
  }
}

sendPrompt.addEventListener("click", async () => {
  await sendChatMessage();
});

demoPopupClose.addEventListener("click", () => {
  hideDemoPopup();
});

demoPopup.addEventListener("click", (event) => {
  if (event.target === demoPopup) hideDemoPopup();
});

promptInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    await sendChatMessage();
  }
});

async function sendChatMessage() {
  const prompt = promptInput.value.trim();
  if (!prompt || sendPrompt.disabled) return;

  promptInput.value = "";
  addMessage("user", prompt);
  const pending = addMessage("assistant", "Thinking...", { pending: true });
  sendPrompt.disabled = true;
  promptInput.disabled = true;
  try {
    const result = await api("/api/llm/messages", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    updateMessage(pending, result.text);
    applyConversationState(result.conversation);
  } catch (error) {
    if (error.message === "This conversation is closed.") {
      pending.remove();
      response.scrollTop = response.scrollHeight;
      applyConversationState({ closed: true });
    } else {
      updateMessage(pending, error.message, true);
    }
  } finally {
    sendPrompt.disabled = currentStatus !== "eligible" || conversationClosed;
    promptInput.disabled = currentStatus !== "eligible" || conversationClosed;
    if (!conversationClosed) promptInput.focus();
  }
}

function addMessage(role, text, options = {}) {
  const message = document.createElement("div");
  message.className = `message ${role}${options.pending ? " pending" : ""}`;
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "Agent";
  const body = document.createElement("div");
  body.className = "message-body";
  setMessageBody(body, role, text);
  message.append(label, body);
  response.append(message);
  response.scrollTop = response.scrollHeight;
  return message;
}

function updateMessage(message, text, isError = false) {
  const body = message.querySelector(".message-body");
  message.classList.remove("pending");
  if (isError) message.classList.add("error");
  setMessageBody(body, message.classList.contains("user") ? "user" : "assistant", text);
  response.scrollTop = response.scrollHeight;
}

function setMessageBody(body, role, text) {
  if (role === "assistant") {
    body.innerHTML = renderMarkdown(text);
    return;
  }
  body.textContent = text;
}

function renderMarkdown(markdown) {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listItems = [];
  let inCodeBlock = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    listItems = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        html.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushList();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const listItem = trimmed.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1]);
      continue;
    }

    const quote = trimmed.match(/^&gt;\s+(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  if (inCodeBlock) html.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  return html.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearConversation() {
  response.replaceChildren();
}

function resetConversation() {
  clearConversation();
  addMessage("assistant", "US passport verified. Ask the agent anything.");
}

async function loadConversation() {
  const conversation = await api("/api/conversation");
  applyConversationState(conversation.conversation, { silent: true });
  clearConversation();
  if (!conversation.messages.length) {
    resetConversation();
    return;
  }
  for (const message of conversation.messages) {
    addMessage(message.role, message.content);
  }
  if (conversationClosed) showDemoPopup();
}

function applyConversationState(conversation = {}, options = {}) {
  const wasClosed = conversationClosed;
  conversationClosed = Boolean(conversation.closed);
  promptInput.disabled = currentStatus !== "eligible" || conversationClosed;
  sendPrompt.disabled = currentStatus !== "eligible" || conversationClosed;
  if (conversationClosed && !wasClosed && !options.silent) {
    showDemoPopup();
  }
}

function showDemoPopup() {
  demoPopup.hidden = false;
  demoPopupClose.focus();
}

function hideDemoPopup() {
  demoPopup.hidden = true;
}

function showSystemMessage(text) {
  addMessage("assistant", text);
}

refresh().catch((error) => {
  showSystemMessage(error.message);
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
  }).preset(identityCheck({
    attributes: request.identityAttributes,
    legacy_signal: request.signal,
  }));

  statusCopy.textContent = "Waiting for World App scan...";
  startBridgePolling(idkitRequest, request, signal);

  return idkitRequest.connectorURI;
}

function startBridgePolling(idkitRequest, request, signal) {
  const startedAt = Date.now();
  clearBridgePoll();
  bridgePollTimer = setInterval(async () => {
    if (signal.aborted) {
      clearBridgePoll();
      return;
    }
    if (Date.now() - startedAt > 120000) {
      clearBridgePoll();
      statusCopy.textContent = "World verification timed out. Start a new scan.";
      startVerification.textContent = "Try again";
      startVerification.disabled = false;
      return;
    }

    try {
      const status = await idkitRequest.pollOnce();
      statusCopy.textContent = bridgeStatusMessage(status.type);
      if (status.type === "failed") {
        clearBridgePoll();
        const message = `World verification failed: ${status.error || "generic_error"}`;
        statusCopy.textContent = message;
        showSystemMessage(message);
        startVerification.textContent = "Try again";
        startVerification.disabled = false;
        return;
      }
      if (status.type === "confirmed" && status.result) {
        clearBridgePoll();
        await submitWorldProof(request, status.result);
      }
    } catch (error) {
      clearBridgePoll();
      statusCopy.textContent = error.message;
      showSystemMessage(error.message);
      startVerification.textContent = "Try again";
      startVerification.disabled = false;
    }
  }, 2000);
}

async function submitWorldProof(request, result) {
  statusCopy.textContent = "World App approved. Verifying proof...";
  try {
    await api("/api/world/verify", {
      method: "POST",
      body: JSON.stringify({
        ...result,
        attemptId: request.attemptId,
        action: request.action,
        signal: request.signal,
      }),
    });
  } catch (error) {
    statusCopy.textContent = error.message;
    showSystemMessage(error.message);
    startVerification.textContent = "Try again";
    startVerification.disabled = false;
    return;
  }
  await refresh();
  await loadConversation();
}

function bridgeStatusMessage(status) {
  if (status === "waiting_for_connection") return "Waiting for World App to open the QR request...";
  if (status === "awaiting_confirmation") return "World App opened the request. Waiting for approval...";
  if (status === "confirmed") return "World App approved. Verifying proof...";
  if (status === "failed") return "World verification failed.";
  return `World status: ${status}`;
}

function clearBridgePoll() {
  if (bridgePollTimer) {
    clearInterval(bridgePollTimer);
    bridgePollTimer = null;
  }
}
