/**
 * Live-LLM Proposal-Only Benchmark Authorization Protocol & Isolation Contract.
 *
 * Defines:
 *  1. Strict single-use, time-bound human authorization validation (ambient env vars forbidden).
 *  2. Cross-process atomic replay prevention.
 *  3. Bounded provider credentials and network egress checks.
 *  4. Resource caps (token budget, financial cap, timeout, single retry).
 *  5. Windows-safe path canonicalization ensuring proposal destination is strictly outside project.
 *  6. Cryptographic evidence contract with deep immutability and genuine-inference proof requirements.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BENCHMARK_RESULT_CLASSIFICATIONS = Object.freeze({
  DETERMINISTIC_SYNTHETIC: 'DETERMINISTIC_SYNTHETIC',
  LIVE_MODEL_INFERENCE: 'LIVE_MODEL_INFERENCE',
  BLOCKED: 'BLOCKED',
  UNVERIFIED: 'UNVERIFIED',
});

const ALLOWED_BENCHMARK_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'groq']);

const ALLOWED_BENCHMARK_FIXTURES = Object.freeze([
  'FIX-01', // Math logic defect (calculator.ts)
  'FIX-02', // Null safety guard (tokenizer.ts)
  'FIX-03', // Field mapping defect (userMapper.ts)
  'FIX-04', // Contradictory evidence (stringUtil.ts)
  'FIX-05', // Sensitive boundary protection (.env)
]);

const DEFAULT_MAX_TOKEN_BUDGET = 50000;
const DEFAULT_MAX_COST_USD = 0.50;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_AUTHORIZATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

const APPROVER_IDENTITY_REGEX = /^(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:secops|lead|operator)-[a-zA-Z0-9_-]+)$/;

// In-memory replay prevention registry
const consumedAuthorizationTokens = new Set();
let testLedgerPathOverride = null;

function setLedgerPathForTest(filePath) {
  testLedgerPathOverride = filePath;
}

function getProtectedDefaultLedgerPath() {
  const protectedBaseDir = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || (os.homedir() ? path.join(os.homedir(), 'AppData', 'Local') : null))
    : (os.homedir() ? path.join(os.homedir(), '.ai-help-agent') : null);

  if (!protectedBaseDir) {
    throw new Error('LEDGER_UNSAFE_PATH: Cannot determine protected per-user application directory for authorization ledger.');
  }

  return path.join(protectedBaseDir, 'Ai_Help_Agent', 'security', 'consumed-benchmark-tokens.json');
}

function getConsumedTokensLedgerPath() {
  if (testLedgerPathOverride) return testLedgerPathOverride;
  if (process.env.AI_HELP_AGENT_LEDGER_PATH) return path.resolve(process.env.AI_HELP_AGENT_LEDGER_PATH);
  return getProtectedDefaultLedgerPath();
}

/**
 * Validates that the target path and existing ancestor directories contain no symbolic links or reparse points.
 */
function assertSafeStoragePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('LEDGER_UNSAFE_PATH: Target path must be a non-empty string.');
  }
  const resolved = path.resolve(targetPath);
  let current = resolved;
  const chain = [];
  while (true) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const seg of chain) {
    if (fs.existsSync(seg)) {
      try {
        const stat = fs.lstatSync(seg);
        if (stat.isSymbolicLink()) {
          throw new Error(`LEDGER_UNSAFE_PATH: Symbolic link detected at path segment: ${seg}`);
        }
      } catch (err) {
        if (err.message.includes('LEDGER_UNSAFE_PATH')) throw err;
        throw new Error(`LEDGER_PATH_STAT_FAILED: Cannot stat path segment ${seg}: ${err.message}`);
      }
    }
  }
}

/**
 * Derives atomic reservation token file path.
 */
function getReservationPath(ledgerPath, token) {
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const dir = path.dirname(ledgerPath);
  const reservationsDir = path.join(dir, '.token-reservations');
  return {
    reservationsDir,
    reservationPath: path.join(reservationsDir, `${tokenHash}.token`),
  };
}

/**
 * OS kernel-level atomic reservation using O_CREAT | O_EXCL ('wx').
 */
