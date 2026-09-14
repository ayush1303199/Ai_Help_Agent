import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ports = [5174, 3001, 3002];
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const normalizedRoot = normalize(projectRoot);

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function isProjectProcess(processInfo) {
  const command = normalize(processInfo.commandLine);
  const cwd = normalize(processInfo.cwd);
  return (command.includes(normalizedRoot) || cwd.includes(normalizedRoot))
    && /(node|electron|vite|npm|npx)/i.test(processInfo.commandLine || '');
}

async function listeningPids(port) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
    return [...new Set(stdout.split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 5
        && parts[0].toUpperCase() === 'TCP'
        && parts[1].endsWith(`:${port}`)
        && parts[3].toUpperCase() === 'LISTENING')
      .map((parts) => Number(parts[4]))
      .filter(Number.isInteger))];
  }

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP', '-a', '-iTCP', `:${port}`, '-sTCP:LISTEN', '-Fpc',
    ]);
    return stdout.split(/\r?\n/)
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)))
      .filter(Number.isInteger);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // `ss` is available on most minimal Linux installations where lsof is not.
    const { stdout } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`]);
    return [...new Set([...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))];
  }
}

async function processInfo(pid) {
  if (process.platform === 'win32') {
    const command = [
      '$items = @()',
      '$current = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"',
      '$depth = 0',
      'while ($current -and $depth -lt 4) {',
      '$items += $current',
      '$current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $current.ParentProcessId)',
      '$depth++',
      '}',
      '$items | Select-Object ProcessId,Name,CommandLine,ExecutablePath,ParentProcessId | ConvertTo-Json -Compress',
    ].join('; ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', command,
      ], { windowsHide: true });
      const value = stdout.trim() ? JSON.parse(stdout) : null;
      const values = Array.isArray(value) ? value : value ? [value] : [];
      return values.length > 0 && {
        pid,
        commandLine: values.map((item) => `${item.Name || ''} ${item.CommandLine || ''} ${item.ExecutablePath || ''}`).join(' '),
        cwd: '',
      };
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]);
    let cwd = '';
    try {
      cwd = (await execFileAsync('readlink', [`/proc/${pid}/cwd`])).stdout.trim();
    } catch {
      // macOS does not expose /proc; command-line matching remains conservative.
    }
    return { pid, commandLine: stdout.trim(), cwd };
  } catch {
    return null;
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function stopOwnedProcess(info) {
  if (!info || info.pid === process.pid || !isProjectProcess(info)) return false;
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      process.kill(info.pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(info.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  return true;
}

async function preflight() {
  const unknown = [];
  for (const port of ports) {
    const pids = await listeningPids(port);
    for (const pid of pids) {
      const info = await processInfo(pid);
      if (!info || !isProjectProcess(info)) {
        unknown.push({ port, pid, command: info?.commandLine || 'unavailable' });
        continue;
      }
      console.log(`Stopping stale project process ${pid} on port ${port}.`);
      await stopOwnedProcess(info);
    }
  }

  if (unknown.length) {
    for (const conflict of unknown) {
      console.error(`Port ${conflict.port} is in use by an unknown process (PID ${conflict.pid}).`);
      console.error(`Refusing to stop it: ${conflict.command}`);
    }
    throw new Error('Launcher preflight failed because one or more ports are owned by unknown processes.');
  }

  for (const port of ports) {
    if (await portOpen(port)) {
      throw new Error(`Port ${port} is still occupied after stopping project processes.`);
    }
  }
}

if (process.argv[1] && normalize(fileURLToPath(import.meta.url)) === normalize(path.resolve(process.argv[1]))) {
  preflight().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { preflight, isProjectProcess };
