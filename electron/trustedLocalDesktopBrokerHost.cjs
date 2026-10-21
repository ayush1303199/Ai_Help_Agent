'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const developerAgent = require('./developerAgent.cjs');
const developerFiles = require('./developerFiles.cjs');
const { TrustedLocalDesktopBroker } = require('./coding-pipeline/trustedLocalDesktopBroker.cjs');
const defaultRuntimeSettings = require('../src/config/runtimeSettings.json');

const runtimeSettingsPath = process.env.AI_RUNTIME_SETTINGS_PATH;
const runtimeSettings = runtimeSettingsPath
  ? JSON.parse(require('node:fs').readFileSync(path.resolve(runtimeSettingsPath), 'utf8'))
  : defaultRuntimeSettings;
const { services, electron: electronSettings = {} } = runtimeSettings;
const authToken = process.env.AI_CODING_AUTH_TOKEN;
const mutationHandshakeSecret = process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET;
if (!authToken || !mutationHandshakeSecret) {
  throw new Error('Standalone broker host requires application-owned backend authentication and mutation secrets.');
}

const backendUrl = new URL(services.http.baseUrl);
const backendBaseUrl = backendUrl.origin;
const rendererHost = String(services.devServer.host || '127.0.0.1');
const rendererPort = services.devServer.port;
const allowedOrigins = [...new Set([
  `http://${rendererHost}:${rendererPort}`,
  `http://localhost:${rendererPort}`,
  `http://127.0.0.1:${rendererPort}`,
])];
const registrationOwnerId = crypto.randomInt(1, 0xFFFFFFFFFFFF);
const runtimeDirectoryPromise = fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-browser-broker-'));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
};
const mutationProof = (payload) => crypto.createHmac('sha256', mutationHandshakeSecret)
  .update(JSON.stringify(canonicalJson(payload)))
  .digest('hex');
const rootIdentity = (root) => {
  const normalized = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  return normalized;
};

let broker;
let currentRoot = null;
let stopping = false;

async function attachBrokerLease({ root, ownerWebContentsId, sessionId }) {
  const attached = await developerFiles.attachProject(root, ownerWebContentsId);
  if (attached.status !== 'PROJECT_ATTACHED' || !attached.projectRoot
    || rootIdentity(attached.projectRoot) !== rootIdentity(root)) {
    throw new Error(attached.reason || 'Standalone broker could not attach the authorized project lease.');
  }
  developerAgent.createSessionForBroker(ownerWebContentsId, sessionId);
}

async function releaseBrokerLease({ ownerWebContentsId }) {
  developerAgent.releaseSession(ownerWebContentsId);
  developerFiles.releaseProject(ownerWebContentsId);
}

