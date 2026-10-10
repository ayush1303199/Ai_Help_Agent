const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertSandboxProbe, probeWindowsSandbox } = require('./windowsSandboxRunner.cjs');

const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);
const windowsSandboxExecutable = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
let currentStatus = makeUnavailableStatus();
let verificationPromise = null;
let lastVerificationAttemptAt = 0;

function makeUnavailableStatus(reason = 'Project-context process execution is disabled because no verified operating-system sandbox is configured.') {
  return Object.freeze({
    available: false,
    verified: false,
    platformRecognized: supportedPlatforms.has(process.platform),
    reason,
    platform: process.platform,
  });
}

function projectProcessIsolationStatus(platform = process.platform) {
  if (platform !== process.platform) {
    const supportedPlatform = supportedPlatforms.has(platform);
    return Object.freeze({
      available: false,
      verified: false,
      platformRecognized: supportedPlatform,
      reason: supportedPlatform
        ? `Project-context process execution has not been verified on platform "${platform}".`
        : `Project-context process execution is unsupported on platform "${platform}".`,
      platform,
    });
  }
  return currentStatus;
}

async function verifyProjectProcessIsolation() {
  if (process.platform !== 'win32') {
    currentStatus = makeUnavailableStatus(
      `Project-context process execution has no verified sandbox adapter for platform "${process.platform}".`,
    );
    return currentStatus;
  }
  if (verificationPromise) return verificationPromise;
  if (lastVerificationAttemptAt && Date.now() - lastVerificationAttemptAt < 60_000) return currentStatus;
  lastVerificationAttemptAt = Date.now();

  verificationPromise = (async () => {
    let temporaryRoot;
    try {
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-sandbox-check-'));
      const projectRoot = path.join(temporaryRoot, 'project');
      await fs.access(windowsSandboxExecutable);
      await fs.mkdir(projectRoot);
      const evidence = await probeWindowsSandbox(projectRoot);
      assertSandboxProbe(evidence.checks, evidence);
      currentStatus = Object.freeze({
        available: true,
        verified: true,
        platformRecognized: true,
        reason: null,
        platform: process.platform,
        verifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      currentStatus = makeUnavailableStatus(`Windows Sandbox isolation is not verified: ${detail.slice(0, 400)}`);
    } finally {
      if (temporaryRoot) {
        try {
          await fs.rm(temporaryRoot, { recursive: true, force: true });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          currentStatus = makeUnavailableStatus(`Windows Sandbox probe cleanup failed: ${detail.slice(0, 400)}`);
        }
      }
    }
    return currentStatus;
  })();

  try {
    return await verificationPromise;
  } finally {
    verificationPromise = null;
  }
}

function markProjectProcessIsolationUnavailable(reason) {
  const detail = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : 'The Windows Sandbox runner failed after its initial probe.';
  currentStatus = makeUnavailableStatus(`Windows Sandbox isolation is no longer verified: ${detail.slice(0, 400)}`);
}

function requireProjectProcessIsolation(operation) {
  const label = typeof operation === 'string' && operation.trim()
    ? operation.trim()
    : 'Project command';
  const status = projectProcessIsolationStatus();
  if (!status.available || !status.verified) {
    throw new Error(`${label} was not started. ${status.reason}`);
  }
}

module.exports = {
  markProjectProcessIsolationUnavailable,
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
  verifyProjectProcessIsolation,
};
