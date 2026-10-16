import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sensitiveEnvironmentVariable = /(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SECRET|PASSWORD|TOKEN|CREDENTIALS?)(?:$|[_-])/i;

async function reserveLocalPorts(count, excludedPorts) {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < count) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
      const { port } = server.address();
      if (excludedPorts.has(port)) continue;
      excludedPorts.add(port);
      ports.push(port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
  }
}

async function waitForBackendServer(url, child, expectedInstanceId, timeoutMs = 20000) {
  const startedAt = Date.now();
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Isolated test backend exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode}).`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      const health = res.ok ? await res.json() : null;
      if (health?.testInstanceId === expectedInstanceId) {
        return true;
      }
    } catch {
      // server is still starting; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function waitForChildClose(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

const scripts = [
  'architecture-boundary-test.mjs',
  'runtime-settings-test.mjs',
  'developer-pipeline-contract-test.mjs',
  'developer-agent-test.mjs',
  'developer-project-discovery-test.mjs',
  'developer-gates-test.mjs',
  'developer-lifecycle-test.mjs',
  'coding-diff-test.mjs',
  'coding-activity-trace-test.mjs',
  'coding-agent-policy-test.py',
  'developer-runtime-state-test.mjs',
  'coding-acceptance-preflight-test.mjs',
  'coding-sync-contract-test.mjs',
  'coding-repair-runtime-test.mjs',
  'developer-repair-ipc-integration-test.mjs',
  'coding-real-world-e2e-test.mjs',
  'coding-intelligence-acceptance-test.mjs',
  'coding-performance-investigation-test.mjs',
  'assistant-smoke-test.mjs',
  'document-service-test.mjs',
  'stt-service-test.mjs',
  'interview-context-test.mjs',
  'context-dialog-test.mjs',
  'configuration-ui-test.mjs',
  'provider-config-test.mjs',
  'overlay-static-test.mjs',
  'meeting-overlay-protocol-test.mjs',
  'meeting-audio-quality-test.mjs',
  'meeting-capture-lifecycle-test.mjs',
  'meeting-ui-integration-test.mjs',
  'meeting-transport-test.mjs',
  'general-agent-runtime-test.mjs',
  'general-agent-capability-test.mjs',
  'general-agent-food-research-test.mjs',
  'general-agent-benchmark.mjs',
  'general-agent-execution-test.mjs',
  'general-agent-execution-integration-test.mjs',
  'general-agent-electron-browser-test.mjs',
];
const integrationScripts = [
  'coding-real-world-e2e-test.mjs',
  'coding-performance-investigation-test.mjs',
];
const scriptsToRun = process.argv.includes('--integration-only')
  ? integrationScripts
  : scripts;

const testStateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-test-backend-'));
const backendInstanceId = randomUUID();
let backendChild = null;
let backendClosed = null;
let testFailure = null;
function recordTestFailure(error) {
  testFailure = testFailure
    ? new AggregateError([testFailure, error], 'Test execution and cleanup both failed.')
    : error;
}
try {
  const [httpPort, websocketPort, codingWebsocketPort] = await reserveLocalPorts(
    3,
    new Set([3001, 3002, 3003]),
  );
  const backendBaseUrl = `http://127.0.0.1:${httpPort}`;
  const testEnvironment = { ...process.env };
  for (const name of Object.keys(testEnvironment)) {
    if (sensitiveEnvironmentVariable.test(name)) {
      delete testEnvironment[name];
    }
  }
  delete testEnvironment.AI_CODING_AUTH_TOKEN;
  delete testEnvironment.AI_CODING_MUTATION_HANDSHAKE_SECRET;
  delete testEnvironment.AI_HELP_AGENT_TEST_INSTANCE_ID;
  for (const name of [
    'PORT',
    'WS_PORT',
    'CODING_WS_PORT',
    'AI_PROVIDER_CONFIG_PATH',
    'AI_HELP_AGENT_CODING_PROJECT_ROOTS',
  ]) {
    delete testEnvironment[name];
  }
  testEnvironment.AI_PROVIDER_CONFIG_PATH = path.join(testStateDirectory, 'unit-provider-config.json');
  testEnvironment.AI_HELP_AGENT_TEST_BACKEND_URL = backendBaseUrl;
  testEnvironment.PYTHON_DOTENV_DISABLED = '1';

  const backendEnvironment = { ...process.env };
  for (const name of Object.keys(backendEnvironment)) {
    if (sensitiveEnvironmentVariable.test(name)) {
      delete backendEnvironment[name];
    }
  }
  delete backendEnvironment.AI_CODING_AUTH_TOKEN;
  delete backendEnvironment.AI_CODING_MUTATION_HANDSHAKE_SECRET;
  Object.assign(backendEnvironment, {
    PORT: String(httpPort),
    WS_PORT: String(websocketPort),
    CODING_WS_PORT: String(codingWebsocketPort),
    AI_PROVIDER_CONFIG_PATH: path.join(testStateDirectory, 'provider-config.json'),
    AI_HELP_AGENT_TEST_BACKEND_URL: backendBaseUrl,
    AI_HELP_AGENT_TEST_INSTANCE_ID: backendInstanceId,
    PYTHON_DOTENV_DISABLED: '1',
    PYTHONUNBUFFERED: '1',
  });
  backendEnvironment.AI_HELP_AGENT_CODING_PROJECT_ROOTS = '';

  console.log(`Starting isolated test backend at ${backendBaseUrl} with temporary state.`);
  backendChild = spawn('python', ['server/src/index.py'], {
    stdio: 'inherit',
    windowsHide: true,
    env: backendEnvironment,
  });
  backendClosed = waitForChildClose(backendChild);
  const started = await waitForBackendServer(
    `${backendBaseUrl}/api/health`,
    backendChild,
    backendInstanceId,
  );
  if (!started) {
    throw new Error(`Isolated test backend failed to start at ${backendBaseUrl}.`);
  }

  const backendResult = await new Promise((resolve) => {
    const child = spawn('python', ['scripts/backend-services-test.py'], {
      stdio: 'inherit',
      windowsHide: true,
      env: testEnvironment,
    });
    child.on('error', (error) => resolve({ code: 1, error }));
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });

  if (backendResult.code !== 0) {
    throw new Error(`Test failed: backend-services-test.py (exit ${backendResult.code}).`);
  }

  for (const script of scriptsToRun) {
    const isPythonTest = script.endsWith('.py');
    const args = isPythonTest
      ? [path.join('scripts', script)]
      : [
          'coding-diff-test.mjs',
          'coding-activity-trace-test.mjs',
          'provider-config-test.mjs',
          'meeting-overlay-protocol-test.mjs',
          'meeting-audio-quality-test.mjs',
          'meeting-capture-lifecycle-test.mjs',
          'meeting-transport-test.mjs',
        ].includes(script)
        ? ['--experimental-strip-types', path.join('scripts', script)]
        : [path.join('scripts', script)];
    const result = await new Promise((resolve) => {
      const child = spawn(isPythonTest ? 'python' : process.execPath, args, {
        stdio: 'inherit',
        windowsHide: true,
        env: testEnvironment,
      });
      child.on('error', (error) => resolve({ code: 1, error }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });
    if (result.code !== 0) {
      throw new Error(`Test failed: ${script} (exit ${result.code}).`);
    }
  }
} catch (error) {
  testFailure = error;
} finally {
  if (backendChild && (backendChild.exitCode !== null || backendChild.signalCode !== null)) {
    recordTestFailure(new Error(
      `Isolated test backend exited before harness shutdown (code=${backendChild.exitCode}, signal=${backendChild.signalCode}).`,
    ));
  } else if (backendChild) {
    backendChild.kill('SIGTERM');
    let closeResult = await Promise.race([
      backendClosed,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!closeResult) {
      backendChild.kill('SIGKILL');
      closeResult = await Promise.race([
        backendClosed,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!closeResult) {
        recordTestFailure(new Error('Isolated test backend did not exit after termination.'));
      }
    }
    if (closeResult && !closeResult.error) {
      console.log(`Isolated test backend exited (code=${closeResult.code}, signal=${closeResult.signal}).`);
    }
  }
  try {
    await fs.rm(testStateDirectory, { recursive: true, force: true });
    await fs.access(testStateDirectory);
    recordTestFailure(new Error(`Isolated backend state still exists at ${testStateDirectory}.`));
  } catch (cleanupError) {
    if (cleanupError.code !== 'ENOENT') {
      recordTestFailure(new Error(`Could not clean up isolated backend state at ${testStateDirectory}: ${cleanupError.message}`));
    } else {
      console.log('Isolated backend temporary state removed.');
    }
  }
}

if (testFailure) {
  console.error(testFailure);
  process.exitCode = 1;
}