async function authorizeMutation({
  request,
  approvedProposal,
  projectRoot,
  ownerWebContentsId,
  sessionId,
}) {
  if (!currentRoot || rootIdentity(currentRoot) !== rootIdentity(projectRoot)
    || rootIdentity(developerFiles.getProjectRoot(ownerWebContentsId) || '') !== rootIdentity(projectRoot)) {
    throw new Error('The attached standalone workspace changed before mutation authorization.');
  }
  developerAgent.getTaskProposalForBroker(request.taskId, { sessionId, ownerWebContentsId });
  const payload = {
    operation: request.operation,
    paths: request.paths,
    proposalApproved: request.proposalApproved === true,
    deleteConfirmed: approvedProposal.deleteConfirmed === true,
    requestBinding: request.requestBinding,
  };
  const response = await fetch(new URL('/api/coding/policy/file-mutation', backendBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Coding-Auth': authToken,
      'X-Coding-Mutation-Proof': mutationProof(payload),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(electronSettings.portConnectTimeoutMs || 10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Standalone broker mutation policy failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`);
  }
  const decision = await response.json();
  return {
    allowed: decision?.decision === 'ALLOW',
    reason: typeof decision?.reason === 'string' ? decision.reason : 'Backend policy denied the mutation.',
  };
}

async function publishRegistry() {
  if (!broker?.endpoint) return;
  const response = await fetch(new URL('/api/coding/broker/register', backendBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Coding-Auth': authToken },
    body: JSON.stringify({ endpoint: broker.endpoint, projects: broker.registeredProjects() }),
    signal: AbortSignal.timeout(electronSettings.portConnectTimeoutMs || 10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Standalone broker registration failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`);
  }
}

async function syncAttachedProject() {
  const response = await fetch(new URL('/api/coding/project-state', backendBaseUrl), {
    headers: { 'X-Coding-Auth': authToken },
    signal: AbortSignal.timeout(electronSettings.portConnectTimeoutMs || 10000),
  });
  if (!response.ok) throw new Error(`Attached project lookup failed (${response.status}).`);
  const state = await response.json();
  const nextRoot = state?.status === 'PROJECT_ATTACHED' && typeof state.projectRoot === 'string'
    ? await fs.realpath(state.projectRoot)
    : null;
  if (nextRoot === currentRoot) return;
  if (currentRoot) await broker.unregisterProject(registrationOwnerId);
  currentRoot = null;
  if (nextRoot) {
    const stat = await fs.stat(nextRoot);
    if (!stat.isDirectory()) throw new Error('The attached browser workspace is not a directory.');
    await broker.registerProject({
      root: nextRoot,
      registrationOwnerId,
    });
    currentRoot = nextRoot;
  }
  await publishRegistry();
}

async function wait(ms) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function synchronize() {
  let retryMs = 500;
  let lastDiagnostic = '';
  while (!stopping) {
    try {
      await syncAttachedProject();
      await publishRegistry();
      retryMs = 3000;
      lastDiagnostic = '';
      await wait(3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastDiagnostic) {
        console.warn(`[CODING][BROKER] Standalone registry synchronization retrying: ${message}`);
        lastDiagnostic = message;
      }
      await wait(retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    }
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    if (broker) {
      await broker.unregisterProject(registrationOwnerId);
      await publishRegistry();
      await broker.stop();
    }
  } catch (error) {
    console.error('[CODING][BROKER] Standalone broker shutdown failed:', error);
  }
  const runtimeDirectory = await runtimeDirectoryPromise;
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
}

async function main() {
  const runtimeDirectory = await runtimeDirectoryPromise;
  developerFiles.configureAuditDirectory(path.join(runtimeDirectory, 'developer-audit'));
  developerAgent.configureDurability({
    journalFile: path.join(runtimeDirectory, 'developer-task-journal.json'),
    auditFile: path.join(runtimeDirectory, 'developer-audit.jsonl'),
  });
  developerAgent.configureCheckpointStorageRoot(path.join(runtimeDirectory, 'developer-checkpoints'));
  await developerAgent.loadJournal();
  broker = new TrustedLocalDesktopBroker({
    allowedOrigins,
    sessionTtlMs: Number.isSafeInteger(electronSettings.brokerSessionTtlMs)
      ? electronSettings.brokerSessionTtlMs
      : undefined,
    browserApproval: true,
    synchronizeProjects: async () => {
      await syncAttachedProject();
      await publishRegistry();
    },
    executeWorkflow: async (input) => developerAgent.executeAutonomousCodingWorkflow({
      userRequest: input.userRequest,
      root: input.root,
      scope: input.scope,
      sessionId: input.sessionId,
      ownerWebContentsId: input.ownerWebContentsId,
      userApproved: false,
      isCancelled: input.isCancelled,
      requestApproval: input.requestApproval,
      tools: { authorizeMutation: input.authorizeMutation },
    }),
    onLeaseCreated: attachBrokerLease,
    onLeaseReleased: releaseBrokerLease,
    requestApproval: async () => false,
    getTask: (taskId, owner) => developerAgent.getTaskProposalForBroker(taskId, owner),
    validateSnapshots: (taskId, owner) => developerAgent.validateTaskProposalSnapshots(taskId, owner),
    authorizeMutation,
  });
  await broker.start();
  console.info('[CODING][BROKER] Standalone trusted browser broker started on a dynamic loopback endpoint.');
  await synchronize();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[CODING][BROKER] Standalone broker host failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    void shutdown();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown());
  }
}

module.exports = { main, syncAttachedProject, mutationProof };
