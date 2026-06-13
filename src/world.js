import crypto from "node:crypto";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";

export const WORLD_ACTION = "world-id-chat-access-v1";
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function createWorldVerificationRequest({ config, store, user }) {
  const attemptId = crypto.randomUUID();
  const action = `${WORLD_ACTION}-${attemptId.slice(0, 8)}`;
  const attempt = store.createWorldAttempt(user?.id || null, {
    id: attemptId,
    action,
    signal: user?.id ? `user:${user.id}` : `attempt:${attemptId}`,
    expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS).toISOString(),
  });

  const rpSignature = hasWorldConfig(config)
    ? signRequest({
      signingKeyHex: config.worldRpSigningKey,
      action,
      ttl: Math.floor(ATTEMPT_TTL_MS / 1000),
    })
    : mockRpSignature();

  store.updateWorldAttempt(attempt.id, {
    nonce: rpSignature.nonce,
    rpSignatureExpiresAt: new Date(rpSignature.expiresAt * 1000).toISOString(),
  });

  return {
    attemptId: attempt.id,
    expiresAt: attempt.expiresAt,
    appId: config.worldAppId || "app_staging_dev_mock",
    rpId: config.worldRpId || "rp_staging_dev_mock",
    action: attempt.action,
    flow: "action",
    signal: attempt.signal,
    environment: config.worldEnvironment,
    allowLegacyProofs: true,
    requireUserPresence: false,
    rpContext: {
      rp_id: config.worldRpId || "rp_staging_dev_mock",
      nonce: rpSignature.nonce,
      created_at: rpSignature.createdAt,
      expires_at: rpSignature.expiresAt,
      signature: rpSignature.sig,
    },
    credentialPreset: "proofOfHuman",
    mock: !hasWorldConfig(config),
  };
}

export async function verifyWorldProof({ config, store, user, payload }) {
  const attempt = store.getWorldAttempt(payload?.attemptId);
  if (!attempt || (user && attempt.userId && attempt.userId !== user.id)) {
    return deny("missing_attempt", "World verification attempt was not found for this session.");
  }
  if (attempt.consumedAt) {
    return deny("attempt_consumed", "World verification attempt has already been used.");
  }
  if (new Date(attempt.expiresAt) <= new Date()) {
    return deny("attempt_expired", "World verification attempt expired. Start a new scan.");
  }
  const isDevMock = payload.mock && !hasWorldConfig(config);
  if (!payload.action || payload.action !== attempt.action) {
    return deny("wrong_action", "World proof action did not match this verification request.");
  }
  if (!isDevMock && (!payload.nonce || payload.nonce !== attempt.nonce)) {
    return deny("wrong_nonce", "World proof nonce did not match this verification request.");
  }
  if (!isDevMock && !hasExpectedSignalHash(payload, attempt.signal)) {
    return deny("wrong_signal", "World proof signal did not match this desktop session.");
  }

  const result = isDevMock
    ? mockWorldVerifyResponse(attempt)
    : await callWorldVerifyApi(config, attempt, payload);

  if (!result.success) {
    return deny("world_verify_failed", result.detail || "World verification failed.");
  }
  if (!result.has_world_id) {
    return deny("world_id_not_proven", "World proof did not include a World ID credential.");
  }

  const nullifierHash = result.nullifier_hash || payload.nullifier_hash;
  if (!nullifierHash) {
    return deny("missing_nullifier", "World proof did not include a nullifier.");
  }
  store.consumeWorldAttempt(attempt.id);
  const verifiedUser = store.getOrCreateUserByWorldNullifier(nullifierHash);
  const expiresAt = new Date(Date.now() + config.worldEligibilityTtlMs).toISOString();
  const verification = store.saveVerification(verifiedUser.id, {
    provider: "world",
    action: attempt.action,
    worldAttemptId: attempt.id,
    eligibilityStatus: "eligible",
    reasonCode: "world_id_verified",
    reason: "World App verified a World ID.",
    worldNullifierHash: nullifierHash,
    verifiedAt: new Date().toISOString(),
    eligibilityExpiresAt: expiresAt,
  });

  return { ok: true, user: verifiedUser, verification };
}

