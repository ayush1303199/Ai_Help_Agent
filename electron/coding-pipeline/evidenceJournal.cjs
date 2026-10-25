/**
 * AI Help Agent - Append-Only Evidence Journal (V7)
 *
 * Implements a verifiable, append-only event journal with monotonic sequence numbers,
 * cryptographic hash chaining, and secret redaction.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { redactSensitiveData } = require('./diagnosticEngine.cjs');

const JOURNAL_SCHEMA_VERSION = 1;

/**
 * Deeply sanitizes sensitive data (API keys, tokens, passwords) from strings and objects.
 */
function sanitizeSensitiveValue(val) {
  if (typeof val === 'string') {
    return redactSensitiveData(val)
      .replace(/sk-[a-zA-Z0-9_-]{20,}/gi, '[redacted-api-key]')
      .replace(/ghp_[a-zA-Z0-9]{20,}/gi, '[redacted-gh-token]')
      .replace(/xox[baprs]-[a-zA-Z0-9-]+/gi, '[redacted-slack-token]');
  }
  if (val && typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.map(sanitizeSensitiveValue);
    }
    const result = {};
    for (const [k, v] of Object.entries(val)) {
      if (/^(?:api[_-]?key|secret|token|password|auth|credential)/i.test(k)) {
        result[k] = '[redacted]';
      } else {
        result[k] = sanitizeSensitiveValue(v);
      }
    }
    return result;
  }
  return val;
}

const JOURNAL_EVENT_TYPES = Object.freeze({
  WORKFLOW_CREATED: 'WORKFLOW_CREATED',
  STATE_TRANSITION_ACCEPTED: 'STATE_TRANSITION_ACCEPTED',
  STATE_TRANSITION_REJECTED: 'STATE_TRANSITION_REJECTED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  APPROVAL_INVALIDATED: 'APPROVAL_INVALIDATED',
  PROPOSAL_DIGEST_VALIDATED: 'PROPOSAL_DIGEST_VALIDATED',
  PROPOSAL_DIGEST_REJECTED: 'PROPOSAL_DIGEST_REJECTED',
  PATCH_APPLICATION_STARTED: 'PATCH_APPLICATION_STARTED',
  PATCH_APPLICATION_COMPLETED: 'PATCH_APPLICATION_COMPLETED',
  PATCH_APPLICATION_INTERRUPTED: 'PATCH_APPLICATION_INTERRUPTED',
  ROLLBACK_REQUESTED: 'ROLLBACK_REQUESTED',
  ROLLBACK_COMPLETED: 'ROLLBACK_COMPLETED',
  VERIFICATION_STARTED: 'VERIFICATION_STARTED',
  VERIFICATION_RESULT: 'VERIFICATION_RESULT',
  RECOVERY_ATTEMPTED: 'RECOVERY_ATTEMPTED',
  RECOVERY_DECISION: 'RECOVERY_DECISION',
  EXECUTION_BLOCKED: 'EXECUTION_BLOCKED',
  CLIENT_RECONNECTED: 'CLIENT_RECONNECTED',
  OUT_OF_ORDER_EVENT_REJECTED: 'OUT_OF_ORDER_EVENT_REJECTED',
});

