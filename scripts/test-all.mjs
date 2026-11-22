import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sensitiveEnvironmentVariable = /(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SECRET|PASSWORD|TOKEN|CREDENTIALS?)(?:$|[_-])/i;
const scriptDirectory = path.join(process.cwd(), 'scripts');
const conventionalTestFilePattern = /(?:-test|_test)\.(?:mjs|py|cjs)$/;
const additionalTestFiles = new Set([
  'test-candidate-portal-query.py',
  'test_acceptance_blockers.cjs',
]);
const fixtureTestId = 'fixture:hello-runtime-order';
const environmentDependentTests = new Set([
  'coding-live-user-journey-test.py',
  'coding-container-runner-test.mjs',
  'coding-electron-e2e-harness-test.mjs',
  'coding-real-world-e2e-test.mjs',
  'docker-provider-adapter-test.mjs',
  'docker-provider-synthetic-regression-test.mjs',
  'general-agent-electron-browser-test.mjs',
  'isolation-provider-verification-test.mjs',
  'isolation-provisioning-workflow-test.mjs',
  'sandbox-execution-test.mjs',
  'coding-verified-isolation-test.mjs',
  'test-candidate-portal-query.py',
]);
const pythonNoBytecodeTests = new Set([
  'coding-investigation-entrypoint-test.py',
  'coding-investigation-budget-test.py',
  'trusted-desktop-broker-backend-test.py',
]);
const electronScenarios = new Set([
  'approve-once',
  'cancel-once',
  'broker-approve-once',
  'broker-cancel-once',
  'broker-recovery-once',
  'inline-approve-once',
  'inline-reject-once',
]);

function parseArguments(args) {
  const selectedTests = [];
  const selectedScenarios = [];
  let integrationOnly = false;
  let listTests = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--integration-only') {
      integrationOnly = true;
    } else if (argument === '--list') {
      listTests = true;
    } else if (argument === '--test' || argument === '--scenario') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === '--test') selectedTests.push(value);
      else selectedScenarios.push(value);
    } else {
      throw new Error(`Unknown test runner argument: ${argument}`);
    }
  }
  if (integrationOnly && (selectedTests.length || selectedScenarios.length)) {
    throw new Error('--integration-only cannot be combined with --test or --scenario.');
  }
  if (listTests && (integrationOnly || selectedTests.length || selectedScenarios.length)) {
    throw new Error('--list cannot be combined with execution options.');
  }
  if (selectedTests.length && selectedScenarios.length) {
    throw new Error('--test and --scenario cannot be combined.');
  }
  return { integrationOnly, listTests, selectedTests, selectedScenarios };
}

const { integrationOnly, listTests, selectedTests, selectedScenarios } = parseArguments(process.argv.slice(2));

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

async function waitForBackendServer(url, child, expectedInstanceId, timeoutMs = 60000) {
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
  'trusted-local-desktop-broker-test.mjs',
  'trusted-desktop-broker-backend-test.py',
  'trusted-local-desktop-broker-host-test.mjs',
  'coding-browser-broker-approval-test.mjs',
  'antigravity-terminal-runner-test.mjs',
  'coding-route-reachability-test.mjs',
  'coding-electron-e2e-harness-test.mjs',
  'inline-workflow-approval-test.mjs',
  'runtime-settings-test.mjs',
  'developer-pipeline-contract-test.mjs',
  'developer-agent-test.mjs',
  'developer-project-discovery-test.mjs',
  'coding-investigation-workflow-test.mjs',
  'work-item-verification-contract-test.mjs',
  'coding-autonomous-workflow-integration-test.mjs',
  'coding-investigation-entrypoint-test.py',
  'coding-investigation-budget-test.py',
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
const availableTestFiles = (await fs.readdir(scriptDirectory))
  .filter((name) => (conventionalTestFilePattern.test(name) || additionalTestFiles.has(name)) && name !== 'test-all.mjs')
  .sort();
const defaultTestFiles = new Set([...scripts, 'backend-services-test.py']);
const testCatalog = new Set([...availableTestFiles, 'general-agent-benchmark.mjs', fixtureTestId]);

if (listTests) {
  for (const name of availableTestFiles) {
    const category = defaultTestFiles.has(name) ? 'default' : 'selectable';
    const environment = environmentDependentTests.has(name) ? 'environment-dependent' : 'local';
    console.log(`${category}\t${environment}\t${name}`);
  }
  console.log(`default\tlocal\tgeneral-agent-benchmark.mjs`);
  console.log(`default\tlocal\t${fixtureTestId}`);
  for (const scenario of electronScenarios) {
    console.log(`selectable\tenvironment-dependent\tscenario:${scenario}`);
  }
  process.exit(0);
}

for (const name of selectedTests) {
  if (!availableTestFiles.includes(name) && name !== 'general-agent-benchmark.mjs' && name !== fixtureTestId) {
    throw new Error(`Unknown test file: ${name}`);
  }
}
for (const scenario of selectedScenarios) {
  if (!electronScenarios.has(scenario)) {
    throw new Error(`Unknown Electron test scenario: ${scenario}`);
  }
}
const selectedScriptFiles = selectedTests.filter((name) => name !== fixtureTestId);
const shouldRunFixtureTest = selectedTests.includes(fixtureTestId) || (!selectedTests.length && !selectedScenarios.length && !integrationOnly);
const scriptsToRun = selectedTests.length
  ? selectedScriptFiles
  : selectedScenarios.length
    ? []
    : integrationOnly
      ? integrationScripts
      : scripts;
const scheduledTests = new Set(selectedTests.length
  ? selectedTests
  : selectedScenarios.length
    ? []
    : integrationOnly
      ? [...integrationScripts, 'backend-services-test.py']
      : [...scripts, 'backend-services-test.py', fixtureTestId]);
const testRunSummary = { executed: 0, passed: 0, failed: 0 };

const testStateDirectory = selectedTests.length || selectedScenarios.length
  ? null
  : await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-test-backend-'));
const backendInstanceId = randomUUID();
let backendChild = null;
let backendClosed = null;
let activeSuiteChild = null;
let testFailure = null;

function stopActiveChildren(signal) {
  if (activeSuiteChild && activeSuiteChild.exitCode === null && activeSuiteChild.signalCode === null) {
    activeSuiteChild.kill(signal);
  }
  if (backendChild && backendChild.exitCode === null && backendChild.signalCode === null) {
    backendChild.kill(signal);
  }
}

const handleInterrupt = () => stopActiveChildren('SIGTERM');
process.on('SIGINT', handleInterrupt);
process.on('SIGTERM', handleInterrupt);

function runChildProcess(command, args, options) {
  if (activeSuiteChild) {
    return Promise.reject(new Error('A previous test process has not closed.'));
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    activeSuiteChild = child;
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      if (activeSuiteChild === child) activeSuiteChild = null;
      const result = { code: code ?? 1, signal, error: spawnError };
      testRunSummary.executed += 1;
      if (result.code === 0 && !result.error) testRunSummary.passed += 1;
      else testRunSummary.failed += 1;
      resolve(result);
    });
  });
}

