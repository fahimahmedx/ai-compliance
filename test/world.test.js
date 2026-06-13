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
  assert.equal(result.user.id, "user_for_nullifier_attempt_1");
  assert.equal(store.verifications.user_for_nullifier_attempt_1.eligibilityStatus, "eligible");
  assert.equal(getWorldEligibilityStatus(store.verifications.user_for_nullifier_attempt_1).status, "eligible");
});

test("reused World nullifier restores the existing user", async () => {
  const store = makeStore();
  const user = null;
  store.createWorldAttempt(null, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "attempt:attempt_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.users.mock_nullifier_attempt_1 = { id: "existing_user", createdAt: new Date().toISOString() };

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

  assert.equal(result.ok, true);
  assert.equal(result.user.id, "existing_user");
  assert.equal(store.verifications.existing_user.eligibilityStatus, "eligible");
});

test("accepts World API nullifier replay when approved proof includes nullifier", async () => {
  const store = makeStore();
  const user = null;
  store.createWorldAttempt(null, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "attempt:attempt_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await verifyWorldProof({
    config: {
      worldEligibilityTtlMs: 60_000,
      worldAppId: "app_1",
      worldRpId: "rp_1",
      worldRpSigningKey: "key_1",
      worldVerifyBaseUrl: "https://world.test",
    },
    store,
    user,
    payload: {
      attemptId: "attempt_1",
      action: "world-id-chat-access-v1",
      nonce: "nonce_1",
      responses: [{ identifier: "proof_of_human", signal_hash: hashSignal("attempt:attempt_1"), nullifier: "nullifier_1" }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.user.id, "user_for_nullifier_1");
  assert.equal(store.verifications.user_for_nullifier_1.eligibilityStatus, "eligible");
});

test("rejects nullifier replay without an approved proof nullifier", async () => {
  const store = makeStore();
  store.createWorldAttempt(null, {
    id: "attempt_1",
    action: "world-id-chat-access-v1",
    signal: "attempt:attempt_1",
    nonce: "nonce_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await verifyWorldProof({
    config: {
      worldEligibilityTtlMs: 60_000,
      worldAppId: "app_1",
      worldRpId: "rp_1",
      worldRpSigningKey: "key_1",
      worldVerifyBaseUrl: "https://world.test",
    },
    store,
    user: null,
    payload: {
      attemptId: "attempt_1",
      action: "world-id-chat-access-v1",
      nonce: "nonce_1",
      responses: [{ identifier: "proof_of_human", signal_hash: hashSignal("attempt:attempt_1") }],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "world_verify_failed");
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
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ code: "nullifier_replayed", detail: "nullifier_replayed" }),
  });
  return {
    attempts: {},
    verifications: {},
    nullifiers: {},
    users: {},
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
    getOrCreateUserByWorldNullifier(nullifierHash) {
      if (!this.users[nullifierHash]) {
        this.users[nullifierHash] = {
          id: `user_for_${nullifierHash.replace(/^mock_/, "")}`,
          createdAt: new Date().toISOString(),
        };
      }
      return this.users[nullifierHash];
    },
    saveVerification(userId, verification) {
      this.verifications[userId] = verification;
      return verification;
    },
  };
}
