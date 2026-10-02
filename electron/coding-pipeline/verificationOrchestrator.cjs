/**
 * Adaptive Verification Orchestrator & Regression Intelligence Engine.
 * Dynamically selects verification suites based on risk, computes regression blast radius,
 * and enforces security gates.
 */

const path = require('node:path');

const SECURITY_PATTERNS = Object.freeze([
  { pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_=-]{16,}['"]/i, description: 'Potential hardcoded secret or token' },
  { pattern: /\.\.[\\/]\.\.[\\/]/, description: 'Potential directory traversal attack' },
  { pattern: /rm\s+-rf\s+[\\/]|del\s+\/[sfq]\s+[c-z]:\\/i, description: 'Unsafe recursive deletion command' },
]);

class VerificationOrchestrator {
  computeAdaptivePlan({ risk = 'LOW', hasTests = true, hasTypecheck = true, hasLint = true, hasBuild = false, isUiTask = false }) {
    const scripts = [];

    // Low risk: focused test only
    if (risk === 'LOW') {
      if (hasTests) scripts.push('test');
      else if (hasTypecheck) scripts.push('typecheck');
      else if (hasLint) scripts.push('lint');
      return { level: 'FOCUSED', scripts, reason: 'Low-risk isolated change requires focused check' };
    }

    // Medium risk: typecheck + test + lint
    if (risk === 'MEDIUM') {
      if (hasTypecheck) scripts.push('typecheck');
      if (hasTests) scripts.push('test');
      if (hasLint) scripts.push('lint');
      return { level: 'STANDARD', scripts, reason: 'Medium-risk change requires tests, types, and lints' };
    }

    // High / Critical: full battery
    if (hasTypecheck) scripts.push('typecheck');
    if (hasLint) scripts.push('lint');
    if (hasTests) scripts.push('test');
    if (hasBuild) scripts.push('build');
    if (isUiTask) scripts.push('browser_verify');

    return {
      level: 'COMPREHENSIVE',
      scripts,
      reason: 'High-risk or broad-scope change requires full test and build verification battery',
    };
  }

  detectRegressionTargets({ modifiedFiles = [], dependencyGraph = {} }) {
    const candidates = new Set();
    const normalizedModified = modifiedFiles.map((f) => f.replace(/\\/g, '/').toLowerCase());

    for (const [file, deps] of Object.entries(dependencyGraph)) {
      const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
      const depList = Array.isArray(deps) ? deps : [];

      for (const dep of depList) {
        const normalizedDep = dep.replace(/\\/g, '/').toLowerCase();
        if (normalizedModified.some((m) => normalizedDep.includes(m) || m.includes(normalizedDep))) {
          candidates.add(file);
        }
      }
    }

    return Array.from(candidates);
  }

  inspectSecurityGates(patchText = '') {
    const violations = [];
    for (const { pattern, description } of SECURITY_PATTERNS) {
      if (pattern.test(patchText)) {
        violations.push({ description, pattern: pattern.toString() });
      }
    }
    return {
      passed: violations.length === 0,
      violations,
    };
  }

  redactSecrets(rawText = '') {
    if (typeof rawText !== 'string') return rawText;
    return rawText
      .replace(/(?:sk-|ghp_|api[_-]?key[=:\s]+|bearer\s+)[A-Za-z0-9_.-]{6,}/gi, '[REDACTED]')
      .replace(/(?:password|secret|token)\s*[:=]\s*['"][^'"]+['"]/gi, 'secret=[REDACTED]');
  }
}

const verificationOrchestrator = new VerificationOrchestrator();

module.exports = {
  VerificationOrchestrator,
  verificationOrchestrator,
};
