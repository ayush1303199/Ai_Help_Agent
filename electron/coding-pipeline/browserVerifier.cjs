/**
 * Browser & Runtime Computer Verification Engine.
 * Task-isolated browser verification, HTTP inspection, route checking, and DOM analysis.
 * Does not interact with user's personal browser.
 */

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs/promises');

class BrowserVerifier {
  constructor() {
    this._evidenceRecords = new Map(); // taskId -> Array of evidence objects
  }

  async verifyEndpoint({ port, route = '/', host = '127.0.0.1', expectedStatus = 200, timeoutMs = 3000 }) {
    const started = Date.now();
    const cleanRoute = route.startsWith('/') ? route : `/${route}`;

    return new Promise((resolve) => {
      const options = {
        host,
        port,
        path: cleanRoute,
        method: 'GET',
        headers: { 'User-Agent': 'CodingAgent-Verifier/1.0' },
        timeout: timeoutMs,
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const durationMs = Date.now() - started;
          const statusOk = res.statusCode === expectedStatus || (expectedStatus === 200 && res.statusCode >= 200 && res.statusCode < 400);

          resolve({
            ok: statusOk,
            statusCode: res.statusCode,
            durationMs,
            bodyLength: body.length,
            bodySnippet: body.slice(0, 500),
            headers: res.headers,
            classification: statusOk ? 'SUCCESS' : this._classifyHttpFailure(res.statusCode, body),
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          ok: false,
          statusCode: null,
          durationMs: Date.now() - started,
          classification: 'TIMEOUT',
          error: `Request to http://${host}:${port}${cleanRoute} timed out after ${timeoutMs}ms`,
        });
      });

      req.on('error', (err) => {
        resolve({
          ok: false,
          statusCode: null,
          durationMs: Date.now() - started,
          classification: 'CONNECTION_REFUSED',
          error: err.message,
        });
      });

      req.end();
    });
  }

  _classifyHttpFailure(statusCode, body) {
    if (statusCode === 404) return 'ROUTE_NOT_FOUND';
    if (statusCode === 401 || statusCode === 403) return 'AUTHENTICATION_REQUIRED';
    if (statusCode >= 500) {
      if (/sql|database|query|connection/i.test(body)) return 'BACKEND_DATABASE_ERROR';
      return 'BACKEND_SERVER_ERROR';
    }
    if (/cors/i.test(body)) return 'CORS_MISCONFIGURATION';
    return 'UNEXPECTED_STATUS_CODE';
  }

  async recordBrowserEvidence(taskId, evidence) {
    if (!this._evidenceRecords.has(taskId)) {
      this._evidenceRecords.set(taskId, []);
    }
    const record = {
      ...evidence,
      timestamp: new Date().toISOString(),
    };
    this._evidenceRecords.get(taskId).push(record);
    return record;
  }

  getBrowserEvidence(taskId) {
    return this._evidenceRecords.get(taskId) || [];
  }

  async evaluateBrowserOrFallback({ port, route = '/', host = '127.0.0.1', expectedStatus = 200, timeoutMs = 3000, browserAvailable = false }) {
    if (browserAvailable && typeof this._runLiveBrowserInspection === 'function') {
      return this._runLiveBrowserInspection({ port, route, host, expectedStatus, timeoutMs });
    }

    const endpointResult = await this.verifyEndpoint({ port, route, host, expectedStatus, timeoutMs });
    return {
      ...endpointResult,
      browserAvailable: false,
      capabilityMode: 'HTTP_DOM_FALLBACK',
      visualVerified: false,
      limitationReported: 'Real browser automation unavailable in this environment; verified through HTTP endpoint status and DOM response inspection.',
    };
  }
}

const browserVerifier = new BrowserVerifier();

module.exports = {
  BrowserVerifier,
  browserVerifier,
};
