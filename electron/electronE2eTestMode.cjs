'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODE_ENV = 'AI_CODING_E2E_TEST_MODE';
const ROOT_ENV = 'AI_CODING_E2E_ROOT';
const TOKEN_ENV = 'AI_CODING_E2E_TOKEN';
const SETTINGS_ENV = 'AI_CODING_E2E_SETTINGS_PATH';
const USER_DATA_ENV = 'AI_CODING_E2E_USER_DATA';
const WORKSPACE_ENV = 'AI_CODING_E2E_WORKSPACE';
const APPROVAL_ENV = 'AI_CODING_E2E_APPROVAL';
const OWNER_FILE = '.ai-coding-electron-e2e-owner';

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realDirectory(root, candidate, label) {
  const resolved = fs.realpathSync(candidate);
  if (!containedBy(root, resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be an existing directory owned by the isolated Electron E2E root.`);
  }
  return resolved;
}

function isExactLoopbackUrl(value, protocol, port) {
  try {
    const url = new URL(value);
    return url.protocol === protocol
      && url.hostname === '127.0.0.1'
      && url.port === String(port)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === '/';
  } catch {
    return false;
  }
}

function loadElectronE2eTestMode(defaultSettings) {
  const mode = process.env[MODE_ENV];
  if (mode === undefined) return null;
  if (mode !== '1') throw new Error(`${MODE_ENV} must be exactly "1" when set.`);

  const supplied = [
    ROOT_ENV,
    TOKEN_ENV,
    SETTINGS_ENV,
    USER_DATA_ENV,
    WORKSPACE_ENV,
    APPROVAL_ENV,
  ];
  if (supplied.some((name) => !process.env[name])) {
    throw new Error('Electron E2E test mode is missing required isolation configuration.');
  }

  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(process.env[ROOT_ENV]);
  if (!containedBy(tempRoot, root) || root === tempRoot || !fs.statSync(root).isDirectory()) {
    throw new Error('Electron E2E test root must be a dedicated child directory of the OS temporary directory.');
  }

  const token = process.env[TOKEN_ENV];
  if (token.length < 32) throw new Error('Electron E2E ownership token is invalid.');
  const ownerFile = path.join(root, OWNER_FILE);
  if (fs.readFileSync(ownerFile, 'utf8') !== token) {
    throw new Error('Electron E2E ownership marker does not match this process.');
  }

  const settingsPath = fs.realpathSync(process.env[SETTINGS_ENV]);
  const userDataDirectory = realDirectory(root, process.env[USER_DATA_ENV], 'Electron user-data directory');
  const workspaceRoot = realDirectory(root, process.env[WORKSPACE_ENV], 'Disposable project workspace');
  if (settingsPath !== path.join(root, 'runtimeSettings.json')) {
    throw new Error('Electron E2E runtime settings must be inside the owned test root.');
  }
  if (path.dirname(userDataDirectory) !== root || path.dirname(workspaceRoot) !== root) {
    throw new Error('Electron E2E user data and project workspace must be direct children of the owned test root.');
  }
  if (fs.readdirSync(workspaceRoot).length !== 0) {
    throw new Error('The disposable Electron E2E project workspace must start empty.');
  }

  let testSettings;
  try {
    testSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw new Error('Electron E2E runtime settings are unreadable or invalid JSON.', { cause: error });
  }
  const services = testSettings?.services;
  const serviceEntries = [
    services?.http,
    services?.websocket,
    services?.codingWebsocket,
    services?.devServer,
  ];
  if (serviceEntries.some((service) => !service
    || !['127.0.0.1', 'localhost'].includes(service.host)
    || !Number.isInteger(service.port)
    || service.port < 1024
    || service.port > 65535)) {
    throw new Error('Electron E2E services must use valid loopback-only ports.');
  }
  if (new Set(serviceEntries.map((service) => service.port)).size !== serviceEntries.length) {
    throw new Error('Electron E2E services must use distinct isolated ports.');
  }
  const approvalMode = process.env[APPROVAL_ENV];
  if (!['approve-once', 'cancel-once'].includes(approvalMode)) {
    throw new Error('Electron E2E approval mode must be approve-once or cancel-once.');
  }
  if (!isExactLoopbackUrl(services.http.baseUrl, 'http:', services.http.port)
    || !isExactLoopbackUrl(services.websocket.baseUrl, 'ws:', services.websocket.port)
    || !isExactLoopbackUrl(services.codingWebsocket.baseUrl, 'ws:', services.codingWebsocket.port)) {
    throw new Error('Electron E2E service URLs must exactly match their loopback-only ports.');
  }

  return {
    root,
    workspaceRoot,
    userDataDirectory,
    runtimeSettings: { ...defaultSettings, ...testSettings },
    approvalMode,
    evidencePath: path.join(root, 'workflow-evidence.json'),
    resultPath: path.join(root, 'workflow-result.json'),
    approvalSeen: false,
    resultSeen: false,
    // This deterministic adapter approves one validated proposal only in isolated E2E runs.
    async requestApproval({ root: projectRoot, scope, workflowRequestId, proposal, proposalContract, diff }) {
      if (this.approvalSeen) throw new Error('The Electron E2E adapter permits only one proposal approval.');
      this.approvalSeen = true;
      const canonicalRoot = fs.realpathSync(projectRoot);
      const canonicalScope = path.resolve(canonicalRoot, scope);
      const targets = proposal?.targetFiles;
      if (canonicalRoot !== workspaceRoot
        || canonicalScope !== workspaceRoot
        || proposalContract?.isGreenfield !== true
        || !Array.isArray(targets)
        || targets.length === 0
        || targets.length > 32
        || typeof proposal?.manifestHash !== 'string'
        || !/^[a-f0-9]{64}$/i.test(proposal.manifestHash)
        || typeof diff !== 'string'
        || !diff.trim()) {
        throw new Error('Electron E2E approval adapter rejected a proposal outside the isolated greenfield contract.');
      }

      const files = targets.map((target) => {
        if (typeof target !== 'string' || !target.trim()) {
          throw new Error('Electron E2E proposal contains an invalid target path.');
        }
        const absolute = path.resolve(canonicalRoot, target);
        if (!containedBy(canonicalRoot, absolute) || absolute === canonicalRoot || fs.existsSync(absolute)) {
          throw new Error('Electron E2E proposal target escapes the empty workspace or already exists.');
        }
        return path.relative(canonicalRoot, absolute);
      });
      const decision = this.approvalMode === 'approve-once' ? 'APPROVE' : 'CANCEL';
      const evidence = {
        status: 'AWAITING_TEST_DECISION',
        decision,
        workflowRequestId,
        projectRoot: canonicalRoot,
        scope: '.',
        taskId: proposal.taskId,
        manifestHash: proposal.manifestHash,
        files,
        diffSha256: require('node:crypto').createHash('sha256').update(diff).digest('hex'),
      };
      fs.writeFileSync(this.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      if (this.approvalMode === 'cancel-once') {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return false;
      }
      evidence.status = 'TEST_APPROVED';
      fs.writeFileSync(this.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      return true;
    },
    recordInlineApproval({ root: projectRoot, scope, workflowRequestId, proposal, diff, approved }) {
      if (this.approvalSeen) throw new Error('The Electron E2E adapter permits only one proposal approval.');
      this.approvalSeen = true;
      const canonicalRoot = fs.realpathSync(projectRoot);
      const canonicalScope = path.resolve(canonicalRoot, scope);
      const targets = proposal?.targetFiles;
      if (canonicalRoot !== workspaceRoot
        || canonicalScope !== workspaceRoot
        || !Array.isArray(targets)
        || targets.length === 0
        || targets.length > 32
        || typeof proposal?.manifestHash !== 'string'
        || !/^[a-f0-9]{64}$/i.test(proposal.manifestHash)
        || typeof diff !== 'string'
        || !diff.trim()
        || typeof approved !== 'boolean') {
        throw new Error('Inline E2E approval evidence rejected a proposal outside the isolated workspace contract.');
      }
      const files = targets.map((target) => {
        if (typeof target !== 'string' || !target.trim()) {
          throw new Error('Inline E2E proposal contains an invalid target path.');
        }
        const absolute = path.resolve(canonicalRoot, target);
        if (!containedBy(canonicalRoot, absolute) || absolute === canonicalRoot || fs.existsSync(absolute)) {
          throw new Error('Inline E2E proposal target escapes the empty workspace or already exists.');
        }
        return path.relative(canonicalRoot, absolute);
      });
      const evidence = {
        status: approved ? 'TEST_APPROVED' : 'TEST_REJECTED',
        decision: approved ? 'APPROVE' : 'REJECT',
        workflowRequestId,
        projectRoot: canonicalRoot,
        scope: '.',
        taskId: proposal.taskId,
        manifestHash: proposal.manifestHash,
        files,
        diffSha256: require('node:crypto').createHash('sha256').update(diff).digest('hex'),
      };
      fs.writeFileSync(this.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      return evidence;
    },
    recordWorkflowResult(workflowRequestId, result) {
      if (this.resultSeen || typeof workflowRequestId !== 'string' || !result || typeof result !== 'object') {
        throw new Error('Electron E2E result recorder received an invalid or repeated workflow result.');
      }
      this.resultSeen = true;
      const summary = {
        workflowRequestId,
        outcome: result.outcome || null,
        codeApplied: result.codeApplied === true,
        codeVerified: result.codeVerified === true,
        filesModified: Array.isArray(result.filesModified) ? result.filesModified : [],
        phase: result.phase || null,
        error: result.error || null,
      };
      fs.writeFileSync(this.resultPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
      return summary;
    },
  };
}

module.exports = { loadElectronE2eTestMode };
