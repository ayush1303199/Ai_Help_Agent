/**
 * AI Help Agent - Durable Workflow Store (V7)
 *
 * Implements atomic, integrity-verified persistence for in-progress workflow state.
 * Enforces restrictive permissions, secret redaction, and schema validation.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { redactSensitiveData } = require('./diagnosticEngine.cjs');

const DURABLE_SCHEMA_VERSION = 1;

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

/**
 * Computes an integrity digest over all security-critical fields of a workflow record.
 */
function computeRecordDigest(record) {
  const canonical = {
    schemaVersion: record.schemaVersion,
    workflowId: record.workflowId,
    projectIdentity: record.projectIdentity ? {
      projectRoot: path.normalize(record.projectIdentity.projectRoot),
      sessionId: record.projectIdentity.sessionId,
      ownerWebContentsId: record.projectIdentity.ownerWebContentsId,
      projectHash: record.projectIdentity.projectHash,
    } : null,
    currentState: record.currentState,
    lastTransition: record.lastTransition,
    boundProposal: record.boundProposal ? {
      proposalId: record.boundProposal.proposalId,
      planDigest: record.boundProposal.planDigest,
      diffSha256: record.boundProposal.diffSha256,
      targets: record.boundProposal.targets,
    } : null,
    cancelled: Boolean(record.cancelled),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Validates a workflow record against the schema and integrity requirements.
 */
function validateWorkflowRecord(record) {
  if (!record || typeof record !== 'object') {
    return { valid: false, reason: 'Record must be a non-null object.' };
  }
  if (record.schemaVersion !== DURABLE_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `Unsupported schema version: ${record.schemaVersion} (supported: ${DURABLE_SCHEMA_VERSION})`,
      unsupportedVersion: true,
    };
  }
  if (!record.workflowId || typeof record.workflowId !== 'string') {
    return { valid: false, reason: 'Missing or invalid workflowId.' };
  }
  if (!record.projectIdentity || !record.projectIdentity.projectRoot) {
    return { valid: false, reason: 'Missing projectIdentity with projectRoot.' };
  }
  if (!record.currentState || typeof record.currentState !== 'string') {
    return { valid: false, reason: 'Missing currentState string.' };
  }
  if (!record.recordDigest || typeof record.recordDigest !== 'string') {
    return { valid: false, reason: 'Missing recordDigest integrity hash.' };
  }

  const computedDigest = computeRecordDigest(record);
  if (computedDigest !== record.recordDigest) {
    return {
      valid: false,
      reason: `Integrity digest mismatch (possible record tampering or truncation): computed=${computedDigest}, stored=${record.recordDigest}`,
      tampered: true,
    };
  }

  return { valid: true };
}

class DurableWorkflowStore {
  constructor({ storageDirectory } = {}) {
    if (!storageDirectory) {
      throw new Error('DurableWorkflowStore requires a storageDirectory path.');
    }
    this.storageDirectory = path.resolve(storageDirectory);
  }

  getFilePath(workflowId) {
    // Sanitize workflowId to prevent directory traversal
    const safeId = String(workflowId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDirectory, `${safeId}.json`);
  }

  /**
   * Persists a workflow record atomically to disk.
   */
  async saveWorkflow(workflowData) {
    if (!workflowData || !workflowData.workflowId) {
      throw new Error('Workflow data with workflowId is required to save.');
    }

    const now = new Date().toISOString();
    const record = {
      schemaVersion: DURABLE_SCHEMA_VERSION,
      workflowId: String(workflowData.workflowId),
      projectIdentity: workflowData.projectIdentity ? {
        projectRoot: path.normalize(workflowData.projectIdentity.projectRoot),
        sessionId: workflowData.projectIdentity.sessionId || null,
        ownerWebContentsId: workflowData.projectIdentity.ownerWebContentsId ?? null,
        projectHash: workflowData.projectIdentity.projectHash || null,
      } : null,
      currentState: String(workflowData.currentState || 'UNKNOWN'),
      lastTransition: workflowData.lastTransition ? { ...workflowData.lastTransition } : null,
      lastIdempotencyKey: workflowData.lastIdempotencyKey || null,
      boundProposal: workflowData.boundProposal ? { ...workflowData.boundProposal } : null,
      evidenceSummary: sanitizeSensitiveValue(workflowData.evidenceSummary || {}),
      evidenceDigest: workflowData.evidenceDigest || null,
      cancelled: Boolean(workflowData.cancelled),
      cancelReason: workflowData.cancelReason || null,
      recoveryStatus: workflowData.recoveryStatus || null,
      blockers: Array.isArray(workflowData.blockers) ? [...workflowData.blockers] : [],
      incompleteStages: Array.isArray(workflowData.incompleteStages) ? [...workflowData.incompleteStages] : [],
      createdAt: workflowData.createdAt || now,
      updatedAt: now,
      recordDigest: '',
    };

    record.recordDigest = computeRecordDigest(record);

    await fs.mkdir(this.storageDirectory, { recursive: true });

    const targetPath = this.getFilePath(record.workflowId);
    const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;

    const content = JSON.stringify(record, null, 2);

    // Atomic write pattern: write to tmp with mode 0o600, then rename
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, targetPath);

    return { ok: true, workflowId: record.workflowId, recordDigest: record.recordDigest };
  }

  /**
   * Loads and validates a workflow record from disk.
   */
  async loadWorkflow(workflowId) {
    const filePath = this.getFilePath(workflowId);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { ok: false, notFound: true, reason: `Workflow file not found: ${workflowId}` };
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return { ok: false, malformed: true, reason: `Malformed JSON in workflow file: ${parseErr.message}` };
    }

    const validation = validateWorkflowRecord(parsed);
    if (!validation.valid) {
      return {
        ok: false,
        invalid: true,
        reason: validation.reason,
        tampered: Boolean(validation.tampered),
        unsupportedVersion: Boolean(validation.unsupportedVersion),
      };
    }

    return { ok: true, record: parsed };
  }

  /**
   * Deletes a persisted workflow record.
   */
  async deleteWorkflow(workflowId) {
    const filePath = this.getFilePath(workflowId);
    try {
      await fs.unlink(filePath);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true };
      throw err;
    }
  }
}

function createDurableWorkflowStore(params) {
  return new DurableWorkflowStore(params);
}

module.exports = {
  DURABLE_SCHEMA_VERSION,
  computeRecordDigest,
  validateWorkflowRecord,
  DurableWorkflowStore,
  createDurableWorkflowStore,
};