function reserveTokenAtomically(ledgerPath, token) {
  const { reservationsDir, reservationPath } = getReservationPath(ledgerPath, token);
  if (!fs.existsSync(reservationsDir)) {
    fs.mkdirSync(reservationsDir, { recursive: true, mode: 0o700 });
  }

  let fd;
  try {
    fd = fs.openSync(reservationPath, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      const collisionErr = new Error(`TOKEN_ALREADY_RESERVED: Token reservation collision: token has already been consumed or reserved.`);
      collisionErr.code = 'EEXIST';
      throw collisionErr;
    }
    throw new Error(`LEDGER_RESERVATION_FAILED: Cannot create token reservation: ${err.message}`);
  }

  try {
    const reservationData = JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    });
    fs.writeFileSync(fd, reservationData, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const LOCK_TIMEOUT_MS = 8000;
const STALE_LOCK_THRESHOLD_MS = 5000;
const RETRY_INTERVAL_MS = 25;

/**
 * Cross-process mutual exclusion via lockfile on ledger.
 * Fails closed on stale, ambiguous, or malformed lockfiles without automatic deletion.
 */
function acquireLedgerLock(ledgerPath) {
  const lockPath = `${ledgerPath}.lock`;
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
          }
        } catch {}
      };
    } catch (err) {
      if (err.code === 'EEXIST') {
        let stat;
        try {
          stat = fs.statSync(lockPath);
        } catch (statErr) {
          if (statErr.code === 'ENOENT') continue; // Released concurrently by holder
          throw new Error(`LEDGER_LOCK_FAILED: Cannot stat lockfile ${lockPath}: ${statErr.message}`);
        }

        let raw = '';
        try {
          raw = fs.readFileSync(lockPath, 'utf8');
        } catch (readErr) {
          if (readErr.code === 'ENOENT') continue; // Released concurrently by holder
          throw new Error(`LEDGER_LOCK_FAILED: Cannot read lockfile ${lockPath}: ${readErr.message}`);
        }

        let metadata;
        try {
          metadata = JSON.parse(raw);
        } catch {
          throw new Error(`LEDGER_LOCK_STALE_UNCERTAIN: Malformed or unparseable lock metadata on ${lockPath}. Automatic deletion is prohibited; manual intervention required.`);
        }

        if (!metadata || typeof metadata !== 'object' || typeof metadata.pid !== 'number' || typeof metadata.timestamp !== 'number') {
          throw new Error(`LEDGER_LOCK_STALE_UNCERTAIN: Ambiguous lock owner metadata on ${lockPath}. Automatic deletion is prohibited; manual intervention required.`);
        }

        const age = Date.now() - Math.max(stat.mtimeMs, metadata.timestamp);
        if (age > STALE_LOCK_THRESHOLD_MS) {
          throw new Error(`LEDGER_LOCK_STALE_UNCERTAIN: Stale lockfile detected (${age}ms old, pid=${metadata.pid}) on ${lockPath}. Automatic deletion is prohibited to prevent split-brain authorization.`);
        }

        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_INTERVAL_MS);
        } catch {
          const until = Date.now() + RETRY_INTERVAL_MS;
          while (Date.now() < until) {}
        }
        continue;
      }
      throw new Error(`LEDGER_LOCK_FAILED: Failed to acquire ledger lock: ${err.message}`);
    }
  }
  throw new Error(`LEDGER_LOCK_TIMEOUT: Timed out waiting for ledger lock on ${lockPath}`);
}

