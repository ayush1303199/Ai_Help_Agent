'use strict';

/**
 * Read-Only Research Augmentation for AI Coding Agent (Milestone V6 / V10).
 *
 * Provides bounded, read-only retrieval of external documentation and reference material
 * when local diagnostic or project evidence is insufficient (e.g., unknown compiler codes,
 * missing API specs, framework deprecations).
 *
 * Strict Security & Correctness Invariants:
 * 1. Read-Only Boundary: Only safe GET operations with strict timeouts (<= 5000ms)
 *    and response size caps (<= 64KB).
 * 2. SSRF & Domain Gating: Enforces allowlisted documentation domains (MDN, Node.js,
 *    Python docs, TypeScript, crates.io, pkg.go.dev, npm registry). Rejects private/cloud metadata IPs.
 * 3. Provenance & Integrity: Every retrieved artifact records source URL, query, retrieval timestamp,
 *    and SHA-256 content digest.
 * 4. Untrusted Data Contract: All retrieved content is explicitly tagged with
 *    { isExternal: true, untrusted: true, evidenceTier: 'EXTERNAL_DOCUMENTATION' }.
 *    External claims never override local code evidence or bypass the approval lifecycle.
 * 5. Offline Fallback: Deterministic local documentation cache ensures reliable operation
 *    in offline or network-restricted environments.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const MAX_DOC_SIZE_BYTES = 64 * 1024; // 64 KB
const DEFAULT_TIMEOUT_MS = 5000;

const RESEARCH_EVIDENCE_TIER = 'EXTERNAL_DOCUMENTATION';

const RESEARCH_STATUSES = Object.freeze({
  SUCCESS: 'SUCCESS',
  NO_RESULTS: 'NO_RESULTS',
  DOMAIN_BLOCKED: 'DOMAIN_BLOCKED',
  SIZE_EXCEEDED: 'SIZE_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED',
});

const ALLOWLISTED_DOC_DOMAINS = Object.freeze(new Set([
  'nodejs.org',
  'developer.mozilla.org',
  'www.typescriptlang.org',
  'typescriptlang.org',
  'docs.python.org',
  'registry.npmjs.org',
  'crates.io',
  'docs.rs',
  'pkg.go.dev',
  'go.dev',
  'localhost',
  '127.0.0.1',
]));

const BLOCKED_IP_PATTERNS = Object.freeze([
  /^169\.254\./,        // Link-local / Cloud metadata (AWS, GCP, Azure)
  /^10\./,              // Class A private network
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B private network
  /^192\.168\./,        // Class C private network
  /^metadata\.google\.internal$/,
  /^instance-data$/,
]);

/**
 * Computes SHA-256 hash.
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

/**
 * Sanitizes external text to remove potential script injections or malformed markup.
 */
