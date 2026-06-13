import test from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { createWorldVerificationRequest, getWorldEligibilityStatus, verifyWorldProof } from "../src/world.js";

test("World request uses basic proof-of-human without user presence", () => {
  const store = makeStore();
  const request = createWorldVerificationRequest({
    config: { worldEnvironment: "staging" },
    store,
    user: { id: "user_1" },
  });

  assert.equal(request.requireUserPresence, false);
  assert.equal(request.credentialPreset, "proofOfHuman");
  assert.equal(request.allowLegacyProofs, true);
});

test("dev mock World proof marks user eligible", async () => {
  const store = makeStore();
  const user = { id: "user_1" };
  store.createWorldAttempt(user.id, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "user:user_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await verifyWorldProof({
    config: { worldEligibilityTtlMs: 60_000 },
    store,
    user,
    payload: {
      attemptId: "attempt_1",
      action: "world-id-chat-access-v1",
      nonce: "nonce_1",
      responses: [{ identifier: "proof_of_human", signal_hash: hashSignal("user:user_1"), nullifier: "nullifier_1" }],
      mock: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(store.verifications.user_1.eligibilityStatus, "eligible");
  assert.equal(getWorldEligibilityStatus(store.verifications.user_1).status, "eligible");
});

test("rejects reused World nullifier", async () => {
  const store = makeStore();
  const user = { id: "user_1" };
  store.createWorldAttempt(user.id, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "user:user_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.saveWorldNullifier("mock_nullifier_attempt_1", "other_user");

  const result = await verifyWorldProof({
    config: { worldEligibilityTtlMs: 60_000 },
    store,
    user,
    payload: {
      attemptId: "attempt_1",
      action: "world-id-chat-access-v1",
      nonce: "nonce_1",
      responses: [{ identifier: "proof_of_human", signal_hash: hashSignal("user:user_1"), nullifier: "mock_nullifier_attempt_1" }],
      mock: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "reused_nullifier");
});

test("rejects wrong action", async () => {
  const store = makeStore();
  const user = { id: "user_1" };
  store.createWorldAttempt(user.id, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "user:user_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await verifyWorldProof({
    config: { worldEligibilityTtlMs: 60_000 },
    store,
    user,
    payload: {
      attemptId: "attempt_1",
      action: "other-action",
      nonce: "nonce_1",
      responses: [{ identifier: "proof_of_human", signal_hash: hashSignal("user:user_1"), nullifier: "nullifier_1" }],
      mock: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "wrong_action");
});

function makeStore() {
  return {
    attempts: {},
    verifications: {},
    nullifiers: {},
    createWorldAttempt(userId, attempt) {
      this.attempts[attempt.id] = { ...attempt, userId, consumedAt: null };
      return this.attempts[attempt.id];
    },
    getWorldAttempt(attemptId) {
      return this.attempts[attemptId] || null;
    },
    updateWorldAttempt(attemptId, updates) {
      this.attempts[attemptId] = { ...this.attempts[attemptId], ...updates };
      return this.attempts[attemptId];
    },
    consumeWorldAttempt(attemptId) {
      this.attempts[attemptId].consumedAt = new Date().toISOString();
      return this.attempts[attemptId];
    },
    hasWorldNullifier(nullifierHash) {
      return Boolean(this.nullifiers[nullifierHash]);
    },
    saveWorldNullifier(nullifierHash, userId) {
      this.nullifiers[nullifierHash] = userId;
    },
    saveVerification(userId, verification) {
      this.verifications[userId] = verification;
      return verification;
    },
  };
}