function loadConsumedTokensLedger() {
  const ledgerPath = getConsumedTokensLedgerPath();
  assertSafeStoragePath(ledgerPath);
  if (!fs.existsSync(ledgerPath)) {
    return new Set();
  }

  let raw = '';
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch (err) {
    throw new Error(`LEDGER_READ_FAILED: Cannot read authorization ledger: ${err.message}`);
  }

  if (!raw.trim()) {
    return new Set();
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LEDGER_CORRUPTED: Authorization ledger contains malformed or truncated JSON: ${err.message}`);
  }

  if (!Array.isArray(data)) {
    throw new Error('LEDGER_SCHEMA_ERROR: Authorization ledger root must be a JSON array of token strings.');
  }

  return new Set(data.filter((item) => typeof item === 'string'));
}

function recordConsumedToken(token) {
  if (!token) return;
  const ledgerPath = getConsumedTokensLedgerPath();
  assertSafeStoragePath(ledgerPath);
  const dir = path.dirname(ledgerPath);

  const releaseLock = acquireLedgerLock(ledgerPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    reserveTokenAtomically(ledgerPath, token);

    const existing = loadConsumedTokensLedger();
    existing.add(token);

    const tmpPath = path.join(dir, `.tmp-${crypto.randomUUID()}.json`);
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify([...existing]), { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, ledgerPath);
    consumedAuthorizationTokens.add(token);
  } catch (err) {
    if (err.code === 'EEXIST' || err.message.includes('TOKEN_ALREADY_RESERVED')) {
      throw err;
    }
    throw new Error(`LEDGER_WRITE_FAILED: Failed to record consumed token in durable ledger: ${err.message}`);
  } finally {
    releaseLock();
  }
}

function isTokenConsumed(token) {
  if (!token) return false;
  if (consumedAuthorizationTokens.has(token)) return true;

  const ledgerPath = getConsumedTokensLedgerPath();
  assertSafeStoragePath(ledgerPath);

  const { reservationPath } = getReservationPath(ledgerPath, token);
  if (fs.existsSync(reservationPath)) {
    return true;
  }

  const diskTokens = loadConsumedTokensLedger();
  return diskTokens.has(token);
}

function normalizeProviderName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(x-goog-api-key|x-api-key|api[-_ ]?key|access[-_ ]?token|password|secret)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

/**
 * Deep recursive freeze helper.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

/**
 * Windows-safe, canonicalized path containment check.
 * Returns true if candidate is identical to parent or inside parent.
 */
function isPathInsideOrEqual(parentPath, candidatePath) {
  if (typeof parentPath !== 'string' || typeof candidatePath !== 'string' || !parentPath || !candidatePath) return false;
  try {
    const resolvedParent = path.resolve(parentPath);
    const resolvedCandidate = path.resolve(candidatePath);

    let realParent = resolvedParent;
    let realCandidate = resolvedCandidate;

    try { if (fs.existsSync(resolvedParent)) realParent = fs.realpathSync(resolvedParent); } catch {}
    try {
      let cur = resolvedCandidate;
      while (cur && !fs.existsSync(cur)) {
        const next = path.dirname(cur);
        if (next === cur) break;
        cur = next;
      }
      if (cur && fs.existsSync(cur)) {
        const realCur = fs.realpathSync(cur);
        realCandidate = path.join(realCur, path.relative(cur, resolvedCandidate));
      }
    } catch {}

    const normParent = (process.platform === 'win32' ? realParent.toLowerCase() : realParent)
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    const normCandidate = (process.platform === 'win32' ? realCandidate.toLowerCase() : realCandidate)
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');

    if (normCandidate === normParent) return true;
    return normCandidate.startsWith(`${normParent}/`);
  } catch {
    return false;
  }
}

/**
 * Validates whether a live benchmark run is explicitly authorized.
 * Fail-closed: Any missing requirement or exception returns state: 'BLOCKED'.
 */
function validateLiveBenchmarkAuthorization(manifest, options = {}) {
  try {
    const blockers = [];

    if (!manifest || typeof manifest !== 'object') {
      return Object.freeze({
        authorized: false,
        state: BENCHMARK_RESULT_CLASSIFICATIONS.BLOCKED,
        reasonCode: 'MISSING_MANIFEST',
        blockers: Object.freeze(['Benchmark authorization manifest is required.']),
      });
    }

    // 0. Ambient Environment Variable Rejection
    if (manifest.source === 'ambient_env' || manifest._isAmbient === true) {
      blockers.push('Human authorization cannot be satisfied by ambient environment variables. An explicit, single-use manifest file (--manifest=<path>) or cryptographically signed payload is required.');
    }

    // 1. Explicit Human Authorization
    const auth = manifest.humanAuthorization;
    if (!auth || typeof auth !== 'object') {
      blockers.push('Human authorization block is missing.');
    } else {
      if (auth.explicitApproval !== true) {
        blockers.push('Explicit human approval flag (explicitApproval: true) is required.');
      }
      if (!auth.approverIdentity || typeof auth.approverIdentity !== 'string' || !auth.approverIdentity.trim()) {
        blockers.push('Approver identity must be specified.');
      } else if (!APPROVER_IDENTITY_REGEX.test(auth.approverIdentity.trim())) {
        blockers.push(`Approver identity "${auth.approverIdentity}" is not in valid principal format (email or secops/lead/operator role).`);
      }

      const approvalTime = Date.parse(auth.approvalTimestamp || '');
      if (!Number.isFinite(approvalTime)) {
        blockers.push('Valid ISO approval timestamp is required.');
      } else {
        const now = Date.now();
        if (now - approvalTime > MAX_AUTHORIZATION_TTL_MS) {
          blockers.push(`Human approval expired: approved at ${new Date(approvalTime).toISOString()}, exceeding ${MAX_AUTHORIZATION_TTL_MS / 60000}m window.`);
        }
        if (approvalTime - now > 30000) {
          blockers.push(`Approval timestamp is in the future (${new Date(approvalTime).toISOString()}); check clock synchronization.`);
        }
      }

      // Scope binding: verify authorized provider and fixtures if specified by approver
      if (auth.authorizedProvider) {
        const authProv = normalizeProviderName(auth.authorizedProvider);
        const reqProv = normalizeProviderName(manifest.provider);
        if (authProv && reqProv && authProv !== reqProv) {
          blockers.push(`Requested provider "${reqProv}" does not match human-authorized provider "${authProv}".`);
        }
      }
      if (Array.isArray(auth.authorizedFixtures) && auth.authorizedFixtures.length > 0) {
        const requestedFixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
        const unauthorizedRequested = requestedFixtures.filter((f) => !auth.authorizedFixtures.includes(f));
        if (unauthorizedRequested.length > 0) {
          blockers.push(`Requested fixtures exceed human-authorized fixture scope: ${unauthorizedRequested.join(', ')}.`);
        }
      }
    }

    // 2. Single-use Run Token & Expiration (with Atomic Replay Check)
    const token = manifest.runToken;
    if (!token || typeof token !== 'string' || !token.trim()) {
      blockers.push('Single-use run token is required.');
    } else {
      try {
        if (isTokenConsumed(token)) {
          blockers.push(`Run token "${token.slice(0, 8)}..." has already been consumed (replay prevention).`);
        }
      } catch (err) {
        blockers.push(`Authorization ledger verification failed (fail-closed): ${err.message}`);
      }
      const expiresAt = Date.parse(manifest.expiresAt || '');
      if (!Number.isFinite(expiresAt)) {
        blockers.push('Valid ISO expiresAt timestamp is required.');
      } else if (Date.now() > expiresAt) {
        blockers.push(`Authorization expired at ${new Date(expiresAt).toISOString()}.`);
      } else if (expiresAt - Date.now() > MAX_AUTHORIZATION_TTL_MS + 5000) {
        blockers.push(`Authorization TTL exceeds the maximum allowed window of ${MAX_AUTHORIZATION_TTL_MS / 60000} minutes.`);
      }
    }

    // 3. Network Egress Permission
    if (manifest.networkPermissionGranted !== true) {
      blockers.push('Explicit external network permission (networkPermissionGranted: true) is required.');
    }

    // 4. Provider & Credential Validation
    const provider = normalizeProviderName(manifest.provider);
    if (!provider) {
      blockers.push('Provider name is required.');
    } else if (!ALLOWED_BENCHMARK_PROVIDERS.includes(provider)) {
      blockers.push(`Unsupported provider "${provider}". Must be one of: ${ALLOWED_BENCHMARK_PROVIDERS.join(', ')}.`);
    }

    const apiKey = typeof manifest.apiKey === 'string' ? manifest.apiKey.trim() : '';
    if (!apiKey) {
      blockers.push('API key credential is missing from vault or configuration.');
    }

    // 5. Fixture Boundaries
    const fixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
    if (fixtures.length === 0) {
      blockers.push('At least one benchmark fixture must be specified.');
    } else {
      const invalidFixtures = fixtures.filter((f) => !ALLOWED_BENCHMARK_FIXTURES.includes(f));
      if (invalidFixtures.length > 0) {
        blockers.push(`Unauthorized fixtures requested: ${invalidFixtures.join(', ')}. Only approved fixtures are allowed: ${ALLOWED_BENCHMARK_FIXTURES.join(', ')}.`);
      }
    }

    // 6. Proposal-Only Isolation Path (Windows-Safe Containment Check)
    const destinationRoot = typeof manifest.destinationRoot === 'string' && manifest.destinationRoot.trim()
      ? path.resolve(manifest.destinationRoot)
      : '';
    const projectRoot = typeof options?.projectRoot === 'string' && options.projectRoot.trim()
      ? path.resolve(options.projectRoot)
      : process.cwd();

    if (!destinationRoot) {
      blockers.push('Destination path for inert proposal artifacts is required.');
    } else if (projectRoot) {
      if (isPathInsideOrEqual(projectRoot, destinationRoot)) {
        blockers.push('Proposal destination must be strictly outside the project repository workspace.');
      }
    }

    // 7. Resource Caps
    const maxTokens = Number.isFinite(manifest.maxTotalTokens) ? manifest.maxTotalTokens : DEFAULT_MAX_TOKEN_BUDGET;
    const maxCost = Number.isFinite(manifest.maxCostUsd) ? manifest.maxCostUsd : DEFAULT_MAX_COST_USD;
    const timeoutSeconds = Number.isFinite(manifest.timeoutSeconds) ? manifest.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
    const maxRetries = Number.isFinite(manifest.maxRetriesPerTrial) ? manifest.maxRetriesPerTrial : 1;

    if (maxRetries > 1) {
      blockers.push('Benchmark retry limit cannot exceed 1 retry per trial.');
    }

    if (blockers.length > 0) {
      return Object.freeze({
        authorized: false,
        state: BENCHMARK_RESULT_CLASSIFICATIONS.BLOCKED,
        reasonCode: 'PREREQUISITES_NOT_MET',
        blockers: Object.freeze(blockers),
      });
    }

    // Atomically consume token to prevent replay
    if (!options?.dryRun && token) {
      try {
        recordConsumedToken(token);
      } catch (err) {
        const isCollision = err.code === 'EEXIST' || err.message.includes('TOKEN_ALREADY_RESERVED');
        const isStaleLock = err.message.includes('LEDGER_LOCK_STALE_UNCERTAIN');
        return Object.freeze({
          authorized: false,
          state: BENCHMARK_RESULT_CLASSIFICATIONS.BLOCKED,
          reasonCode: isCollision
            ? 'REPLAY_DETECTED'
            : isStaleLock
            ? 'LEDGER_LOCK_STALE_UNCERTAIN'
            : 'LEDGER_WRITE_FAILED',
          blockers: Object.freeze([
            isCollision
              ? `Run token "${token.slice(0, 8)}..." has already been consumed (replay prevention): ${err.message}`
              : isStaleLock
              ? `Stale or ambiguous ledger lock prevented authorization: ${err.message}`
              : `Failed to commit consumed token to durable ledger: ${err.message}`,
          ]),
        });
      }
    }

    return deepFreeze({
      authorized: true,
      state: 'AUTHORIZED',
      runId: manifest.runId || crypto.randomUUID(),
      provider,
      model: manifest.model || 'default',
      fixtures: [...fixtures],
      destinationRoot,
      resourceLimits: {
        maxTotalTokens: maxTokens,
        maxCostUsd: maxCost,
        timeoutSeconds,
        maxRetriesPerTrial: maxRetries,
      },
    });
  } catch (err) {
    return Object.freeze({
      authorized: false,
      state: BENCHMARK_RESULT_CLASSIFICATIONS.BLOCKED,
      reasonCode: 'VALIDATION_EXCEPTION',
      blockers: Object.freeze([`Internal validation exception: ${err.message}`]),
    });
  }
}

/**
 * Creates an immutable, audited evidence record for a trial.
 */
function createBenchmarkEvidenceRecord(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('Evidence parameters are required.');
  }

  const {
    runId,
    trialId,
    classification,
    provider,
    model,
    startTime,
    endTime,
    promptSummary,
    rawResponse,
    tokensUsed = null,
    costUsd = null,
    validationOutcome,
    failureClassification = null,
  } = params;

  if (!Object.values(BENCHMARK_RESULT_CLASSIFICATIONS).includes(classification)) {
    throw new Error(`Invalid benchmark classification "${classification}".`);
  }

  // Strict Genuine Inference Proof Requirement:
  // LIVE_MODEL_INFERENCE cannot be claimed without actual non-empty response, supported provider, and token telemetry
  if (classification === BENCHMARK_RESULT_CLASSIFICATIONS.LIVE_MODEL_INFERENCE) {
    if (!rawResponse || typeof rawResponse !== 'string' || rawResponse.trim().length < 10) {
      throw new Error('Missing provider response evidence: LIVE_MODEL_INFERENCE requires actual provider response payload.');
    }
    const normProvider = normalizeProviderName(provider);
    if (!ALLOWED_BENCHMARK_PROVIDERS.includes(normProvider)) {
      throw new Error(`Invalid provider "${provider}" for LIVE_MODEL_INFERENCE. Must be in ${ALLOWED_BENCHMARK_PROVIDERS.join(', ')}.`);
    }
    if (!model || typeof model !== 'string' || !model.trim()) {
      throw new Error('Missing model identifier: LIVE_MODEL_INFERENCE requires explicit model name.');
    }
    if (!tokensUsed || typeof tokensUsed !== 'object' || !Number.isFinite(tokensUsed.totalTokens) || tokensUsed.totalTokens <= 0) {
      throw new Error('Missing token telemetry: LIVE_MODEL_INFERENCE requires verified non-zero token usage metrics.');
    }
  }

  const responseText = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse || '');
  const safePromptSummary = redactSecrets(promptSummary || '');
  const safeResponse = redactSecrets(responseText);
  const responseSha256 = crypto.createHash('sha256').update(safeResponse).digest('hex');

  const startMs = Date.parse(startTime || '') || Date.now();
  const endMs = Date.parse(endTime || '') || Date.now();
  const latencyMs = Math.max(0, endMs - startMs);

  const record = {
    recordId: crypto.randomUUID(),
    runId: runId || 'unknown-run',
    trialId: trialId || 'unknown-trial',
    classification,
    provider: normalizeProviderName(provider) || 'unknown',
    model: typeof model === 'string' ? model.trim() : 'unknown',
    timestamp: new Date().toISOString(),
    latencyMs,
    tokensUsed: tokensUsed ? { ...tokensUsed } : null,
    costUsd: typeof costUsd === 'number' ? costUsd : null,
    responseSha256,
    digestType: 'CONTENT_INTEGRITY_SHA256_NOT_ATTESTATION',
    promptSummary: safePromptSummary,
    rawResponse: safeResponse,
    secretsRedacted: true,
    validationOutcome: validationOutcome ? { ...validationOutcome } : null,
    failureClassification,
  };

  return deepFreeze(record);
}

function resetConsumedTokensForTest() {
  consumedAuthorizationTokens.clear();
  const ledgerPath = getConsumedTokensLedgerPath();
  try {
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }
  } catch {}
  try {
    const lockPath = `${ledgerPath}.lock`;
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
  try {
    const { reservationsDir } = getReservationPath(ledgerPath, 'dummy');
    if (fs.existsSync(reservationsDir)) {
      fs.rmSync(reservationsDir, { recursive: true, force: true });
    }
  } catch {}
}

function clearInMemoryTokenCacheOnlyForTest() {
  consumedAuthorizationTokens.clear();
}

module.exports = {
  BENCHMARK_RESULT_CLASSIFICATIONS,
  ALLOWED_BENCHMARK_PROVIDERS,
  ALLOWED_BENCHMARK_FIXTURES,
  DEFAULT_MAX_TOKEN_BUDGET,
  DEFAULT_MAX_COST_USD,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_AUTHORIZATION_TTL_MS,
  isPathInsideOrEqual,
  validateLiveBenchmarkAuthorization,
  createBenchmarkEvidenceRecord,
  redactSecrets,
  resetConsumedTokensForTest,
  clearInMemoryTokenCacheOnlyForTest,
  setLedgerPathForTest,
  loadConsumedTokensLedger,
  assertSafeStoragePath,
  acquireLedgerLock,
  getProtectedDefaultLedgerPath,
  reserveTokenAtomically,
};