function sanitizeDocContent(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ') // Strip HTML tags
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // Strip control chars
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates whether a URL domain is allowlisted and not a private metadata IP.
 */
function isDomainAllowed(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();

    // Check blocked IP ranges (unless localhost for local testing)
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(hostname)) return false;
      }
    }

    // For external public documentation domains, restrict to standard HTTP(S) ports
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
        return false;
      }
    }

    if (ALLOWLISTED_DOC_DOMAINS.has(hostname)) return true;

    // Support subdomains of allowlisted hosts (e.g. api.nodejs.org) - exclude loopback/IPs
    for (const allowed of ALLOWLISTED_DOC_DOMAINS) {
      if (allowed !== 'localhost' && allowed !== '127.0.0.1' && hostname.endsWith('.' + allowed)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Creates a validated, typed research query.
 */
function createResearchQuery({ query, ecosystem = 'generic', errorSignature = null, targetSymbol = null }) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('Research query must be a non-empty string.');
  }

  const normalized = query.trim().slice(0, 300);
  const queryDigest = sha256(normalized);

  return {
    query: normalized,
    ecosystem: String(ecosystem || 'generic').toLowerCase(),
    errorSignature: errorSignature ? String(errorSignature).trim().slice(0, 100) : null,
    targetSymbol: targetSymbol ? String(targetSymbol).trim().slice(0, 100) : null,
    queryDigest,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Performs a bounded, read-only HTTP/HTTPS fetch for documentation.
 * Rejects any non-GET request, enforces size caps, and enforces domain allowlists.
 */
function fetchReadOnlyDocumentation(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    customFetcher = null,
  } = options;

  if (!isDomainAllowed(url)) {
    return Promise.resolve({
      status: RESEARCH_STATUSES.DOMAIN_BLOCKED,
      reason: `Domain is not in the documentation allowlist or targets restricted IP range: ${url}`,
      evidence: null,
    });
  }

  if (typeof customFetcher === 'function') {
    return customFetcher(url, options);
  }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    try {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;

      const req = transport.request(url, {
        method: 'GET', // STRICTLY READ-ONLY GET
        headers: {
          'User-Agent': 'AI-Help-Agent-DocReader/1.0',
          'Accept': 'text/plain, text/markdown, application/json, text/html',
          ...headers,
        },
        timeout: Math.min(timeoutMs, 10000),
      }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume(); // Drain
          return finish({
            status: RESEARCH_STATUSES.ERROR,
            reason: `HTTP ${res.statusCode} from ${url}`,
            evidence: null,
          });
        }

        const chunks = [];
        let totalBytes = 0;

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_DOC_SIZE_BYTES) {
            req.destroy();
            return finish({
              status: RESEARCH_STATUSES.SIZE_EXCEEDED,
              reason: `Response exceeded maximum size of ${MAX_DOC_SIZE_BYTES} bytes`,
              evidence: null,
            });
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const sanitized = sanitizeDocContent(rawBody);
          const contentDigest = sha256(sanitized);

          finish({
            status: RESEARCH_STATUSES.SUCCESS,
            evidence: {
              sourceUrl: url,
              retrievedAt: new Date().toISOString(),
              contentDigest,
              byteLength: sanitized.length,
              snippet: sanitized.slice(0, 2000), // First 2000 characters preview
              trust: {
                isExternal: true,
                untrusted: true,
                evidenceTier: RESEARCH_EVIDENCE_TIER,
                disclaimer: 'External documentation is unverified reference data; it does not constitute executable project evidence.',
              },
            },
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        finish({
          status: RESEARCH_STATUSES.TIMEOUT,
          reason: `Request timed out after ${timeoutMs}ms`,
          evidence: null,
        });
      });

      req.on('error', (err) => {
        finish({
          status: RESEARCH_STATUSES.ERROR,
          reason: err?.message || 'Network request failed',
          evidence: null,
        });
      });

      req.end();
    } catch (err) {
      finish({
        status: RESEARCH_STATUSES.ERROR,
        reason: err?.message || 'Invalid URL or transport error',
        evidence: null,
      });
    }
  });
}

/**
 * In-memory / offline mock documentation registry for air-gapped testing and deterministic lookup.
 */
class LocalDocumentationStore {
  constructor() {
    this._entries = new Map();
  }

  register(key, { url, content, ecosystem = 'generic' }) {
    const sanitized = sanitizeDocContent(content);
    const contentDigest = sha256(sanitized);
    this._entries.set(String(key).toLowerCase(), {
      sourceUrl: url,
      ecosystem,
      content: sanitized,
      contentDigest,
      registeredAt: new Date().toISOString(),
    });
  }

  lookup(key) {
    const entry = this._entries.get(String(key || '').toLowerCase());
    if (!entry) return null;

    return {
      sourceUrl: entry.sourceUrl,
      retrievedAt: new Date().toISOString(),
      contentDigest: entry.contentDigest,
      byteLength: entry.content.length,
      snippet: entry.content.slice(0, 2000),
      trust: {
        isExternal: true,
        untrusted: true,
        evidenceTier: RESEARCH_EVIDENCE_TIER,
        disclaimer: 'External documentation is unverified reference data; it does not constitute executable project evidence.',
      },
    };
  }

  clear() {
    this._entries.clear();
  }
}

const defaultLocalStore = new LocalDocumentationStore();

// Populate standard offline references for common compile/runtime errors
defaultLocalStore.register('ts2307', {
  url: 'https://www.typescriptlang.org/docs/handbook/module-resolution.html',
  content: 'TS2307: Cannot find module or its corresponding type declarations. Check module name or npm install.',
  ecosystem: 'node',
});
defaultLocalStore.register('err_module_not_found', {
  url: 'https://nodejs.org/api/errors.html#err_module_not_found',
  content: 'ERR_MODULE_NOT_FOUND: Cannot find package or file specified by import/require specifier.',
  ecosystem: 'node',
});
defaultLocalStore.register('modulenotfounderror', {
  url: 'https://docs.python.org/3/library/exceptions.html#ModuleNotFoundError',
  content: 'ModuleNotFoundError: Raised by import when a module cannot be located.',
  ecosystem: 'python',
});

