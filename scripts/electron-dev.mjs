import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function start(command, args) {
  const child = process.platform === 'win32' && /\.cmd$/i.test(command)
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], { cwd: root, stdio: 'inherit', windowsHide: true })
    : spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[DEV] Child exited unexpectedly: ${command} ${args.join(' ')} code=${code} signal=${signal || 'none'}`);
      void shutdown(code || 1);
    }
  });
  return child;
}

function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => { request.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${url}`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function waitForTcp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); retry(); });
      socket.setTimeout(500, () => { socket.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`Timed out waiting for TCP port ${port}`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.slice().reverse()) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 750).unref();
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  start(npmCommand, ['run', 'server:dev']);
  start(process.platform === 'win32' ? 'vite.cmd' : 'vite', ['--port', '5174', '--strictPort']);
  await Promise.all([
    waitForTcp(5174),
    waitForHttp('http://localhost:3001/api/health'),
    waitForTcp(3002),
  ]);
  const electron = start(process.platform === 'win32' ? 'electron.cmd' : 'electron', ['electron/main.cjs']);
  await new Promise((resolve) => electron.once('exit', (code) => resolve(code || 0)));
  await shutdown(0);
} catch (error) {
  console.error(`[DEV] ${error.message}`);
  await shutdown(1);
}
