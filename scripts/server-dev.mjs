import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(fileURLToPath(new URL('../server', import.meta.url)));
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const codingRuntimeEnvironment = {
  AI_CODING_AUTH_TOKEN: process.env.AI_CODING_AUTH_TOKEN || randomBytes(32).toString('base64url'),
  AI_CODING_MUTATION_HANDSHAKE_SECRET: process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET
    || randomBytes(32).toString('base64url'),
  AI_CODING_BROWSER_ACCESS: '1',
};
const childEnvironment = { ...process.env, ...codingRuntimeEnvironment };
const server = spawn(process.env.PYTHON || 'python', ['src/index.py'], {
  cwd: serverRoot,
  stdio: 'inherit',
  windowsHide: true,
  env: childEnvironment,
});
const brokerHost = process.env.AI_CODING_BROKER_HOST === '0'
  ? null
  : spawn(process.execPath, ['electron/trustedLocalDesktopBrokerHost.cjs'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: childEnvironment,
  });
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (brokerHost && brokerHost.exitCode === null) brokerHost.kill(signal);
  if (server.exitCode === null) server.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

server.once('error', (error) => {
  console.error(`Could not start the development backend: ${error.message}`);
  process.exitCode = 1;
});
server.once('exit', (code, signal) => {
  if (!shuttingDown && brokerHost && brokerHost.exitCode === null) brokerHost.kill('SIGTERM');
  if (!signal) process.exitCode = code ?? 1;
});
brokerHost?.once('error', (error) => {
  console.error(`Could not start the standalone trusted broker host: ${error.message}`);
  shutdown('SIGTERM');
  process.exitCode = 1;
});
brokerHost?.once('exit', (code, signal) => {
  if (!shuttingDown && code !== 0) {
    console.error(`Standalone trusted broker host exited unexpectedly (code=${code}, signal=${signal || 'none'}).`);
    shutdown('SIGTERM');
    process.exitCode = code ?? 1;
  }
});
