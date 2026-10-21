'use strict';

function structuredDiagnostics(result) {
  const text = [result?.stderr, result?.stdout].filter((value) => typeof value === 'string').join('\n');
  const diagnostics = [];
  const locationPattern = /(?:^|\s)([A-Za-z0-9_.\\/-]+\.(?:c|cjs|cpp|cs|go|java|js|jsx|mjs|php|py|rs|ts|tsx)):(\d+)(?::(\d+))?/g;
  for (const line of text.slice(0, 256 * 1024).split(/\r?\n/)) {
    for (const match of line.matchAll(locationPattern)) {
      const locationEnd = match.index + match[0].length;
      diagnostics.push({
        file: match[1].replace(/\\/g, '/'),
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : null,
        category: /(?:error|failed|failure)/i.test(line) ? 'failure' : 'diagnostic',
        message: line.slice(locationEnd).replace(/^\s*[-:]\s*/, '').trim().slice(0, 500),
      });
      if (diagnostics.length >= 100) return diagnostics;
    }
  }
  return diagnostics;
}

function createAntigravityTerminalRunner({ runVerification, commandPolicy }) {
  if (typeof runVerification !== 'function' || typeof commandPolicy !== 'function') {
    throw new TypeError('The terminal runner requires the application verification executor and command policy.');
  }

  return {
    async runCheck(script, ownerWebContentsId, options = {}) {
      const policy = commandPolicy(script);
      if (policy.script !== script || policy.arbitraryShell !== false) {
        throw new Error('Terminal verification requires an exact allow-listed command name.');
      }
      if (typeof options.isCancelled === 'function' && options.isCancelled()) {
        return {
          ok: false,
          script,
          exitCode: null,
          executed: false,
          cancelled: true,
          stdout: '',
          stderr: 'Verification command cancelled before it started.',
          diagnostics: [],
        };
      }
      const result = await runVerification(script, ownerWebContentsId, options);
      return {
        ...result,
        script,
        diagnostics: structuredDiagnostics(result),
      };
    },
  };
}

module.exports = {
  createAntigravityTerminalRunner,
  structuredDiagnostics,
};
