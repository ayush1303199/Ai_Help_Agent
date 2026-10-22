import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIntegrationReachability } from '../electron/coding-pipeline/modularArchitectureEngine.cjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scenario = process.argv[2] || 'approve-once';
assert.ok(
  ['approve-once', 'cancel-once', 'broker-approve-once', 'broker-cancel-once', 'broker-recovery-once', 'inline-approve-once', 'inline-reject-once'].includes(scenario),
  'Use approve-once, cancel-once, broker-approve-once, broker-cancel-once, broker-recovery-once, inline-approve-once, or inline-reject-once.',
);
const isBrokerScenario = scenario.startsWith('broker-');
const isInlineScenario = scenario.startsWith('inline-');
const isInlineRejection = isInlineScenario && (scenario.includes('reject') || scenario.includes('cancel'));
const approvalScenario = scenario.includes('cancel') || scenario.includes('reject') ? 'cancel-once' : 'approve-once';
const ownerToken = randomBytes(32).toString('hex');
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coding-electron-e2e-'));
const workspaceRoot = path.join(testRoot, 'workspace');
const userDataDirectory = path.join(testRoot, 'user-data');
const ownerFile = path.join(testRoot, '.ai-coding-electron-e2e-owner');
const evidencePath = path.join(testRoot, 'workflow-evidence.json');
const children = [];
const outputs = [];
let cleanupComplete = false;

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function reservePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const candidate = await reservePort();
    if (!ports.includes(candidate)) ports.push(candidate);
  }
  return ports;
}

function startProcess(label, executable, args, options) {
  const child = spawn(executable, args, {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  const chunks = [];
  const capture = (chunk) => {
    chunks.push(chunk.toString());
    if (chunks.join('').length > 30000) chunks.splice(0, chunks.length - 1);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', (error) => outputs.push({ label, code: null, signal: null, tail: error.message }));
  child.once('exit', (code, signal) => {
    outputs.push({ label, code, signal, tail: chunks.join('').slice(-5000) });
  });
  children.push({ label, child });
  return child;
}

async function waitFor(predicate, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    if (children.some(({ child }) => child.exitCode !== null)) {
      const exited = children
        .filter(({ child }) => child.exitCode !== null)
        .map(({ label: childLabel, child }) => `${childLabel}: ${child.exitCode}`);
      throw new Error(`${label} stopped while waiting (${exited.join(', ')}).`, { cause: lastError || undefined });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for ${label}.${lastError ? ` Last observed error: ${lastError.message}` : ''}`,
    { cause: lastError || undefined },
  );
}

async function stopOwnedProcess({ label, child }) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not exit after SIGTERM.`)), 10000)),
    ]);
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} could not be stopped safely.`)), 5000)),
      ]);
    } else if (!String(error?.message || '').includes('did not exit after SIGTERM')) {
      throw error;
    }
  }
}

async function readWorkflowResult() {
  try {
    return JSON.parse(await fs.readFile(path.join(testRoot, 'workflow-result.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

class DevToolsConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.sequence = 0;
    this.pending = new Map();
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async connect() {
    await Promise.race([
      once(this.socket, 'open'),
      once(this.socket, 'error').then(([error]) => Promise.reject(error)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out connecting to Electron DevTools.')), 10000)),
    ]);
  }

  command(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function findRendererTarget(debugPort, devPort) {
  const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
  return targets.find((target) => target.type === 'page'
    && target.url?.startsWith(`http://127.0.0.1:${devPort}/`));
}

