import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(fileURLToPath(new URL('../server', import.meta.url)));
const server = spawn(process.env.PYTHON || 'python', ['src/index.py'], {
  cwd: serverRoot,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, AI_CODING_BROWSER_ACCESS: '1' },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.once('exit', () => { process.exitCode = 0; });
    server.kill(signal);
  });
}

server.once('error', (error) => {
  console.error(`Could not start the development backend: ${error.message}`);
  process.exitCode = 1;
});
server.once('exit', (code, signal) => {
  if (!signal) process.exitCode = code ?? 1;
});
