import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        world_nullifier_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_verifications (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        action TEXT,
        world_attempt_id TEXT,
        eligibility_status TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        world_nullifier_hash TEXT,
        verified_at TEXT,
        eligibility_expires_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS world_verification_attempts (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        signal TEXT NOT NULL,
        nonce TEXT,
        expires_at TEXT NOT NULL,
        rp_signature_expires_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        anthropic_message_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        mock INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_micros INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('posted', 'pending', 'released')),
        anthropic_message_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        allowed INTEGER NOT NULL,
        prompt_length INTEGER NOT NULL DEFAULT 0,
        reason_code TEXT,
        anthropic_message_id TEXT,
        mock INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getOrCreateUserByWorldNullifier(nullifierHash) {
    const existing = this.db.prepare("SELECT * FROM users WHERE world_nullifier_hash = ?").get(nullifierHash);
    if (existing) return this.toUser(existing);

    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      worldNullifierHash: nullifierHash,
      createdAt: now,
    };

    this.transaction(() => {
      this.db.prepare(
        "INSERT INTO users (id, world_nullifier_hash, created_at) VALUES (?, ?, ?)",
      ).run(user.id, user.worldNullifierHash, user.createdAt);
      this.ensureConversation(user.id);
    });
    return user;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
    ).run(tokenHash, userId, now);
    return token;
  }

  getUserBySession(token) {
    const row = this.db.prepare(`
      SELECT users.*
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(hashToken(token));
    return row ? this.toUser(row) : null;
  }

  getVerification(userId) {
    const row = this.db.prepare("SELECT * FROM identity_verifications WHERE user_id = ?").get(userId);
    return row ? toVerification(row) : null;
  }

  saveVerification(userId, verification) {
    const existing = this.getVerification(userId) || {};
    const merged = {
      ...existing,
      ...verification,
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO identity_verifications (
        user_id, provider, action, world_attempt_id, eligibility_status, reason_code, reason,
        world_nullifier_hash, verified_at, eligibility_expires_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        provider = excluded.provider,
        action = excluded.action,
        world_attempt_id = excluded.world_attempt_id,
        eligibility_status = excluded.eligibility_status,
        reason_code = excluded.reason_code,
        reason = excluded.reason,
        world_nullifier_hash = excluded.world_nullifier_hash,
        verified_at = excluded.verified_at,
        eligibility_expires_at = excluded.eligibility_expires_at,
        updated_at = excluded.updated_at
    `).run(
      userId,
      merged.provider || "world",
      merged.action || null,
      merged.worldAttemptId || null,
      merged.eligibilityStatus || "pending",
      merged.reasonCode || "verification_pending",
      merged.reason || "Scan the World App QR code to verify your World ID.",
      merged.worldNullifierHash || null,
      merged.verifiedAt || null,
      merged.eligibilityExpiresAt || null,
      merged.updatedAt,
    );
    return this.getVerification(userId);
  }

  createWorldAttempt(userId, attempt) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO world_verification_attempts (id, user_id, action, signal, expires_at, created_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(attempt.id, userId || null, attempt.action, attempt.signal, attempt.expiresAt, now);
    return this.getWorldAttempt(attempt.id);
  }

  getWorldAttempt(attemptId) {
    const row = this.db.prepare("SELECT * FROM world_verification_attempts WHERE id = ?").get(attemptId);
    return row ? toWorldAttempt(row) : null;
  }

  updateWorldAttempt(attemptId, updates) {
    const existing = this.getWorldAttempt(attemptId);
    if (!existing) return null;
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      UPDATE world_verification_attempts
      SET user_id = ?, action = ?, signal = ?, nonce = ?, expires_at = ?,
          rp_signature_expires_at = ?, consumed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.userId || null,
      merged.action,
      merged.signal,
      merged.nonce || null,
      merged.expiresAt,
      merged.rpSignatureExpiresAt || null,
      merged.consumedAt || null,
      merged.updatedAt,
      attemptId,
    );
    return this.getWorldAttempt(attemptId);
  }

  consumeWorldAttempt(attemptId) {
    const consumedAt = new Date().toISOString();
    this.db.prepare("UPDATE world_verification_attempts SET consumed_at = ?, updated_at = ? WHERE id = ?")
      .run(consumedAt, consumedAt, attemptId);
    return this.getWorldAttempt(attemptId);
  }

  hasWorldNullifier(nullifierHash) {
    return Boolean(this.db.prepare("SELECT 1 FROM users WHERE world_nullifier_hash = ?").get(nullifierHash));
  }

  saveWorldNullifier(nullifierHash, userId) {
    const row = this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!row) return;
    this.db.prepare("UPDATE users SET world_nullifier_hash = ? WHERE id = ?").run(nullifierHash, userId);
  }

  getCreditBalance(userId) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN status != 'released' THEN amount_micros ELSE 0 END), 0) AS balance
      FROM credit_ledger
      WHERE user_id = ?
    `).get(userId);
    return Number(row?.balance || 0);
  }

  createCreditReservation(userId, amountMicros) {
    if (amountMicros <= 0) return null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      const balance = this.getCreditBalance(userId);
      if (balance < amountMicros) return null;
      this.db.prepare(`
        INSERT INTO credit_ledger (id, user_id, amount_micros, kind, status, created_at, updated_at)
        VALUES (?, ?, ?, 'llm_reservation', 'pending', ?, ?)
      `).run(id, userId, -amountMicros, now, now);
      return { id, amountMicros };
    });
  }

  finalizeCreditReservation(reservationId, actualCostMicros, usage = {}, anthropicMessageId = null) {
    const row = this.db.prepare("SELECT * FROM credit_ledger WHERE id = ? AND status = 'pending'").get(reservationId);
    if (!row) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE credit_ledger
      SET amount_micros = ?, kind = 'llm_charge', status = 'posted',
          anthropic_message_id = ?, input_tokens = ?, output_tokens = ?, updated_at = ?
      WHERE id = ?
    `).run(
      -actualCostMicros,
      anthropicMessageId,
      usage.inputTokens || 0,
      usage.outputTokens || 0,
      now,
      reservationId,
    );
  }

  releaseCreditReservation(reservationId) {
    if (!reservationId) return;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE credit_ledger SET status = 'released', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, reservationId);
  }

  ensureConversation(userId) {
    const existing = this.db.prepare("SELECT * FROM conversations WHERE user_id = ?").get(userId);
    if (existing) return toConversation(existing);
    const now = new Date().toISOString();
    const conversation = { id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(conversation.id, userId, now, now);
    return conversation;
  }

  getConversationMessages(userId) {
    const conversation = this.ensureConversation(userId);
    const rows = this.db.prepare(`
      SELECT id, role, content, anthropic_message_id, input_tokens, output_tokens, cost_micros, mock, created_at
      FROM messages
      WHERE conversation_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(conversation.id, userId);
    return rows.map(toMessage);
  }

  getUserMessageCount(userId) {
    const conversation = this.ensureConversation(userId);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE conversation_id = ? AND user_id = ? AND role = 'user'
    `).get(conversation.id, userId);
    return Number(row?.count || 0);
  }

  addMessage(userId, message) {
    const conversation = this.ensureConversation(userId);
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      userId,
      role: message.role,
      content: message.content,
      anthropicMessageId: message.anthropicMessageId || null,
      inputTokens: message.inputTokens || null,
      outputTokens: message.outputTokens || null,
      costMicros: message.costMicros || 0,
      mock: message.mock ? 1 : 0,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO messages (
        id, conversation_id, user_id, role, content, anthropic_message_id,
        input_tokens, output_tokens, cost_micros, mock, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.conversationId,
      row.userId,
      row.role,
      row.content,
      row.anthropicMessageId,
      row.inputTokens,
      row.outputTokens,
      row.costMicros,
      row.mock,
      row.createdAt,
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversation.id);
    return toMessage({
      id: row.id,
      role: row.role,
      content: row.content,
      anthropic_message_id: row.anthropicMessageId,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_micros: row.costMicros,
      mock: row.mock,
      created_at: row.createdAt,
    });
  }

  addAuditEvent(event) {
    this.db.prepare(`
      INSERT INTO llm_audit_events (
        id, user_id, allowed, prompt_length, reason_code, anthropic_message_id, mock, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      event.userId || null,
      event.allowed ? 1 : 0,
      event.promptLength || 0,
      event.reasonCode || null,
      event.anthropicMessageId || null,
      event.mock ? 1 : 0,
      new Date().toISOString(),
    );
  }

  toUser(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
    };
  }
}

export const JsonStore = SqliteStore;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toVerification(row) {
  return {
    provider: row.provider,
    action: row.action,
    worldAttemptId: row.world_attempt_id,
    eligibilityStatus: row.eligibility_status,
    reasonCode: row.reason_code,
    reason: row.reason,
    worldNullifierHash: row.world_nullifier_hash,
    verifiedAt: row.verified_at,
    eligibilityExpiresAt: row.eligibility_expires_at,
    updatedAt: row.updated_at,
  };
}

function toWorldAttempt(row) {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    signal: row.signal,
    nonce: row.nonce,
    expiresAt: row.expires_at,
    rpSignatureExpiresAt: row.rp_signature_expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConversation(row) {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    anthropicMessageId: row.anthropic_message_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    mock: Boolean(row.mock),
    createdAt: row.created_at,
  };
}