async function readApprovalEvidence() {
  try {
    return JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function run() {
  await Promise.all([
    fs.mkdir(workspaceRoot),
    fs.mkdir(userDataDirectory),
  ]);
  await fs.writeFile(ownerFile, ownerToken, { flag: 'wx' });

  const [httpPort, wsPort, codingWsPort, devPort, debugPort] = await reservePorts(5);
  const baseSettings = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'src', 'config', 'runtimeSettings.json'), 'utf8'));
  const testSettings = {
    ...baseSettings,
    services: {
      ...baseSettings.services,
      http: { host: '127.0.0.1', port: httpPort, baseUrl: `http://127.0.0.1:${httpPort}` },
      websocket: { host: '127.0.0.1', port: wsPort, baseUrl: `ws://127.0.0.1:${wsPort}` },
      codingWebsocket: { host: '127.0.0.1', port: codingWsPort, baseUrl: `ws://127.0.0.1:${codingWsPort}` },
      devServer: { ...baseSettings.services.devServer, host: '127.0.0.1', port: devPort },
    },
  };
  const settingsPath = path.join(testRoot, 'runtimeSettings.json');
  await fs.writeFile(settingsPath, `${JSON.stringify(testSettings, null, 2)}\n`, { flag: 'wx' });
  const providerConfigPath = path.join(testRoot, 'provider-config.json');
  await fs.writeFile(providerConfigPath, '{"providers":[]}\n', { flag: 'wx' });
  const authToken = randomBytes(32).toString('base64url');
  const mutationSecret = randomBytes(32).toString('base64url');
  const commonEnvironment = {
    AI_CODING_E2E_TEST_MODE: '1',
    AI_CODING_E2E_ROOT: testRoot,
    AI_CODING_E2E_TOKEN: ownerToken,
    AI_CODING_E2E_SETTINGS_PATH: settingsPath,
    AI_CODING_E2E_USER_DATA: userDataDirectory,
    AI_CODING_E2E_WORKSPACE: workspaceRoot,
    AI_CODING_E2E_APPROVAL: approvalScenario,
    ...(isInlineScenario ? { AI_CODING_E2E_INLINE_APPROVAL: '1' } : {}),
    AI_RUNTIME_SETTINGS_PATH: settingsPath,
    AI_PROVIDER_CONFIG_PATH: providerConfigPath,
    AI_CODING_AUTH_TOKEN: authToken,
    AI_CODING_MUTATION_HANDSHAKE_SECRET: mutationSecret,
    AI_CODING_BROWSER_ACCESS: '1',
  };
  const apiUrl = `http://127.0.0.1:${httpPort}`;
  const wsUrl = `ws://127.0.0.1:${wsPort}`;
  const codingWsUrl = `ws://127.0.0.1:${codingWsPort}`;
  const devServerUrl = `http://127.0.0.1:${devPort}`;

  startProcess('backend', process.env.PYTHON || 'python', ['-B', 'src/index.py'], {
    cwd: path.join(repositoryRoot, 'server'),
    env: { ...process.env, ...commonEnvironment, PORT: String(httpPort), WS_PORT: String(wsPort), CODING_WS_PORT: String(codingWsPort) },
  });
  await waitFor(async () => {
    const health = await getJson(`${apiUrl}/api/health`);
    return health && { configured: health.configured, provider: health.provider || null };
  }, 'isolated backend health');

  const vitePath = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  startProcess('vite', process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'], {
    env: {
      ...process.env,
      ...commonEnvironment,
      VITE_API_URL: apiUrl,
      VITE_WS_URL: wsUrl,
      VITE_CODING_WS_URL: codingWsUrl,
      VITE_DEV_SERVER_PORT: String(devPort),
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  });
  await waitFor(async () => {
    const response = await fetch(devServerUrl, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 'isolated Vite renderer');

  const electronPath = path.join(repositoryRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const electron = startProcess('electron', electronPath, [
    `--user-data-dir=${userDataDirectory}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-gpu',
    'electron/main.cjs',
  ], {
    env: {
      ...process.env,
      ...commonEnvironment,
      ELECTRON_DEV_URL: devServerUrl,
    },
  });

  const target = await waitFor(() => findRendererTarget(debugPort, devPort), 'Electron renderer target');
  const devTools = new DevToolsConnection(target.webSocketDebuggerUrl);
  await devTools.connect();
  await devTools.command('Runtime.enable');
  const bridge = await waitFor(async () => {
    const result = await devTools.evaluate(`({
      electronAPI: typeof window.electronAPI,
      executeDeveloperWorkflow: typeof window.electronAPI?.executeDeveloperWorkflow,
      attachDeveloperProject: typeof window.electronAPI?.attachDeveloperProject,
      cancelDeveloperWorkflow: typeof window.electronAPI?.cancelDeveloperWorkflow,
      href: location.href
    })`);
    return result?.electronAPI === 'object'
      && result.executeDeveloperWorkflow === 'function'
      && result.attachDeveloperProject === 'function'
      && result.cancelDeveloperWorkflow === 'function'
      ? result
      : null;
  }, 'preload bridge in Electron renderer');
  assert.match(bridge.href, new RegExp(`:${devPort}/`));

  const projectAttachment = await devTools.evaluate(
    `window.electronAPI.attachDeveloperProject(${JSON.stringify(workspaceRoot)})`,
  );
  assert.equal(projectAttachment.status, 'PROJECT_ATTACHED', JSON.stringify(projectAttachment));
  const projectState = await devTools.evaluate('window.electronAPI.getDeveloperProjectState()');
  assert.equal(path.resolve(projectState.projectRoot), workspaceRoot, 'Electron must bind this renderer to the disposable workspace.');

  const prompt = 'Create a small modular software project with a reusable core module, a configuration module, and an entry point that connects them. Provide clean, modular code snippets.';
  if (!isBrokerScenario) {
    try {
      await waitFor(
        () => devTools.evaluate(`document.readyState === 'complete' && document.querySelectorAll('button').length > 0`),
        'Electron renderer UI initialization',
      );
    } catch (error) {
      const rendererState = await devTools.evaluate(`({
        readyState: document.readyState,
        buttonCount: document.querySelectorAll('button').length,
        body: document.body?.innerText?.slice(-2000) || '',
        href: location.href
      })`);
      throw new Error(`${error.message} Renderer state: ${JSON.stringify(rendererState)}. Process output: ${JSON.stringify(outputs)}`);
    }
  }
  let instrumentation = { developerButtonFound: false, buttonLabels: [], bodyText: '' };
  if (isBrokerScenario) {
    const attachment = await devTools.evaluate(`(async () => {
      const { codingFetch } = await import('/src/features/coding/codingTransport.ts');
      const response = await codingFetch(${JSON.stringify(new URL('/api/coding/project-attach', apiUrl))}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot: ${JSON.stringify(workspaceRoot)} }),
      });
      return { status: response.status, payload: await response.json() };
    })()`);
    const attached = attachment.payload;
    assert.equal(attachment.status, 200, JSON.stringify(attached));
    assert.equal(attached.status, 'PROJECT_ATTACHED');
    if (scenario === 'broker-recovery-once') {
      const resetRegistry = await fetch(new URL('/api/coding/broker/register', apiUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Coding-Auth': authToken },
        body: JSON.stringify({
          endpoint: `http://${new URL(apiUrl).hostname}:${await reservePort()}`,
          projects: [],
        }),
      });
      assert.equal(resetRegistry.status, 200, await resetRegistry.text());
    }
    await devTools.evaluate('window.__codingElectronE2E = { activity: [] };');
    const brokerStarted = await devTools.evaluate(`(async () => {
      const { executeTrustedBrokerWorkflow } = await import('/src/features/coding/codingTransport.ts');
      window.__brokerAbortController = new AbortController();
      window.__brokerPendingApproval = null;
      window.__brokerApprovalAction = null;
      window.__brokerWorkflowPromise = executeTrustedBrokerWorkflow(
        ${JSON.stringify(prompt)},
        '.',
        window.__brokerAbortController.signal,
        (approval, actions) => {
          window.__brokerPendingApproval = approval;
          window.__brokerApprovalAction = actions.approve;
        },
      ).then((result) => {
        window.__brokerWorkflowResult = result;
        return result;
      }).catch((error) => {
        window.__brokerWorkflowError = String(error?.message || error);
        throw error;
      });
      window.__brokerWorkflowPromise.catch(() => {});
      return true;
    })()`);
    assert.equal(brokerStarted, true);
  } else {
    const uiSetup = await devTools.evaluate(`(() => {
      window.__codingElectronE2E = { activity: [] };
      window.electronAPI.onDeveloperActivity((event) => window.__codingElectronE2E.activity.push(event));
      const developerButton = [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Developer');
      if (developerButton) developerButton.click();
      return {
        developerButtonFound: Boolean(developerButton),
        buttonLabels: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()).slice(0, 20),
        bodyText: document.body.innerText.slice(0, 1200),
      };
    })()`);
    instrumentation = uiSetup;
    assert.equal(uiSetup.developerButtonFound, true, JSON.stringify(uiSetup));
    await waitFor(async () => devTools.evaluate(
      `Boolean(document.querySelector('textarea[placeholder*="describe a change"]'))`,
    ), 'Coding Agent input');
    const inputFocused = await devTools.evaluate(`(() => {
      const textarea = document.querySelector('textarea[placeholder*="describe a change"]');
      if (!textarea) throw new Error('Coding Agent message input is missing.');
      textarea.focus();
      return document.activeElement === textarea;
    })()`);
    assert.equal(inputFocused, true);
    await devTools.command('Input.insertText', { text: prompt });
    await waitFor(
      () => devTools.evaluate(`[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Send' && !button.disabled)`),
      'enabled Coding Agent Send button',
    );
    const submitted = await devTools.evaluate(`(() => {
      const send = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Send' && !button.disabled);
      if (!send || send.disabled) throw new Error('Coding Agent Send control is unavailable.');
      send.click();
      return { submitted: true };
    })()`);
    assert.equal(submitted.submitted, true);
    await waitFor(
      () => devTools.evaluate(`document.body.innerText.includes(${JSON.stringify(prompt)})`),
      'submitted request rendered in the Coding Agent conversation',
    );
  }

  let approvalEvidence;
  if (isInlineScenario) {
    try {
      await waitFor(
        () => devTools.evaluate(`document.body.innerText.includes('PROPOSED CHANGE') && [...document.querySelectorAll('button')].some((button) => ['Accept & Verify', 'Reject'].includes(button.textContent.trim()))`),
        'inline proposal card and decision actions',
      );
    } catch (error) {
      const state = await devTools.evaluate(`({
        body: document.body.innerText.slice(-2400),
        workflowEvents: window.__codingElectronE2E?.activity || [],
        bridgeDecision: typeof window.electronAPI?.decideDeveloperWorkflowApproval,
        bridgeListener: typeof window.electronAPI?.onDeveloperWorkflowApprovalPending
      })`);
      throw new Error(`${error.message} Inline approval UI state: ${JSON.stringify(state)}.`);
    }
    const decisionLabel = isInlineRejection ? 'Reject' : 'Accept & Verify';
    const clicked = await devTools.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(decisionLabel)});
      if (!button || button.disabled) throw new Error('Inline proposal decision is unavailable.');
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true);
    try {
      approvalEvidence = await waitFor(readApprovalEvidence, 'user decision recorded from the inline proposal card');
    } catch (error) {
      const state = await devTools.evaluate(`({
        body: document.body.innerText.slice(-2400),
        workflowEvents: window.__codingElectronE2E?.activity || [],
        bridgeDecision: typeof window.electronAPI?.decideDeveloperWorkflowApproval
      })`);
      throw new Error(`${error.message} Inline decision state: ${JSON.stringify(state)}.`);
    }
  } else {
    if (isBrokerScenario) {
      const pendingApproval = await waitFor(async () => {
        const state = await devTools.evaluate(`({
          error: window.__brokerWorkflowError || null,
          approval: window.__brokerPendingApproval || null
        })`);
        if (state.error) throw new Error(`Browser broker workflow failed: ${state.error}`);
        return state.approval;
      }, 'browser broker proposal awaiting explicit approval');
      approvalEvidence = {
        scope: '.',
        workflowRequestId: pendingApproval.workflowRequestId,
        projectRoot: workspaceRoot,
        files: pendingApproval.fileOperations.map((file) => file.path),
        status: 'AWAITING_TEST_DECISION',
      };
      assert.ok(approvalEvidence.workflowRequestId, 'The browser proposal must correlate to its broker workflow request.');
      assert.ok(approvalEvidence.files.length > 0, 'The browser proposal must contain at least one file operation.');
    } else {
      approvalEvidence = await waitFor(async () => {
        const evidence = await readApprovalEvidence();
        if (evidence) return evidence;
        return null;
      }, 'proposal reaching the Electron workflow approval boundary');
    }
  }
  assert.equal(approvalEvidence.scope, '.');
  assert.ok(approvalEvidence.workflowRequestId, 'The approved workflow must be correlated to its renderer request.');

  let cancelAccepted = false;
  if (scenario.includes('cancel') && !isInlineScenario) {
    cancelAccepted = isBrokerScenario
      ? await devTools.evaluate(`(() => { window.__brokerAbortController.abort(); return true; })()`)
      : await devTools.evaluate(
        `window.electronAPI.cancelDeveloperWorkflow(${JSON.stringify(approvalEvidence.workflowRequestId)})`,
      );
    assert.equal(cancelAccepted, true, 'The active workflow cancellation path must accept the request.');
  } else if (isInlineRejection) {
    cancelAccepted = approvalEvidence.status === 'TEST_REJECTED';
  } else if (isBrokerScenario) {
    assert.deepEqual(await fs.readdir(workspaceRoot), [], 'Broker proposals must not write files before approval.');
    await devTools.evaluate('window.__brokerApprovalAction(false)');
    approvalEvidence.status = 'TEST_APPROVED';
  }

  const result = await waitFor(readWorkflowResult, 'workflow result recorded by Electron main process', 90000);
  assert.ok(approvalEvidence, 'The isolated approval harness must observe the actual proposal decision.');
  if (isBrokerScenario) {
    assert.equal(
      approvalEvidence.workflowRequestId,
      result.workflowRequestId,
      'The staged browser proposal must match the completed Electron workflow request.',
    );
  }
  assert.equal(approvalEvidence.projectRoot, workspaceRoot);
  assert.ok(approvalEvidence.files.length > 0);

  let fileVerification;
  if (isInlineRejection) {
    assert.equal(approvalEvidence.status, 'TEST_REJECTED');
    assert.equal(result.outcome, 'APPROVAL_REJECTED', JSON.stringify(result));
    assert.equal(result.codeApplied, false);
    assert.deepEqual(await fs.readdir(workspaceRoot), [], 'Inline rejection must leave the disposable workspace empty.');
    fileVerification = { files: [], workspaceEmptyAfterRejection: true };
  } else if (!scenario.includes('cancel')) {
    assert.equal(approvalEvidence.status, 'TEST_APPROVED');
    assert.equal(result.outcome, 'SUCCESS', JSON.stringify(result));
    assert.equal(result.codeApplied, true);
    assert.equal(result.codeVerified, true);
    assert.ok(Array.isArray(result.filesModified) && result.filesModified.length > 0);
    const files = [];
    for (const relativePath of result.filesModified) {
      const absolutePath = path.resolve(workspaceRoot, relativePath);
      const relative = path.relative(workspaceRoot, absolutePath);
      assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
      const content = await fs.readFile(absolutePath, 'utf8');
      assert.ok(content.trim().length > 0, `Created source file ${relative} must be non-empty.`);
      files.push({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
    }
    const reachability = await verifyIntegrationReachability(workspaceRoot, {
      modulesToCreate: result.filesModified.map((filePath) => ({ path: filePath })),
      integrationPoints: [],
    });
    assert.equal(reachability.isValid, true, JSON.stringify(reachability));
    fileVerification = { files, reachability };
  } else {
    assert.equal(cancelAccepted, true);
    assert.equal(result.outcome, 'CANCELLED', JSON.stringify(result));
    assert.equal(result.codeApplied, false);
    assert.deepEqual(await fs.readdir(workspaceRoot), [], 'Cancellation must leave the disposable workspace empty.');
    fileVerification = { files: [], workspaceEmptyAfterCancellation: true };
  }

  const activity = await devTools.evaluate('window.__codingElectronE2E?.activity || []');
  const report = {
    scenario,
    runtime: isBrokerScenario
      ? 'Electron renderer browser-fetch transport + backend broker discovery + local broker + Developer Agent'
      : 'Electron renderer + configured preload + production IPC handler + developer workflow',
    provider: { mode: 'unconfigured; greenfield request must not require a provider response', configured: false },
    bridge,
    projectAttachment: {
      status: projectAttachment.status,
      projectRoot: projectState.projectRoot,
      scope: approvalEvidence.scope,
    },
    ipcDelivery: isBrokerScenario
      ? 'Browser transport reached the trusted local broker, which delegated to the production Developer Agent; broker-to-main-process delegation was observed at the approval boundary.'
      : 'Observed at the Electron main-process workflow approval boundary after a UI submission; bridge method and handler are production code.',
    approval: approvalEvidence,
    workflow: {
      outcome: result.outcome,
      codeApplied: result.codeApplied,
      codeVerified: result.codeVerified,
      filesModified: result.filesModified,
      cancellationAccepted: cancelAccepted,
      activityEvents: activity.map((event) => ({ phase: event.phase || null, message: event.message || null })),
    },
    fileVerification,
    electronPid: electron.pid,
  };
  console.log(JSON.stringify(report, null, 2));
  devTools.close();
}

try {
  await run();
} catch (error) {
  console.error(`Electron E2E failed: ${error.stack || error.message}`);
  for (const output of outputs) {
    console.error(`--- ${output.label} (exit=${output.code}, signal=${output.signal}) ---\n${output.tail}`);
  }
  process.exitCode = 1;
} finally {
  let stopError = null;
  for (const processRecord of [...children].reverse()) {
    try {
      await stopOwnedProcess(processRecord);
    } catch (error) {
      stopError ||= error;
    }
  }
  const ownerTokenOnDisk = await fs.readFile(ownerFile, 'utf8').catch(() => null);
  if (!stopError && ownerTokenOnDisk === ownerToken) {
    await fs.rm(testRoot, { recursive: true, force: false });
    cleanupComplete = true;
  } else {
    console.error(`Owned E2E artifacts were retained for safe inspection at ${testRoot}.`);
    if (stopError) console.error(`Cleanup blocked: ${stopError.message}`);
    else console.error('Cleanup blocked because the test ownership marker changed.');
    process.exitCode = 1;
  }
  console.error(`Electron E2E cleanup: ${cleanupComplete ? 'removed owned temporary root' : 'incomplete; retained owned temporary root'}.`);
}
