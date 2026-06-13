import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      users: {},
      sessions: {},
      identityVerifications: {},
      worldVerificationAttempts: {},
      usedWorldNullifiers: {},
      llmAuditEvents: [],
    };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    this.state = {
      ...this.state,
      ...JSON.parse(fs.readFileSync(this.filePath, "utf8")),
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getOrCreateUser(email) {
    const normalized = email.trim().toLowerCase();
    const existing = Object.values(this.state.users).find((user) => user.email === normalized);
    if (existing) return existing;

    const user = {
      id: crypto.randomUUID(),
      email: normalized,
      createdAt: new Date().toISOString(),
    };
    this.state.users[user.id] = user;
    this.save();
    return user;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.state.sessions[token] = {
      userId,
      createdAt: new Date().toISOString(),
    };
    this.save();
    return token;
  }

  getUserBySession(token) {
    const session = this.state.sessions[token];
    if (!session) return null;
    return this.state.users[session.userId] || null;
  }

  getVerification(userId) {
    return this.state.identityVerifications[userId] || null;
  }

  saveVerification(userId, verification) {
    this.state.identityVerifications[userId] = {
      ...(this.state.identityVerifications[userId] || {}),
      ...verification,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.identityVerifications[userId];
  }

  createWorldAttempt(userId, attempt) {
    this.state.worldVerificationAttempts[attempt.id] = {
      ...attempt,
      userId,
      createdAt: new Date().toISOString(),
      consumedAt: null,
    };
    this.save();
    return this.state.worldVerificationAttempts[attempt.id];
  }

  getWorldAttempt(attemptId) {
    return this.state.worldVerificationAttempts[attemptId] || null;
  }

  updateWorldAttempt(attemptId, updates) {
    const attempt = this.state.worldVerificationAttempts[attemptId];
    if (!attempt) return null;
    this.state.worldVerificationAttempts[attemptId] = {
      ...attempt,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.worldVerificationAttempts[attemptId];
  }

  consumeWorldAttempt(attemptId) {
    const attempt = this.state.worldVerificationAttempts[attemptId];
    if (!attempt) return null;
    attempt.consumedAt = new Date().toISOString();
    this.save();
    return attempt;
  }

  hasWorldNullifier(nullifierHash) {
    return Boolean(this.state.usedWorldNullifiers[nullifierHash]);
  }

  saveWorldNullifier(nullifierHash, userId) {
    this.state.usedWorldNullifiers[nullifierHash] = {
      userId,
      usedAt: new Date().toISOString(),
    };
    this.save();
  }

  addAuditEvent(event) {
    this.state.llmAuditEvents.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...event,
    });
    this.save();
  }
}