export function getWorldEligibilityStatus(verification) {
  if (!verification) {
    return {
      status: "pending",
      reason: "Scan the World App QR code to verify your World ID.",
    };
  }
  if (verification.eligibilityStatus === "eligible" && verification.eligibilityExpiresAt) {
    if (new Date(verification.eligibilityExpiresAt) <= new Date()) {
      return {
        status: "expired",
        reason: "World verification expired. Scan again to continue chatting.",
      };
    }
  }
  return {
    status: verification.eligibilityStatus || "pending",
    reason: verification.reason || "Scan the World App QR code to verify your World ID.",
    provider: verification.provider || null,
    verifiedAt: verification.verifiedAt || null,
    eligibilityExpiresAt: verification.eligibilityExpiresAt || null,
  };
}

export function isWorldEligible(verification) {
  return getWorldEligibilityStatus(verification).status === "eligible";
}

async function callWorldVerifyApi(config, attempt, payload) {
  if (!hasWorldConfig(config)) {
    return {
      success: false,
      detail: "World ID configuration is missing.",
    };
  }

  const response = await fetch(`${config.worldVerifyBaseUrl}/verify/${encodeURIComponent(config.worldRpId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toWorldVerifyPayload(payload)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isNullifierReplay(body) && getPayloadNullifier(payload)) {
      return {
        success: true,
        has_world_id: hasWorldIdCredential(payload),
        nullifier_hash: getPayloadNullifier(payload),
        detail: body.detail || body.error,
        replayed: true,
      };
    }
    return {
      success: false,
      detail: body.detail || body.error || `World verify failed with ${response.status}`,
    };
  }
  return normalizeWorldVerifyResponse(body, payload);
}

function normalizeWorldVerifyResponse(body, payload) {
  return {
    success: body.success === true,
    has_world_id: hasWorldIdCredential(payload),
    nullifier_hash: body.nullifier_hash || getPayloadNullifier(payload),
    detail: body.detail || body.error,
  };
}

function normalizeWorldSessionResponse(payload) {
  return {
    success: Boolean(payload.session_id),
    has_world_id: hasWorldIdCredential(payload),
    nullifier_hash: getSessionNullifier(payload),
    detail: payload.error,
  };
}

function mockWorldVerifyResponse(attempt) {
  return {
    success: true,
    has_world_id: true,
    nullifier_hash: `mock_nullifier_${attempt.id}`,
  };
}

function hasWorldIdCredential(payload) {
  const identifiers = new Set((payload.responses || []).map((response) => response.identifier));
  return identifiers.has("proof_of_human") || identifiers.has("orb") || identifiers.has("device");
}

function getPayloadNullifier(payload) {
  return payload.nullifier_hash || payload.responses?.find((response) => response.nullifier)?.nullifier || null;
}

function getSessionNullifier(payload) {
  const value = payload.responses?.find((response) => response.session_nullifier)?.session_nullifier;
  return Array.isArray(value) ? value[0] : null;
}

function isNullifierReplay(body) {
  const value = `${body?.code || ""} ${body?.detail || ""} ${body?.error || ""}`;
  return value.includes("nullifier_replayed");
}

function hasExpectedSignalHash(payload, signal) {
  const expected = hashSignal(signal).toLowerCase();
  return (payload.responses || []).some((response) => response.signal_hash?.toLowerCase() === expected);
}

function toWorldVerifyPayload(payload) {
  const {
    attemptId,
    signal,
    mock,
    ...idkitResult
  } = payload;
  return idkitResult;
}

function deny(reasonCode, reason) {
  return { ok: false, reasonCode, reason };
}

function hasWorldConfig(config) {
  return Boolean(config.worldAppId && config.worldRpId && config.worldRpSigningKey);
}

function mockRpSignature() {
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    sig: "0x" + "00".repeat(65),
    nonce: "0x" + crypto.randomBytes(32).toString("hex"),
    createdAt,
    expiresAt: createdAt + Math.floor(ATTEMPT_TTL_MS / 1000),
  };
}
