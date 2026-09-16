import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const viteCommand = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'vite.cmd')
  : path.join(root, 'node_modules', '.bin', 'vite');
const electronCommand = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'electron.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron');
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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', () => setTimeout(resolve, 250));
      killer.once('error', () => setTimeout(resolve, 250));
    });
    return;
  }

  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
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
  const hosts = ['localhost', '127.0.0.1', '::1'];
  let attemptIndex = 0;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const host = hosts[attemptIndex % hosts.length];
      attemptIndex += 1;
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for TCP port ${port} on ${host}`));
          return;
        }
        setTimeout(attempt, 250);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for TCP port ${port} on ${host}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };

    const start = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for TCP port ${port}`));
        return;
      }
      attempt();
    };

    start();
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.slice().reverse()) {
    await stopChild(child);
  }
  setTimeout(() => process.exit(code), 750).unref();
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  start(npmCommand, ['run', 'server:dev']);
  start(viteCommand, ['--port', '5174', '--strictPort']);
  await Promise.all([
    waitForTcp(5174),
    waitForHttp('http://localhost:3001/api/health'),
    waitForTcp(3002),
  ]);
  const electron = start(electronCommand, ['electron/main.cjs']);
  await new Promise((resolve) => electron.once('exit', (code) => resolve(code || 0)));
  await shutdown(0);
} catch (error) {
  console.error(`[DEV] ${error.message}`);
  await shutdown(1);
}
