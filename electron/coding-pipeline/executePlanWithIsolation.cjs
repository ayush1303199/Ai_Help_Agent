const { requireProjectProcessIsolation } = require('./projectProcessIsolation.cjs');
const { createProjectContainerExecutionRunner } = require('./projectContainerExecutionRunner.cjs');

/**
 * Executes a build plan using the verified isolation runtime.
 * @param {Object} plan - Build plan (must contain `operation` and optional `evidence`).
 * @param {number} ownerWebContentsId - Caller identifier.
 * @param {string} sessionId - Session identifier.
 * @returns {Promise<Object>} Result object { ok: boolean, ... }.
 */
async function executePlan(plan, ownerWebContentsId, sessionId) {
  // 1️⃣ Ask the isolation gate for a verified runtime (throws on failure)
  const runtime = requireProjectProcessIsolation(plan.operation, plan.evidence, null, {});

  // 2️⃣ Construct the container runner (mockable for tests)
  const runner = createProjectContainerExecutionRunner({ isMock: true });

  // 3️⃣ Execute with explicit runtime hand‑off
  return await runner.executeWithRuntime({ plan, ownerWebContentsId, sessionId, runtime });
}

module.exports = { executePlan };