function computeEntryHash(entry) {
  const payload = {
    sequenceNumber: entry.sequenceNumber,
    workflowId: entry.workflowId,
    eventType: entry.eventType,
    timestamp: entry.timestamp,
    previousEntryHash: entry.previousEntryHash,
    outcome: entry.outcome,
    evidenceDigest: entry.evidenceDigest,
    details: entry.details,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

class EvidenceJournal {
  constructor({ workflowId, storagePath = null } = {}) {
    if (!workflowId) {
      throw new Error('EvidenceJournal requires a non-empty workflowId.');
    }
    this.workflowId = String(workflowId);
    this.storagePath = storagePath ? path.resolve(storagePath) : null;
    this.entries = [];
    this.lastSequenceNumber = 0;
    this.lastEntryHash = 'GENESIS';
  }

  getEntries() {
    return [...this.entries];
  }

  getLastSequenceNumber() {
    return this.lastSequenceNumber;
  }

  getLastEntryHash() {
    return this.lastEntryHash;
  }

  /**
   * Appends an event to the journal with monotonic sequence and hash chaining.
   */
  async appendEvent({
    eventType,
    outcome = 'OK',
    evidenceDigest = null,
    details = {},
  }) {
    if (!JOURNAL_EVENT_TYPES[eventType] && typeof eventType !== 'string') {
      throw new Error(`Invalid journal eventType: ${eventType}`);
    }

    // Redact any secrets in details
    const sanitizedDetails = sanitizeSensitiveValue(details);

    const sequenceNumber = this.lastSequenceNumber + 1;
    const timestamp = new Date().toISOString();
    const previousEntryHash = this.lastEntryHash;

    const entry = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      workflowId: this.workflowId,
      sequenceNumber,
      eventType: String(eventType),
      outcome: String(outcome),
      evidenceDigest: evidenceDigest ? String(evidenceDigest) : null,
      details: sanitizedDetails,
      timestamp,
      previousEntryHash,
      entryHash: '',
    };

    entry.entryHash = computeEntryHash(entry);

    this.entries.push(entry);
    this.lastSequenceNumber = sequenceNumber;
    this.lastEntryHash = entry.entryHash;

    if (this.storagePath) {
      await this._persistEntry(entry);
    }

    return entry;
  }

  async _persistEntry(entry) {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.storagePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Loads journal entries from disk.
   */
  async loadFromDisk() {
    if (!this.storagePath) return [];
    try {
      const content = await fs.readFile(this.storagePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const parsed = lines.map((l) => JSON.parse(l));

      const validation = verifyJournalIntegrity(parsed);
      if (!validation.ok) {
        throw new Error(`Journal integrity verification failed: ${validation.reason}`);
      }

      this.entries = parsed;
      if (parsed.length > 0) {
        const last = parsed[parsed.length - 1];
        this.lastSequenceNumber = last.sequenceNumber;
        this.lastEntryHash = last.entryHash;
      }
      return this.entries;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

/**
 * Verifies append-only integrity across an array of journal entries:
 * 1. Monotonic sequence numbers (1, 2, 3...) with no gaps.
 * 2. Hash chaining (previousEntryHash matches previous entry's entryHash).
 * 3. Individual entry checksum recalculation.
 */
function verifyJournalIntegrity(entries = []) {
  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'Journal entries must be an array.' };
  }
  if (entries.length === 0) {
    return { ok: true, count: 0 };
  }

  let expectedSeq = 1;
  let expectedPrevHash = 'GENESIS';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (entry.sequenceNumber !== expectedSeq) {
      return {
        ok: false,
        reason: `Sequence gap or mismatch at index ${i}: expected ${expectedSeq}, got ${entry.sequenceNumber}`,
        brokenIndex: i,
      };
    }

    if (entry.previousEntryHash !== expectedPrevHash) {
      return {
        ok: false,
        reason: `Hash chain mismatch at sequence ${entry.sequenceNumber}: expected previous hash ${expectedPrevHash}, got ${entry.previousEntryHash}`,
        brokenIndex: i,
      };
    }

    const recomputed = computeEntryHash(entry);
    if (recomputed !== entry.entryHash) {
      return {
        ok: false,
        reason: `Entry checksum mismatch at sequence ${entry.sequenceNumber}: recomputed=${recomputed}, stored=${entry.entryHash}`,
        brokenIndex: i,
      };
    }

    expectedSeq += 1;
    expectedPrevHash = entry.entryHash;
  }

  return { ok: true, count: entries.length };
}

function createEvidenceJournal(params) {
  return new EvidenceJournal(params);
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_EVENT_TYPES,
  EvidenceJournal,
  createEvidenceJournal,
  verifyJournalIntegrity,
  computeEntryHash,
};
