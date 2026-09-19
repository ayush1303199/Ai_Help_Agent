import { spawn } from 'node:child_process';
import path from 'node:path';

const scripts = [
  'developer-agent-test.mjs',
  'developer-gates-test.mjs',
  'developer-lifecycle-test.mjs',
  'developer-runtime-state-test.mjs',
  'assistant-smoke-test.mjs',
  'overlay-static-test.mjs',
  'general-agent-runtime-test.mjs',
  'general-agent-capability-test.mjs',
  'general-agent-food-research-test.mjs',
  'general-agent-benchmark.mjs',
  'general-agent-execution-test.mjs',
  'general-agent-execution-integration-test.mjs',
  'general-agent-electron-browser-test.mjs',
  'gemini-protocol-test.mjs',
  'phase8-protocol-test.mjs',
];

for (const script of scripts) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', script)], {
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
