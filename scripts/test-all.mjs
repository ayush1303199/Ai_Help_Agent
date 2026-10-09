import { spawn } from 'node:child_process';
import path from 'node:path';

async function waitForBackendServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        return true;
      }
    } catch {
      // server is still starting; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
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

let backendChild = null;
const backendReady = await waitForBackendServer('http://127.0.0.1:3001/api/health');
if (!backendReady) {
  backendChild = spawn('python', ['server/src/index.py'], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const started = await waitForBackendServer('http://127.0.0.1:3001/api/health');
  if (!started) {
    console.error('Backend server failed to start on http://127.0.0.1:3001');
    backendChild.kill();
    process.exit(1);
  }
}

const backendResult = await new Promise((resolve) => {
  const child = spawn('python', ['scripts/backend-services-test.py'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => resolve({ code: 1, error }));
  child.on('close', (code) => resolve({ code: code ?? 1 }));
});

if (backendResult.code !== 0) {
  console.error('Test failed: backend-services-test.py');
  process.exitCode = backendResult.code;
} else {
  for (const script of scripts) {
    const isPythonTest = script.endsWith('.py');
    const result = await new Promise((resolve) => {
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
      const child = spawn(isPythonTest ? 'python' : process.execPath, args, {
        stdio: 'inherit',
        windowsHide: true,
      });
      child.on('error', (error) => resolve({ code: 1, error }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });
    if (result.code !== 0) {
      console.error(`Test failed: ${script}`);
      process.exitCode = result.code;
      break;
    }
  }
}

if (backendChild) {
  backendChild.kill();
}
