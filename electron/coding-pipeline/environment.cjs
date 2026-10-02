/**
 * Environment Intelligence and Dev Server Lifecycle Manager.
 * Zero-hardcoding, dynamically probes available tools, runtimes, and dev servers.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function detectEnvironmentRuntimes() {
  const runtimes = {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    shell: process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh'),
    availableRuntimes: {},
    packageManagers: {},
  };

  const probes = [
    { name: 'python', cmd: 'python', args: ['--version'] },
    { name: 'python3', cmd: 'python3', args: ['--version'] },
    { name: 'node', cmd: 'node', args: ['--version'] },
    { name: 'npm', cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['--version'], isPkg: true },
    { name: 'pnpm', cmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: ['--version'], isPkg: true },
    { name: 'yarn', cmd: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args: ['--version'], isPkg: true },
    { name: 'php', cmd: 'php', args: ['--version'] },
    { name: 'composer', cmd: 'composer', args: ['--version'], isPkg: true },
    { name: 'java', cmd: 'java', args: ['-version'] },
    { name: 'mvn', cmd: process.platform === 'win32' ? 'mvn.cmd' : 'mvn', args: ['--version'] },
    { name: 'gradle', cmd: process.platform === 'win32' ? 'gradle.bat' : 'gradle', args: ['--version'] },
    { name: 'go', cmd: 'go', args: ['version'] },
    { name: 'cargo', cmd: 'cargo', args: ['--version'], isPkg: true },
  ];

  await Promise.all(
    probes.map(async ({ name, cmd, args, isPkg }) => {
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d) => { stdout += d; });
          proc.stderr.on('data', (d) => { stderr += d; });
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve((stdout || stderr).trim().split('\n')[0]);
            else reject(new Error(`Exit code ${code}`));
          });
        });
        if (isPkg) {
          runtimes.packageManagers[name] = out;
        } else {
          runtimes.availableRuntimes[name] = out;
        }
      } catch {
        // Tool not installed, cleanly skipped
      }
    })
  );

  return runtimes;
}

class DevServerManager {
  constructor() {
    this._activeServers = new Map(); // taskId -> { process, port, command, startTime, framework }
  }

  async probeHttpPort(port, host = '127.0.0.1', timeoutMs = 2000) {
    return new Promise((resolve) => {
      const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
        resolve({ active: true, statusCode: res.statusCode, headers: res.headers });
        res.resume();
      });
      req.on('error', () => resolve({ active: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ active: false });
      });
    });
  }

  async discoverDevServerConfig(projectRoot) {
    if (!projectRoot) return { detected: false, reason: 'No project root' };
    const resolvedRoot = path.resolve(projectRoot);

    // 1. Check Node package.json
    try {
      const pkgPath = path.join(resolvedRoot, 'package.json');
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts || {};
      const devScript = ['dev', 'start', 'serve', 'watch'].find((s) => typeof scripts[s] === 'string');

      let defaultPort = 3000;
      let framework = 'node';
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.vite) { framework = 'vite'; defaultPort = 5173; }
      else if (deps.next) { framework = 'next'; defaultPort = 3000; }
      else if (deps['@angular/core']) { framework = 'angular'; defaultPort = 4200; }
      else if (deps.nuxt) { framework = 'nuxt'; defaultPort = 3000; }
      else if (deps.express) { framework = 'express'; defaultPort = 3000; }

      if (devScript) {
        const cmd = scripts[devScript];
        const portMatch = String(cmd).match(/(?:--port|-p)\s+([0-9]+)/);
        const port = portMatch ? parseInt(portMatch[1], 10) : defaultPort;

        return {
          detected: true,
          type: 'node',
          framework,
          scriptName: devScript,
          command: `npm run ${devScript}`,
          port,
          confidence: 'HIGH',
        };
      }
    } catch {}

    // 2. Python Django / Flask / FastAPI
    try {
      const managePy = path.join(resolvedRoot, 'manage.py');
      await fs.stat(managePy);
      return {
        detected: true,
        type: 'python',
        framework: 'django',
        scriptName: 'runserver',
        command: 'python manage.py runserver',
        port: 8000,
        confidence: 'HIGH',
      };
    } catch {}

    try {
      const appPy = path.join(resolvedRoot, 'app.py');
      await fs.stat(appPy);
      return {
        detected: true,
        type: 'python',
        framework: 'flask-fastapi',
        scriptName: 'app.py',
        command: 'python app.py',
        port: 5000,
        confidence: 'MEDIUM',
      };
    } catch {}

    // 3. PHP Laravel
    try {
      const artisan = path.join(resolvedRoot, 'artisan');
      await fs.stat(artisan);
      return {
        detected: true,
        type: 'php',
        framework: 'laravel',
        scriptName: 'serve',
        command: 'php artisan serve',
        port: 8000,
        confidence: 'HIGH',
      };
    } catch {}

    return { detected: false, reason: 'No recognized dev server configuration' };
  }

  async startDevServer(taskId, projectRoot) {
    if (this._activeServers.has(taskId)) {
      return this._activeServers.get(taskId);
    }

    const config = await this.discoverDevServerConfig(projectRoot);
    if (!config.detected) {
      throw new Error(`Cannot start dev server: ${config.reason}`);
    }

    // Check if server is already running on the target port
    const existing = await this.probeHttpPort(config.port);
    if (existing.active) {
      const record = {
        taskId,
        port: config.port,
        reused: true,
        framework: config.framework,
        command: config.command,
        startTime: Date.now(),
        process: null,
      };
      this._activeServers.set(taskId, record);
      return record;
    }

    // Spawn server process
    const isWindows = process.platform === 'win32';
    const shellCmd = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', config.command] : ['-c', config.command];

    const child = spawn(shellCmd, shellArgs, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const record = {
      taskId,
      port: config.port,
      reused: false,
      framework: config.framework,
      command: config.command,
      startTime: Date.now(),
      process: child,
      pid: child.pid,
    };

    child.on('exit', () => {
      this._activeServers.delete(taskId);
    });

    this._activeServers.set(taskId, record);
    return record;
  }

  async stopDevServer(taskId) {
    const record = this._activeServers.get(taskId);
    if (!record) return { stopped: false, reason: 'No server for task' };

    if (record.reused || !record.process) {
      this._activeServers.delete(taskId);
      return { stopped: true, wasReused: true };
    }

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(record.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        record.process.kill('SIGTERM');
      }
    } catch {}

    this._activeServers.delete(taskId);
    return { stopped: true, pid: record.pid };
  }

  getActiveServer(taskId) {
    return this._activeServers.get(taskId) || null;
  }
}

const devServerManager = new DevServerManager();

module.exports = {
  detectEnvironmentRuntimes,
  DevServerManager,
  devServerManager,
};