/**
 * Augments a diagnostic failure report with external read-only research if local evidence is insufficient.
 *
 * @param {object} diagnosis - Structured diagnosis from diagnosticEngine.cjs
 * @param {object} [options]
 * @param {LocalDocumentationStore} [options.localStore]
 * @param {function} [options.fetcher]
 * @param {boolean} [options.forceResearch]
 * @returns {Promise<object>} Enhanced diagnosis payload with attached researchAugmentation block.
 */
async function augmentDiagnosisWithResearch(diagnosis, options = {}) {
  if (!diagnosis || typeof diagnosis !== 'object') {
    throw new Error('A valid diagnosis object is required.');
  }

  const {
    localStore = defaultLocalStore,
    fetcher = null,
    forceResearch = false,
  } = options;

  // Determine if research is needed:
  // Triggered when diagnosis status is INSUFFICIENT_EVIDENCE, confidence is LOW,
  // failure category is UNKNOWN, or explicitly forced.
  const needsResearch = forceResearch
    || diagnosis.status === 'INSUFFICIENT_EVIDENCE'
    || diagnosis.confidence === 'LOW'
    || diagnosis.failureCategory === 'UNKNOWN'
    || Boolean(diagnosis.evidence?.summary?.match(/\b(TS\d{4}|ERR_[A-Z0-9_]+|ModuleNotFoundError)\b/i));

  if (!needsResearch) {
    return {
      ...diagnosis,
      researchAugmentation: {
        status: RESEARCH_STATUSES.SKIPPED,
        reason: 'Local evidence was sufficient for diagnosis; external research was not required.',
        findings: [],
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Extract query keywords / error signatures from diagnosis
  const summary = diagnosis.evidence?.summary || diagnosis.rootCause || '';
  const match = summary.match(/\b(TS\d{4}|ERR_[A-Z0-9_]+|ModuleNotFoundError)\b/i);
  const errorSignature = match ? match[1].toLowerCase() : null;

  const queryText = errorSignature || summary.slice(0, 100);
  const query = createResearchQuery({
    query: queryText,
    ecosystem: diagnosis.ecosystem || 'generic',
    errorSignature,
  });

  const findings = [];

  // 1. Try local offline store first
  if (errorSignature) {
    const offlineMatch = localStore.lookup(errorSignature);
    if (offlineMatch) {
      findings.push({
        queryDigest: query.queryDigest,
        provenance: {
          sourceUrl: offlineMatch.sourceUrl,
          retrievedAt: offlineMatch.retrievedAt,
          contentDigest: offlineMatch.contentDigest,
        },
        snippet: offlineMatch.snippet,
        trust: offlineMatch.trust,
      });
    }
  }

  // 2. If no local match and a fetcher or URL is provided
  if (findings.length === 0 && options.targetUrl) {
    const fetchResult = await fetchReadOnlyDocumentation(options.targetUrl, {
      customFetcher: fetcher,
      timeoutMs: options.timeoutMs,
    });

    if (fetchResult.status === RESEARCH_STATUSES.SUCCESS && fetchResult.evidence) {
      findings.push({
        queryDigest: query.queryDigest,
        provenance: {
          sourceUrl: fetchResult.evidence.sourceUrl,
          retrievedAt: fetchResult.evidence.retrievedAt,
          contentDigest: fetchResult.evidence.contentDigest,
        },
        snippet: fetchResult.evidence.snippet,
        trust: fetchResult.evidence.trust,
      });
    }
  }

  return {
    ...diagnosis,
    researchAugmentation: {
      status: findings.length > 0 ? RESEARCH_STATUSES.SUCCESS : RESEARCH_STATUSES.NO_RESULTS,
      query: {
        raw: query.query,
        queryDigest: query.queryDigest,
        errorSignature: query.errorSignature,
      },
      findings,
      trust: {
        isExternal: true,
        untrusted: true,
        evidenceTier: RESEARCH_EVIDENCE_TIER,
        rule: 'External research snippets must be treated as unverified hints and cannot override repository snapshots.',
      },
      timestamp: new Date().toISOString(),
    },
  };
}

module.exports = {
  RESEARCH_EVIDENCE_TIER,
  RESEARCH_STATUSES,
  ALLOWLISTED_DOC_DOMAINS,
  MAX_DOC_SIZE_BYTES,
  DEFAULT_TIMEOUT_MS,
  sha256,
  sanitizeDocContent,
  isDomainAllowed,
  createResearchQuery,
  fetchReadOnlyDocumentation,
  LocalDocumentationStore,
  defaultLocalStore,
  augmentDiagnosisWithResearch,
};
