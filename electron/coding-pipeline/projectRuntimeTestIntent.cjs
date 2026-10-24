'use strict';

const { patterns } = require('./projectRuntimeTestIntentPatterns.json');

function isProjectRuntimeTestRequest(requestText) {
  const text = String(requestText || '')
    .trim()
    .replace(/\s*\n+\s*Workspace resolution:\s*(?:UPDATE_AND_INTEGRATE|REPLACE_TARGETS|KEEP_AND_SCAFFOLD)\.?\s*$/i, '')
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!text) return false;
  const command = text.replace(/^(?:(?:please|can you|could you|would you|will you)\s+)+/i, '');
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(command)
    || new RegExp(pattern, 'i').test(text));
}

module.exports = { isProjectRuntimeTestRequest };