function recordTestFailure(error) {
  testFailure = testFailure
    ? new AggregateError([testFailure, error], 'Test execution and cleanup both failed.')
    : error;
}
try {
  const testEnvironment = { ...process.env };
  if (!selectedTests.length && !selectedScenarios.length) {
    const [httpPort, websocketPort, codingWebsocketPort] = await reserveLocalPorts(
      3,
      new Set([3001, 3002, 3003]),
    );
    const backendBaseUrl = `http://127.0.0.1:${httpPort}`;
    const codingAuthToken = randomUUID();
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
    testEnvironment.AI_CODING_AUTH_TOKEN = codingAuthToken;

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
      AI_CODING_AUTH_TOKEN: codingAuthToken,
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

    const backendResult = await runChildProcess('python', ['scripts/backend-services-test.py'], {
      stdio: 'inherit',
      windowsHide: true,
      env: testEnvironment,
    });

    if (backendResult.code !== 0) {
      throw new Error(`Test failed: backend-services-test.py (exit ${backendResult.code})${backendResult.signal ? `, signal ${backendResult.signal}` : ''}.${backendResult.error ? ` ${backendResult.error.message}` : ''}`);
    }
  }

  for (const script of scriptsToRun) {
    const isPythonTest = script.endsWith('.py');
    const args = isPythonTest
      ? [...(selectedTests.length && pythonNoBytecodeTests.has(script) ? ['-B'] : []), path.join('scripts', script)]
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
    const result = await runChildProcess(isPythonTest ? 'python' : process.execPath, args, {
        stdio: 'inherit',
        windowsHide: true,
        env: testEnvironment,
      });
    if (result.code !== 0) {
      throw new Error(`Test failed: ${script} (exit ${result.code})${result.signal ? `, signal ${result.signal}` : ''}.${result.error ? ` ${result.error.message}` : ''}`);
    }
  }
  if (shouldRunFixtureTest) {
    const fixtureDirectory = path.join(scriptDirectory, 'fixtures', 'hello-runtime-workspace');
    const result = await runChildProcess(process.execPath, ['tests/order.test.js'], {
      cwd: fixtureDirectory,
      stdio: 'inherit',
      windowsHide: true,
      env: selectedTests.length ? process.env : testEnvironment,
    });
    if (result.code !== 0) {
      throw new Error(`Test failed: ${fixtureTestId} (exit ${result.code})${result.signal ? `, signal ${result.signal}` : ''}.${result.error ? ` ${result.error.message}` : ''}`);
    }
  }
  for (const scenario of selectedScenarios) {
    const result = await runChildProcess('electron', ['scripts/coding-electron-e2e.mjs', scenario], {
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
    });
    if (result.code !== 0) {
      throw new Error(`Test failed: Electron scenario ${scenario} (exit ${result.code})${result.signal ? `, signal ${result.signal}` : ''}.${result.error ? ` ${result.error.message}` : ''}`);
    }
  }
} catch (error) {
  testFailure = error;
} finally {
  process.off('SIGINT', handleInterrupt);
  process.off('SIGTERM', handleInterrupt);
  if (activeSuiteChild && activeSuiteChild.exitCode === null && activeSuiteChild.signalCode === null) {
    activeSuiteChild.kill('SIGTERM');
    const suiteCloseResult = await Promise.race([
      waitForChildClose(activeSuiteChild),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!suiteCloseResult) {
      activeSuiteChild.kill('SIGKILL');
      await Promise.race([
        waitForChildClose(activeSuiteChild),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
    }
  }
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
  if (testStateDirectory) {
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
}

if (testFailure) {
  console.error(testFailure);
  process.exitCode = 1;
}
const notScheduledCount = [...testCatalog].filter((name) => !scheduledTests.has(name)).length;
console.log(
  `Test runner summary: ${testRunSummary.passed}/${testRunSummary.executed} test commands passed; `
  + `${testRunSummary.failed} failed; ${notScheduledCount} catalogued test modules not selected.`,
);
